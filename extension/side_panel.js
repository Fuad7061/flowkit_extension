/**
 * Flow Kit — Side Panel
 * Displays live connection status, metrics, and request log.
 */

// ── Type label map ───────────────────────────────────────────

const TYPE_LABELS = {
  // Worker request types
  GENERATE_IMAGE:           'GEN IMAGE',
  REGENERATE_IMAGE:         'REGEN IMAGE',
  EDIT_IMAGE:               'EDIT IMAGE',
  GENERATE_CHARACTER_IMAGE: 'GEN REF',
  REGENERATE_CHARACTER_IMAGE: 'REGEN REF',
  EDIT_CHARACTER_IMAGE:     'EDIT REF',
  GENERATE_VIDEO:           'GEN VIDEO',
  GENERATE_VIDEO_REFS:      'GEN VIDEO FROM REFS',
  UPSCALE_VIDEO:            'UPSCALE VIDEO',
  // Captcha action types
  IMAGE_GENERATION:         'GEN IMAGE',
  VIDEO_GENERATION:         'GEN VIDEO',
  // Extension-classified API types
  GEN_IMG:                  'GEN IMAGE',
  GEN_VID:                  'GEN VIDEO',
  GEN_VID_REF:              'GEN VIDEO FROM REFS',
  UPSCALE:                  'UPSCALE VIDEO',
  UPS_IMG:                  'UPSCALE IMAGE',
  POLL:                     'CHECK GEN VIDEO',
  CREDITS:                  'CHECK CREDIT',
  CREATE_PROJECT:           'CREATE PROJECT',
  UPLOAD:                   'UPLOAD IMAGE',
  MEDIA:                    'READ MEDIA',
  TRACKING:                 'GOOGLE FLOW TRACK',
  URL_REFRESH:              'URL REFRESH',
  TRPC:                     'TRPC',
  API:                      'API',
};

function formatType(type) {
  if (!type) return '—';
  return TYPE_LABELS[type] || type.slice(0, 5).toUpperCase();
}

// ── Time formatting ──────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '—';
  }
}

// ── Status update ────────────────────────────────────────────

function updateStatus(data) {
  if (!data) return;

  // Connection dot
  const dot = document.getElementById('conn-dot');
  const connected = data.agentConnected;
  dot.className = connected ? 'on' : '';

  // Toggle state
  const toggle = document.getElementById('main-toggle');
  const toggleLabel = document.getElementById('toggle-label');
  const isOn = data.state !== 'off';
  toggle.checked = isOn;
  toggleLabel.textContent = isOn ? 'ON' : 'OFF';

  // State badge
  const stateBadge = document.getElementById('state-badge');
  const st = data.state || 'off';
  stateBadge.textContent = st;
  stateBadge.className = st; // idle | running | off

  // Token status
  const tokenEl = document.getElementById('token-status');
  if (data.flowKeyPresent) {
    const ageMs = data.tokenAge || 0;
    const ageMin = Math.round(ageMs / 60000);
    if (ageMs > 3600000) {
      tokenEl.textContent = `token expired — open Flow to refresh`;
      tokenEl.className = 'warn';
    } else {
      tokenEl.textContent = `token synced ${ageMin}m`;
      tokenEl.className = 'ok';
    }
    // Auto-refresh when token age > 55 min and connected
    if (ageMs > 3300000 && data.agentConnected) {
      chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
    }
  } else {
    tokenEl.textContent = 'no token';
    tokenEl.className = 'bad';
  }

  // Metrics
  const m = data.metrics || {};
  document.getElementById('m-total').textContent   = m.requestCount || 0;
  document.getElementById('m-success').textContent = m.successCount || 0;
  document.getElementById('m-failed').textContent  = m.failedCount  || 0;
}

// ── Request log ──────────────────────────────────────────────

function updateRequestLog(entries) {
  const tbody = document.getElementById('log-body');
  const countEl = document.getElementById('log-count');

  if (!entries || entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="log-empty">No requests yet</td></tr>';
    countEl.textContent = '0';
    return;
  }

  countEl.textContent = entries.length;
  _logEntries = entries;

  // Render newest first (entries already sorted DESC by background.js)
  const rows = entries.map((entry) => {
    const shortId = entry.id ? String(entry.id).slice(0, 8) : '—';
    const type   = formatType(entry.type || entry.method);
    const time   = formatTime(entry.time || entry.timestamp || entry.createdAt);
    const status = entry.status || entry.state || 'pending';
    const error  = entry.error || '';

    let badgeHtml;
    if (status === 'COMPLETED' || status === 'success') {
      badgeHtml = '<span class="badge badge-ok">&#10003; done</span>';
    } else if (status === 'FAILED' || status === 'failed' || (typeof status === 'number' && status >= 400)) {
      badgeHtml = '<span class="badge badge-fail">&#10007; fail</span>';
    } else if (status === 'PROCESSING') {
      badgeHtml = '<span class="badge badge-proc">&#9203; gen...</span>';
    } else if (status === 200 || status === 'processing') {
      badgeHtml = '<span class="badge badge-proc">&#9203; sent</span>';
    } else {
      badgeHtml = '<span class="badge badge-proc">&#9203; sent</span>';
    }

    const errorDisplay = error
      ? `<td class="td-error" title="${escHtml(error)}">${escHtml(truncate(error, 28))}</td>`
      : `<td class="td-error empty">—</td>`;

    return `<tr>
      <td class="td-id" data-request-id="${escHtml(entry.id || '')}">${escHtml(shortId)}</td>
      <td class="td-type">${escHtml(type)}</td>
      <td class="td-time">${escHtml(time)}</td>
      <td>${badgeHtml}</td>
      ${errorDisplay}
    </tr>`;
  });

  tbody.innerHTML = rows.join('');

  // Attach click handlers to ID cells
  tbody.querySelectorAll('.td-id[data-request-id]').forEach(td => {
    td.addEventListener('click', () => {
      const reqId = td.getAttribute('data-request-id');
      if (reqId) showRequestDetail(reqId);
    });
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str || str.length <= len) return str;
  return str.slice(0, len) + '…';
}

// ── Request detail modal ────────────────────────────────────

let _logEntries = [];

function showRequestDetail(reqId) {
  const entry = _logEntries.find(e => e.id === reqId);
  if (!entry) return;

  const overlay = document.getElementById('detail-overlay');
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');

  title.textContent = `Request ${String(reqId).slice(0, 12)}`;

  const fields = [
    ['ID', entry.id],
    ['Type', formatType(entry.type || entry.method)],
    ['Time', formatTime(entry.time || entry.timestamp || entry.createdAt)],
    ['Status', entry.status || entry.state || 'pending'],
    ['HTTP', entry.httpStatus || '—'],
    ['URL', entry.url || '—'],
    ['Payload', entry.payloadSummary || '—'],
    ['Response', entry.responseSummary || '—'],
    ['Error', entry.error || '—'],
  ];

  body.innerHTML = fields.map(([label, value]) => {
    let cls = 'detail-value';
    if (label === 'Error' && value && value !== '—') cls += ' error';
    if (label === 'Status' && (value === 'COMPLETED' || value === 'success')) cls += ' ok';
    return `<div class="detail-row">
      <div class="detail-label">${escHtml(label)}</div>
      <div class="${cls}">${escHtml(String(value || '—'))}</div>
    </div>`;
  }).join('');

  overlay.classList.add('open');
}

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-overlay').classList.remove('open');
});

document.getElementById('detail-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
  }
});

// ── Initial data fetch ───────────────────────────────────────

function fetchStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (data) => {
    if (chrome.runtime.lastError) return;
    updateStatus(data);
  });
}

function fetchLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG' }, (data) => {
    if (chrome.runtime.lastError) return;
    if (data && data.log) updateRequestLog(data.log);
  });
}

// ── Message listener (push updates) ─────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') {
    fetchStatus();
  }
  if (msg.type === 'REQUEST_LOG_UPDATE') {
    if (msg.log) updateRequestLog(msg.log);
  }
  if (msg.type === 'TUNNEL_STATUS_PUSH') {
    if (msg.tunnel) applyTunnelState(msg.tunnel);
  }
  if (msg.type === 'TUNNEL_PROGRESS') {
    // Show live step message during startup
    const startBtn = document.getElementById('btn-start-tunnel');
    if (startBtn && startBtn.disabled) {
      startBtn.textContent = msg.step || 'Starting...';
    }
  }
});

// ── Toggle (connect / disconnect) ───────────────────────────

document.getElementById('main-toggle').addEventListener('change', (e) => {
  const msgType = e.target.checked ? 'RECONNECT' : 'DISCONNECT';
  chrome.runtime.sendMessage({ type: msgType }, () => {
    if (chrome.runtime.lastError) return;
    setTimeout(fetchStatus, 400);
  });
});

// ── Action buttons ───────────────────────────────────────────

document.getElementById('btn-flow').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' }, () => {
    if (chrome.runtime.lastError) return;
  });
});

document.getElementById('btn-token').addEventListener('click', () => {
  const btn = document.getElementById('btn-token');
  btn.textContent = 'Opening...';
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
    btn.textContent = 'Refresh Token';
    btn.disabled = false;
  });
});

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  fetchLog();
  initTunnel();
});

// ═══════════════════════════════════════════════════════════════
// TUNNEL PANEL
// ═══════════════════════════════════════════════════════════════

let _tunnelPollTimer = null;
let _currentTunnelUrl = null;

function initTunnel() {
  chrome.runtime.sendMessage({ type: 'GET_NGROK_SETTINGS' }, (data) => {
    if (chrome.runtime.lastError || !data) return;

    const hasSettings = !!(data.authToken && data.domain);
    if (data.authToken) document.getElementById('ngrok-token').value = data.authToken;
    if (data.domain)    document.getElementById('ngrok-domain').value = data.domain;
    if (data.wsHost)    document.getElementById('ws-host').value = data.wsHost;

    if (!hasSettings) {
      openTunnelPanel();
      openSettingsForm();
    }

    if (hasSettings) {
      document.getElementById('settings-saved-dot').style.display = 'inline-block';
    }

    applyTunnelState({ status: data.tunnelStatus || 'stopped', url: data.tunnelUrl || null });

    if (data.tunnelStatus === 'active') {
      refreshTunnelStatus();
    }
  });

  document.getElementById('tunnel-header').addEventListener('click', () => {
    const body    = document.getElementById('tunnel-body');
    const chevron = document.getElementById('tunnel-chevron');
    const isOpen  = body.classList.toggle('open');
    chevron.classList.toggle('open', isOpen);
  });

  document.getElementById('tunnel-settings-toggle').addEventListener('click', () => {
    document.getElementById('tunnel-settings-form').classList.toggle('open');
  });

  document.getElementById('btn-eye-token').addEventListener('click', () => {
    const inp = document.getElementById('ngrok-token');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    const authToken = document.getElementById('ngrok-token').value.trim();
    let domain      = document.getElementById('ngrok-domain').value.trim();
    let wsHost      = document.getElementById('ws-host').value.trim() || 'ws://127.0.0.1:8100/ws';

    // Clean up domain (remove https://, http://, and trailing slashes)
    domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    document.getElementById('ngrok-domain').value = domain;

    if (!authToken || !domain) {
      showTunnelError('Please fill in both Auth Token and Static Domain.');
      return;
    }

    chrome.runtime.sendMessage({ type: 'SAVE_NGROK_SETTINGS', authToken, domain, wsHost }, () => {
      chrome.runtime.sendMessage({ type: 'RECONNECT', wsHost });
      const statusEl = document.getElementById('settings-status');
      statusEl.style.display = 'block';
      document.getElementById('settings-saved-dot').style.display = 'inline-block';
      hideTunnelError();
      setTimeout(() => {
        statusEl.style.display = 'none';
        document.getElementById('tunnel-settings-form').classList.remove('open');
      }, 1500);
    });
  });

  document.getElementById('btn-start-tunnel').addEventListener('click', () => {
    const authToken = document.getElementById('ngrok-token').value.trim();
    let domain      = document.getElementById('ngrok-domain').value.trim();

    // Clean up domain (remove https://, http://, and trailing slashes)
    domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    document.getElementById('ngrok-domain').value = domain;

    if (!authToken || !domain) {
      openSettingsForm();
      showTunnelError('Fill in your ngrok Auth Token and Static Domain first, then save.');
      return;
    }

    setTunnelStarting();

    chrome.runtime.sendMessage({ type: 'START_TUNNEL' }, (result) => {
      if (chrome.runtime.lastError) {
        applyTunnelState({ status: 'error', error: 'Extension error: ' + chrome.runtime.lastError.message });
        return;
      }
      applyTunnelState(result);
      if (result && result.status === 'active') startTunnelPolling();
    });
  });

  document.getElementById('btn-stop-tunnel').addEventListener('click', () => {
    stopTunnelPolling();
    document.getElementById('btn-stop-tunnel').disabled = true;
    chrome.runtime.sendMessage({ type: 'STOP_TUNNEL' }, (result) => {
      if (chrome.runtime.lastError) return;
      applyTunnelState(result || { status: 'stopped' });
    });
  });

  document.getElementById('btn-copy-url').addEventListener('click', () => {
    if (!_currentTunnelUrl) return;
    navigator.clipboard.writeText(_currentTunnelUrl).then(() => {
      const btn = document.getElementById('btn-copy-url');
      btn.textContent = '\u2713 Copied!';
      setTimeout(() => { btn.textContent = '\ud83d\udccb Copy URL'; }, 1800);
    });
  });

  document.getElementById('api-docs-header').addEventListener('click', () => {
    const panel   = document.getElementById('api-docs-body');
    const chevron = document.getElementById('api-docs-chevron');
    const isOpen  = panel.classList.toggle('open');
    chevron.classList.toggle('open', isOpen);
  });

  document.querySelectorAll('.curl-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.curl-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      ['gen-image', 'edit-image', 'health'].forEach((id) => {
        document.getElementById('curl-' + id).style.display = (id === target) ? 'block' : 'none';
      });
    });
  });

  document.querySelectorAll('.curl-copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = document.getElementById(btn.dataset.target);
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = '\u2713';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
      });
    });
  });

  document.getElementById('btn-copy-setup').addEventListener('click', () => {
    const code = document.getElementById('tunnel-setup-code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
      const btn = document.getElementById('btn-copy-setup');
      btn.textContent = '\u2713';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    });
  });
}

function openTunnelPanel() {
  document.getElementById('tunnel-body').classList.add('open');
  document.getElementById('tunnel-chevron').classList.add('open');
}

function openSettingsForm() {
  document.getElementById('tunnel-settings-form').classList.add('open');
}

function showTunnelError(msg) {
  const el = document.getElementById('tunnel-error-box');
  el.textContent = msg;
  el.classList.add('show');
}

function hideTunnelError() {
  document.getElementById('tunnel-error-box').classList.remove('show');
}

function setTunnelStarting() {
  const badge = document.getElementById('tunnel-badge');
  badge.className = 'tunnel-badge starting';
  badge.textContent = 'starting';

  const startBtn = document.getElementById('btn-start-tunnel');
  startBtn.disabled = true;
  startBtn.textContent = 'Connecting...';

  document.getElementById('btn-stop-tunnel').style.display = 'none';
  document.getElementById('tunnel-url-box').classList.remove('show');
  document.getElementById('tunnel-error-box').classList.remove('show');
}

function applyTunnelState(result) {
  if (!result) return;

  const { status, url, error } = result;
  const badge    = document.getElementById('tunnel-badge');
  const startBtn = document.getElementById('btn-start-tunnel');
  const stopBtn  = document.getElementById('btn-stop-tunnel');
  const urlBox   = document.getElementById('tunnel-url-box');
  const urlText  = document.getElementById('tunnel-url-text');
  const curlSec  = document.getElementById('curl-section');
  const errBox   = document.getElementById('tunnel-error-box');

  badge.className   = 'tunnel-badge ' + status;
  badge.textContent = status;
  startBtn.disabled = false;

  if (status === 'active' && url) {
    _currentTunnelUrl = url;
    startBtn.style.display = 'none';
    stopBtn.style.display  = 'block';
    stopBtn.disabled = false;
    urlBox.classList.add('show');
    urlText.textContent = url;
    errBox.classList.remove('show');
    document.getElementById('tunnel-setup-box').classList.remove('show');
    populateCurls(url);
    startTunnelPolling();
  } else if (status === 'stopped') {
    _currentTunnelUrl = null;
    startBtn.style.display = 'block';
    startBtn.textContent   = '\u25b6 Start Public URL';
    stopBtn.style.display  = 'none';
    urlBox.classList.remove('show');
    errBox.classList.remove('show');
    document.getElementById('tunnel-setup-box').classList.remove('show');
    populateCurls('<YOUR_PUBLIC_URL_HERE>');
    stopTunnelPolling();
  } else if (status === 'error') {
    _currentTunnelUrl = null;
    startBtn.style.display = 'block';
    startBtn.textContent   = '\u25b6 Retry';
    stopBtn.style.display  = 'none';
    urlBox.classList.remove('show');
    populateCurls('<YOUR_PUBLIC_URL_HERE>');
    openTunnelPanel();
    const currentWsHost = document.getElementById('ws-host').value.trim();
    const isRemote = currentWsHost && !currentWsHost.includes('127.0.0.1');
    if (!isRemote) {
      errBox.textContent = '\u26a0 ' + (error || 'Unknown error. Is the server running?');
      errBox.classList.add('show');
    }
    
    const setupBox = document.getElementById('tunnel-setup-box');
    if (!isRemote && result.needsNativeSetup && result.extensionId) {
      const code = document.getElementById('tunnel-setup-code');
      // Use absolute path for reliability
      code.textContent = `bash "/Users/bondhon/Bondhon/Github Project/Test/flowkit-image-api/native_host/install.sh" "${result.extensionId}"`;
      setupBox.classList.add('show');
    } else {
      setupBox.classList.remove('show');
    }
    
    stopTunnelPolling();
  }
}

function startTunnelPolling() {
  stopTunnelPolling();
  _tunnelPollTimer = setInterval(refreshTunnelStatus, 12000);
}

function stopTunnelPolling() {
  if (_tunnelPollTimer) {
    clearInterval(_tunnelPollTimer);
    _tunnelPollTimer = null;
  }
}

function refreshTunnelStatus() {
  chrome.runtime.sendMessage({ type: 'GET_TUNNEL_STATUS' }, (result) => {
    if (chrome.runtime.lastError || !result) return;
    const badge = document.getElementById('tunnel-badge');
    const currentStatus = badge.className.replace('tunnel-badge ', '').trim();
    if (result.status !== currentStatus) {
      applyTunnelState(result);
    }
  });
}

function populateCurls(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');

  document.getElementById('code-gen-image').textContent = [
    'curl -X POST "' + base + '/api/generate" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{',
    '    "prompt": "a photorealistic mountain at golden hour",',
    '    "aspect_ratio": "16:9",',
    '    "image_model": "NANO_BANANA_PRO",',
    '    "webhook_url": "https://your-webhook.com/callback"',
    '  }\'',
    '',
    '# All Available Parameters:',
    '# prompt:        (string) Your image prompt',
    '# aspect_ratio:  (string) "16:9" | "9:16" | "1:1" | "4:3"',
    '# image_model:   (string) "NANO_BANANA_PRO" | "NANO_BANANA_2"',
    '# webhook_url:   (string) Optional. URL to receive the image result asynchronously',
    '# width:         (int) Optional width override',
    '# height:        (int) Optional height override'
  ].join('\n');

  document.getElementById('code-edit-image').textContent = [
    'curl -X POST "' + base + '/api/edit" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{',
    '    "image_url": "https://example.com/your-image.jpg",',
    '    "prompt": "make the sky dramatic with storm clouds",',
    '    "aspect_ratio": "16:9",',
    '    "image_model": "NANO_BANANA_PRO",',
    '    "webhook_url": "https://your-webhook.com/callback"',
    '  }\'',
    '',
    '# All Available Parameters:',
    '# image_url:     (string) URL of the image to edit',
    '# prompt:        (string) Your edit prompt',
    '# aspect_ratio:  (string) "16:9" | "9:16" | "1:1" | "4:3"',
    '# image_model:   (string) "NANO_BANANA_PRO" | "NANO_BANANA_2"',
    '# webhook_url:   (string) Optional. URL to receive the result'
  ].join('\n');

  document.getElementById('code-health').textContent = [
    'curl "' + base + '/health"',
    '',
    '# Expected response:',
    '# {',
    '#   "status": "ok",',
    '#   "version": "1.0.0",',
    '#   "extension_connected": true',
    '# }',
  ].join('\n');
}

