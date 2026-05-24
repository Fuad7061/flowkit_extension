/**
 * Flow Kit — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures bearer token, solves reCAPTCHA, proxies API calls through browser.
 */

let ws = null;
let flowKey = null;
let manualDisconnect = false;
let state = 'disconnected'; // disconnected, idle, active
let clientId = null;
let customWsHost = 'ws://127.0.0.1:8100/ws';

// Generate or retrieve unique client ID
chrome.storage.local.get(['clientId', 'wsHost'], (res) => {
  if (res.clientId) {
    clientId = res.clientId;
  } else {
    clientId = crypto.randomUUID();
    chrome.storage.local.set({ clientId });
  }
  if (res.wsHost) {
    customWsHost = res.wsHost;
  }
});

const API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';

let callbackSecret = null;  // Auth secret for HTTP callback, received from server on WS connect
let metrics = {
  tokenCapturedAt: null,
  requestCount: 0,   // captcha-consuming requests only (gen image/video/upscale)
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

// ─── Log Settings ────────────────────────────────────────────
let logSettings = {
  autoClear: true,
  retentionDays: 3,
  maxEntries: 100,
  persistEnabled: true,
};

// Load log settings from storage on startup
chrome.storage.local.get(['logSettings'], (res) => {
  if (res.logSettings) Object.assign(logSettings, res.logSettings);
});

// ─── URL → Log Type Classifier ─────────────────────────────

// Visible log types — only these appear in the request log
const _VISIBLE_TYPES = new Set(['GEN_IMG', 'GEN_VID', 'GEN_VID_REF', 'UPSCALE', 'TRACKING', 'URL_REFRESH']);

function _classifyApiUrl(url) {
  if (url.includes('uploadImage'))                     return 'UPLOAD';
  if (url.includes('batchGenerateImages'))              return 'GEN_IMG';
  if (url.includes('UpsampleVideo'))                   return 'UPSCALE';
  if (url.includes('ReferenceImages'))                 return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo'))          return 'GEN_VID';
  if (url.includes('batchCheckAsync'))                  return 'POLL';
  if (url.includes('upsampleImage'))                   return 'UPS_IMG';
  if (url.includes('/media/'))                         return 'MEDIA';
  if (url.includes('/credits'))                        return 'CREDITS';
  return 'API';
}

// ─── Request Log ────────────────────────────────────────────

let requestLog = [];
let _logSaveTimer = null;

function addRequestLog(entry) {
  // Always set the extension client_id and start time on new entries
  entry.extensionId = clientId;
  entry.startedAt = entry.time || new Date().toISOString();
  requestLog.unshift(entry);
  // Enforce max entries
  if (requestLog.length > logSettings.maxEntries) requestLog.pop();
  broadcastRequestLog();
  scheduleLogSave();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) {
    Object.assign(entry, updates);
    // Calculate duration if not set and we have completion time
    if (!entry.duration && entry.startedAt) {
      const end = new Date().toISOString();
      entry.duration = new Date(end).getTime() - new Date(entry.startedAt).getTime();
    }
  }
  broadcastRequestLog();
  scheduleLogSave();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

function scheduleLogSave() {
  if (!logSettings.persistEnabled) return;
  if (_logSaveTimer) clearTimeout(_logSaveTimer);
  _logSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ requestLog: requestLog.slice(0, logSettings.maxEntries) });
    _logSaveTimer = null;
  }, 300);
}

function clearRequestLog() {
  requestLog = [];
  metrics = { tokenCapturedAt: null, requestCount: 0, successCount: 0, failedCount: 0, lastError: null };
  chrome.storage.local.set({ requestLog: [], metrics });
  broadcastStatus();
  broadcastRequestLog();
}

function deleteLogEntry(id) {
  requestLog = requestLog.filter(e => e.id !== id);
  scheduleLogSave();
  broadcastRequestLog();
}

function cleanupOldLogs() {
  const cutoff = Date.now() - (logSettings.retentionDays * 86400000);
  const before = requestLog.length;
  requestLog = requestLog.filter(e => {
    if (!logSettings.autoClear) return true;
    const t = e.time || e.timestamp || e.startedAt || e.createdAt;
    if (!t) return true; // preserve entries without timestamps
    try { return new Date(t).getTime() > cutoff; } catch { return true; }
  });
  if (requestLog.length > logSettings.maxEntries) {
    requestLog = requestLog.slice(0, logSettings.maxEntries);
  }
  if (requestLog.length !== before) {
    scheduleLogSave();
    broadcastRequestLog();
  }
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'token-refresh') {
    await captureTokenFromFlowTab();
  }
  if (alarm.name === 'log-cleanup') {
    cleanupOldLogs();
  }
});

async function init() {
  const data = await chrome.storage.local.get(['flowKey', 'metrics', 'callbackSecret', 'requestLog', 'logSettings']);
  if (data.flowKey) flowKey = data.flowKey;
  if (data.metrics) Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  if (data.requestLog) requestLog = data.requestLog;
  if (data.logSettings) Object.assign(logSettings, data.logSettings);
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
  chrome.alarms.create('log-cleanup', { periodInMinutes: 60 });
  // Run initial cleanup on startup
  cleanupOldLogs();
}

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });
    console.log('[FlowAgent] Bearer token captured');

    // Notify agent
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

let _openingFlowTab = false;

async function openFlowTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
  });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
    return;
  }
  try {
    await chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow' });
  } catch (e) {
    console.log('[FlowAgent] openFlowTab failed to create tab (no window?), creating new window:', e);
    await chrome.windows.create({ url: 'https://labs.google/fx/tools/flow', state: 'minimized' });
  }
}

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
  });
  if (!tabs.length) {
    if (_openingFlowTab) {
      console.log('[FlowAgent] Flow tab already opening, skipping');
      return;
    }
    _openingFlowTab = true;
    try {
      console.log('[FlowAgent] No Flow tab found — opening one in background');
      try {
        await chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow', active: false });
      } catch (err) {
        console.log('[FlowAgent] Failed to create tab, creating minimized window:', err);
        await chrome.windows.create({ url: 'https://labs.google/fx/tools/flow', state: 'minimized' });
      }
      await new Promise(r => setTimeout(r, 3000));
      const retryTabs = await chrome.tabs.query({
        url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
      });
      if (!retryTabs.length) {
        console.log('[FlowAgent] Flow tab not ready yet after open');
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: retryTabs[0].id },
        files: ['content.js'],
      });
      console.log('[FlowAgent] Token refresh triggered on newly opened Flow tab');
    } catch (e) {
      console.error('[FlowAgent] Token refresh failed after opening tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      files: ['content.js'],
    });
    console.log('[FlowAgent] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[FlowAgent] Token refresh failed:', e);
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    const wsUrl = customWsHost;
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error('[FlowAgent] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[FlowAgent] Connected to agent');
    
    // Send client ID immediately
    ws.send(JSON.stringify({
      type: 'client_id',
      client_id: clientId
    }));
    
    chrome.alarms.clear('reconnect');
    setState('idle');

    // Token refresh alarm — 45 min gives buffer before ~60 min expiry
    chrome.alarms.create('token-refresh', { periodInMinutes: 45 });

    // Send current state + resend token if we have one
    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      tokenAge: flowKey && metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
    }));
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      // ─── COMMANDS FROM AGENT ───────────────────────────────────────
      if (msg.method === 'open_flow_tab') {
        openFlowTab();
        return;
      }

      if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'solve_captcha') {
        await handleSolveCaptcha(msg);
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      } else if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[FlowAgent] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response
      }
    } catch (e) {
      console.error('[FlowAgent] Message error:', e);
    }
  };

  ws.onclose = () => {
    setState('off');
    chrome.alarms.clear('token-refresh');
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[FlowAgent] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

function sendToAgent(msg) {
  // API responses (with msg.id) go via HTTP — immune to WS disconnect
  if (msg.id) {
    fetch('http://127.0.0.1:8100/api/ext/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fallback to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status) or no secret yet — use WS
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await new Promise(r => setTimeout(r, 200));
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

async function solveCaptcha(requestId, captchaAction) {
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
  });

  if (!tabs.length) {
    // Auto-open Flow tab and wait briefly before returning error
    try {
      try {
        await chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow', active: false });
      } catch (err) {
        console.log('[FlowAgent] Failed to create tab in solveCaptcha, creating minimized window:', err);
        await chrome.windows.create({ url: 'https://labs.google/fx/tools/flow', state: 'minimized' });
      }
      await new Promise(r => setTimeout(r, 3000));
      // Retry tab query after opening
      const retryTabs = await chrome.tabs.query({
        url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
      });
      if (!retryTabs.length) return { error: 'NO_FLOW_TAB' };
      const resp = await Promise.race([
        requestCaptchaFromTab(retryTabs[0].id, requestId, captchaAction),
        new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
      ]);
      return resp;
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  try {
    const resp = await Promise.race([
      requestCaptchaFromTab(tabs[0].id, requestId, captchaAction),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
    ]);
    return resp;
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSolveCaptcha(msg) {
  const { id, params } = msg;
  const result = await solveCaptcha(id, params?.captchaAction || 'VIDEO_GENERATION');

  // Standalone captcha solve counts as captcha-consuming
  metrics.requestCount++;
  if (result?.token) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
    metrics.lastError = result?.error || 'NO_TOKEN';
  }
  chrome.storage.local.set({ metrics });

  sendToAgent({ id, result });
}

// ─── API Request Proxy ──────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  if (!url || !url.startsWith('https://labs.google/')) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls don't consume captcha — don't count in metrics

  const logId = id;
  // TRPC calls are silent — don't show in request log

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'success' });
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[FlowAgent] tRPC request failed:', e);
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error: e.message || 'TRPC_FETCH_FAILED' });
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params;

  if (!url) {
    sendToAgent({ id, error: 'MISSING_URL' });
    return;
  }

  if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyApiUrl(url);
  if (_VISIBLE_TYPES.has(logType)) {
    addRequestLog({
      id: logId, type: logType, time: new Date().toISOString(),
      status: 'processing', error: null, outputUrl: null,
      url, method,
      requestBody: body ? JSON.stringify(body) : null,
      payloadSummary: body ? JSON.stringify(body).slice(0, 200) : null,
      extensionId: clientId,
    });
  }

  try {
    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        // Cannot proceed without captcha — API will 403
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[FlowAgent] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(logId, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    // Step 3: Use flowKey for auth
    const activeFlowKey = flowKey;
    if (!activeFlowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(logId, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    const fetchHeaders = { ...(headers || {}) };
    fetchHeaders['authorization'] = `Bearer ${activeFlowKey}`;

    // Step 4: Make the API call from browser context
    const response = await fetch(url, {
      method: method || 'POST',
      headers: fetchHeaders,
      credentials: 'include',
      body: method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    let responseData;
    const responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    sendToAgent({
      id,
      status: response.status,
      data: responseData,
    });

    const responseSummary = responseText ? responseText.slice(0, 300) : null;
    const responseBody = responseText;
    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(logId, { status: 'success', httpStatus: response.status, responseSummary, responseBody });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(logId, { status: 'failed', error: `API_${response.status}`, httpStatus: response.status, responseSummary, responseBody });
    }
  } catch (e) {
    sendToAgent({
      id,
      status: 500,
      error: e.message || 'API_REQUEST_FAILED',
    });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'API_REQUEST_FAILED', errorStack: e.stack });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── State & Popup ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[state] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

// ─── Native Messaging helpers ────────────────────────────────

const NATIVE_HOST = 'com.flowkit.host';

/**
 * Send a single command to the native host and call cb(result).
 * Opens a short-lived native port, sends the message, waits for one reply.
 */
function _nativeSend(message, cb) {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    cb({ status: 'error', error: 'Native host not installed. Run native_host/install.sh first.' });
    return;
  }

  let responded = false;

  port.onMessage.addListener((msg) => {
    // Skip progress messages — pass them to the side panel live
    if (msg.type === 'progress') {
      chrome.runtime.sendMessage({ type: 'TUNNEL_PROGRESS', step: msg.step }).catch(() => {});
      return;
    }
    if (!responded) {
      responded = true;
      port.disconnect();
      cb(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    if (!responded) {
      responded = true;
      const err = chrome.runtime.lastError;
      const errMsg = err ? err.message : 'Native host disconnected unexpectedly';
      const isNativeError = errMsg.includes('not found') || errMsg.includes('native messaging host not found') || errMsg.includes('forbidden');
      cb({
        status: 'error',
        error: isNativeError ? 'One-time setup needed — see instructions in panel.' : errMsg,
        needsNativeSetup: isNativeError,
        extensionId: chrome.runtime.id,
      });
    }
  });

  port.postMessage(message);
}

/**
 * Start tunnel: sends cmd=start, handles progress updates, returns final result.
 * This keeps the port open until the native host sends its final (non-progress) reply.
 */
function _nativeStart(authToken, domain, cb) {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    cb({ status: 'error', error: 'Native host not installed. Run native_host/install.sh first.' });
    return;
  }

  let responded = false;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      chrome.runtime.sendMessage({ type: 'TUNNEL_PROGRESS', step: msg.step }).catch(() => {});
      return;
    }
    if (!responded) {
      responded = true;
      port.disconnect();
      // Cache result
      if (msg.status) {
        chrome.storage.local.set({ tunnelStatus: msg.status, tunnelUrl: msg.url || null });
        chrome.runtime.sendMessage({ type: 'TUNNEL_STATUS_PUSH', tunnel: msg }).catch(() => {});
      }
      cb(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    if (!responded) {
      responded = true;
      const err = chrome.runtime.lastError;
      const errMsg = err ? err.message : 'Native host disconnected';
      const isNativeError = errMsg.includes('not found') || errMsg.includes('native messaging host not found') || errMsg.includes('forbidden');
      cb({
        status: 'error',
        error: isNativeError ? 'One-time setup needed — see instructions in panel.' : errMsg,
        needsNativeSetup: isNativeError,
        extensionId: chrome.runtime.id,
      });
    }
  });

  port.postMessage({ cmd: 'start', auth_token: authToken, domain });
}


chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    reply({
      connected: ws?.readyState === WebSocket.OPEN,
      agentConnected: ws?.readyState === WebSocket.OPEN,
      flowKeyPresent: !!flowKey,
      manualDisconnect,
      tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount: metrics.failedCount,
        lastError: metrics.lastError,
      },
      state,
    });
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    if (ws) ws.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    if (msg.wsHost) {
      customWsHost = msg.wsHost;
      chrome.storage.local.set({ wsHost: customWsHost });
    }
    if (ws) ws.close(); // Force reconnect with new host
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'CLEAR_LOG') {
    clearRequestLog();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'DELETE_LOG_ENTRY') {
    if (msg.id) deleteLogEntry(msg.id);
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'GET_LOG_SETTINGS') {
    reply({ settings: logSettings });
    return true;
  }

  if (msg.type === 'SAVE_LOG_SETTINGS') {
    if (msg.settings) {
      Object.assign(logSettings, msg.settings);
      chrome.storage.local.set({ logSettings });
      // Restart cleanup alarm if needed
      chrome.alarms.create('log-cleanup', { periodInMinutes: 60 });
      cleanupOldLogs();
    }
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'GET_CLIENT_ID') {
    reply({ clientId });
    return true;
  }

  if (msg.type === 'GET_EXTENSIONS') {
    // Fetch from agent API if connected, otherwise return local info only
    fetch('http://127.0.0.1:8100/api/extensions', {
      signal: AbortSignal.timeout(3000)
    })
      .then(r => r.json())
      .then(data => reply({ extensions: data.extensions || [], localClientId: clientId }))
      .catch(() => reply({ extensions: [], localClientId: clientId }));
    return true;
  }

  if (msg.type === 'GET_CONNECTION_STATUS') {
    chrome.storage.local.get(['ngrokAuthToken', 'ngrokDomain', 'tunnelStatus', 'wsHost'], (data) => {
      reply({
        wsConnected: ws?.readyState === WebSocket.OPEN,
        wsHost: data.wsHost || 'ws://127.0.0.1:8100/ws',
        clientId,
        tunnelStatus: data.tunnelStatus || 'stopped',
        tunnelConfigured: !!(data.ngrokAuthToken && data.ngrokDomain),
        isRemote: data.wsHost && !data.wsHost.includes('127.0.0.1') && !data.wsHost.includes('localhost'),
      });
    });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({
      url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
    }).then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true, tabId: tabs[0].id });
      } else {
        chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow' })
          .then((tab) => reply({ ok: true, tabId: tab.id }))
          .catch((e) => reply({ error: e.message }));
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TEST_CAPTCHA') {
    solveCaptcha(`test-${Date.now()}`, msg.pageAction || 'IMAGE_GENERATION')
      .then((r) => reply(r))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TRPC_MEDIA_URLS') {
    handleTrpcMediaUrls(msg.trpcUrl, msg.body);
    reply({ ok: true });
    return true;
  }

  // ─── Tunnel (ngrok) handlers — Native Messaging ──────────
  if (msg.type === 'SAVE_NGROK_SETTINGS') {
    chrome.storage.local.set({
      ngrokAuthToken: msg.authToken || '',
      ngrokDomain: msg.domain || '',
      wsHost: msg.wsHost || '127.0.0.1',
    }, () => reply({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_NGROK_SETTINGS') {
    chrome.storage.local.get(['ngrokAuthToken', 'ngrokDomain', 'tunnelStatus', 'tunnelUrl', 'wsHost'], (data) => {
      reply({
        authToken: data.ngrokAuthToken || '',
        domain: data.ngrokDomain || '',
        tunnelStatus: data.tunnelStatus || 'stopped',
        tunnelUrl: data.tunnelUrl || null,
        wsHost: data.wsHost || '127.0.0.1',
      });
    });
    return true;
  }

  if (msg.type === 'START_TUNNEL') {
    chrome.storage.local.get(['ngrokAuthToken', 'ngrokDomain'], (data) => {
      if (!data.ngrokAuthToken || !data.ngrokDomain) {
        reply({ error: 'Missing ngrok auth token or domain. Configure in Settings.' });
        return;
      }
      _nativeStart(data.ngrokAuthToken, data.ngrokDomain, reply);
    });
    return true;
  }

  if (msg.type === 'STOP_TUNNEL') {
    _nativeSend({ cmd: 'stop' }, (result) => {
      chrome.storage.local.set({ tunnelStatus: 'stopped', tunnelUrl: null });
      chrome.runtime.sendMessage({ type: 'TUNNEL_STATUS_PUSH', tunnel: result }).catch(() => {});
      reply(result || { status: 'stopped' });
    });
    return true;
  }

  if (msg.type === 'GET_TUNNEL_STATUS') {
    _nativeSend({ cmd: 'status' }, (result) => {
      if (result && result.status) {
        chrome.storage.local.set({ tunnelStatus: result.status, tunnelUrl: result.url || null });
      }
      reply(result || { status: 'stopped' });
    });
    return true;
  }

  return true;
});

// ─── TRPC Media URL Extractor ──────────────────────────────

function handleTrpcMediaUrls(trpcUrl, bodyText) {
  try {
    // Extract all fresh GCS signed URLs
    const urlRegex = /https:\/\/storage\.googleapis\.com\/ai-sandbox-videofx\/(?:image|video)\/[0-9a-f-]{36}\?[^"'\s]+/g;
    const matches = bodyText.match(urlRegex) || [];
    if (!matches.length) return;

    // Deduplicate and parse
    const urlMap = {};
    for (const rawUrl of matches) {
      // Unescape JSON-escaped URLs
      const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
      const mediaMatch = url.match(/\/(image|video)\/([0-9a-f-]{36})\?/);
      if (mediaMatch) {
        const [, mediaType, mediaId] = mediaMatch;
        // Keep last occurrence (freshest)
        urlMap[mediaId] = { mediaType, url, mediaId };
      }
    }

    const entries = Object.values(urlMap);
    if (!entries.length) return;

    console.log(`[FlowAgent] Captured ${entries.length} fresh media URLs from TRPC`);
    // URL refresh is silent — don't show in request log

    // Forward to agent for DB update
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'media_urls_refresh',
        urls: entries,
      }));
    }
  } catch (e) {
    console.error('[FlowAgent] Failed to extract TRPC media URLs:', e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Human-like Telemetry ──────────────────────────────────
// Periodically send tracking events to Google's analytics endpoints
// to mimic normal browser behavior.

const _UA = navigator.userAgent;
let _telemetrySessionId = `;${Date.now()}`;

function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function _buildBatchLogPayload() {
  const events = [];
  const types = ['FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY'];
  const count = _rand(1, 3);
  for (let i = 0; i < count; i++) {
    events.push({
      event: types[_rand(0, types.length - 1)],
      eventProperties: [
        { key: 'CURRENT_TIME_MS', doubleValue: Date.now() },
        { key: 'DURATION_MS', doubleValue: _rand(150, 800) },
        { key: 'USER_AGENT', stringValue: _UA },
        { key: 'IS_DESKTOP', booleanValue: true },
      ],
      eventMetadata: { sessionId: _telemetrySessionId },
      eventTime: new Date().toISOString(),
    });
  }
  return { appEvents: events };
}

function _buildFrontendEventsPayload() {
  const eventTypes = [
    'FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY', 'GRID_SCROLL_DEPTH',
    'FLOW_PROJECT_OPEN', 'FLOW_SCENE_VIEW',
  ];
  const count = _rand(1, 4);
  const events = [];
  for (let i = 0; i < count; i++) {
    const et = eventTypes[_rand(0, eventTypes.length - 1)];
    const params = {
      USER_AGENT: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: _UA },
      IS_DESKTOP: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'true' },
    };
    if (et.includes('LATENCY')) {
      params.CURRENT_TIME_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(Date.now()) };
      params.DURATION_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(_rand(100, 600)) };
    }
    if (et === 'GRID_SCROLL_DEPTH') {
      params.MEDIA_GENERATION_PAYGATE_TIER = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'PAYGATE_TIER_TWO' };
    }
    events.push({
      eventType: et,
      metadata: {
        sessionId: _telemetrySessionId,
        createTime: new Date().toISOString(),
        additionalParams: params,
      },
    });
  }
  return { events };
}

async function sendTelemetry() {
  if (!flowKey || state === 'off') return;

  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'authorization': `Bearer ${flowKey}`,
  };

  // Telemetry is silent — don't show in request log
  try {
    if (Math.random() < 0.5) {
      await fetch(`https://aisandbox-pa.googleapis.com/v1:batchLog`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildBatchLogPayload()),
      });
    } else {
      await fetch(`https://aisandbox-pa.googleapis.com/v1/flow:batchLogFrontendEvents`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildFrontendEventsPayload()),
      });
    }
  } catch {}
}

// Send telemetry at random intervals (45-120s) to look organic
function scheduleTelemetry() {
  const delay = _rand(45, 120) * 1000;
  setTimeout(async () => {
    await sendTelemetry();
    scheduleTelemetry(); // reschedule with new random interval
  }, delay);
}

// Refresh session ID every ~30min like a real user
setInterval(() => { _telemetrySessionId = `;${Date.now()}`; }, _rand(25, 35) * 60 * 1000);

scheduleTelemetry();

console.log('[FlowAgent] Extension loaded');
