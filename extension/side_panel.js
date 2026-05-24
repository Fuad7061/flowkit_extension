// ── Type label map ───────────────────────────────────────────

const TYPE_LABELS = {
  GENERATE_IMAGE:           'GEN IMAGE',
  REGENERATE_IMAGE:         'REGEN IMAGE',
  EDIT_IMAGE:               'EDIT IMAGE',
  GENERATE_CHARACTER_IMAGE: 'GEN REF',
  REGENERATE_CHARACTER_IMAGE: 'REGEN REF',
  EDIT_CHARACTER_IMAGE:     'EDIT REF',
  GENERATE_VIDEO:           'GEN VIDEO',
  GENERATE_VIDEO_REFS:      'GEN VIDEO FROM REFS',
  UPSCALE_VIDEO:            'UPSCALE VIDEO',
  IMAGE_GENERATION:         'GEN IMAGE',
  VIDEO_GENERATION:         'GEN VIDEO',
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
  TRACKING:                 'TRACKING',
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
  } catch { return '—'; }
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

// ── HTML escape ──────────────────────────────────────────────

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

// ── State ────────────────────────────────────────────────────

let _logEntries = [];
let _filteredLogs = [];
let _logFilter = 'all';
let _logSearch = '';
let _logSettings = { autoClear: true, retentionDays: 3, maxEntries: 100, persistEnabled: true };
let _localClientId = '—';
let _tunnelPollTimer = null;
let _currentTunnelUrl = null;

// ── Status update ────────────────────────────────────────────

function updateStatus(data) {
  if (!data) return;
  const dot = document.getElementById('conn-dot');
  dot.className = data.agentConnected ? 'on' : '';

  const toggle = document.getElementById('main-toggle');
  const toggleLabel = document.getElementById('toggle-label');
  const isOn = data.state !== 'off';
  toggle.checked = isOn;
  toggleLabel.textContent = isOn ? 'ON' : 'OFF';

  const stateBadge = document.getElementById('state-badge');
  const st = data.state || 'off';
  stateBadge.textContent = st;
  stateBadge.className = st;

  const tokenEl = document.getElementById('token-status');
  if (data.flowKeyPresent) {
    const ageMs = data.tokenAge || 0;
    const ageMin = Math.round(ageMs / 60000);
    if (ageMs > 3600000) {
      tokenEl.textContent = 'token expired';
      tokenEl.className = 'warn';
      if (data.agentConnected) chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
    } else {
      tokenEl.textContent = 'token ' + ageMin + 'm';
      tokenEl.className = 'ok';
    }
    if (ageMs > 3300000 && data.agentConnected) {
      chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
    }
  } else {
    tokenEl.textContent = 'no token';
    tokenEl.className = 'bad';
  }

  const m = data.metrics || {};
  document.getElementById('m-total').textContent   = m.requestCount || 0;
  document.getElementById('m-success').textContent = m.successCount || 0;
  document.getElementById('m-failed').textContent  = m.failedCount  || 0;

  // Also fetch connection status for method indicator
  fetchConnStatus();
}

// ── Connection Status ────────────────────────────────────────

function fetchConnStatus() {
  chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    updateConnStatus(data);
  });
}

function updateConnStatus(status) {
  const methodEl = document.getElementById('conn-method');

  // Header method indicator
  if (status.wsConnected) {
    if (status.isRemote) {
      methodEl.textContent = 'WS';
      methodEl.className = 'ws';
    } else {
      methodEl.textContent = 'LOC';
      methodEl.className = 'ws';
    }
  } else if (status.tunnelStatus === 'active') {
    methodEl.textContent = 'TUN';
    methodEl.className = 'tunnel';
  } else {
    methodEl.textContent = 'OFF';
    methodEl.className = 'off';
  }

  // Tunnel section connection indicator
  const ind = document.getElementById('tunnel-conn-indicator');
  const label = document.getElementById('tunnel-conn-label');
  const btnConnect = document.getElementById('btn-connect-ws');
  const btnDisconnect = document.getElementById('btn-disconnect-ws');
  if (ind) {
    ind.style.background = status.wsConnected ? 'var(--green)' : 'var(--red)';
  }
  if (label) {
    if (status.wsConnected) {
      label.textContent = status.isRemote ? `Connected to ${status.wsHost}` : 'Connected to local agent';
      label.style.color = 'var(--green)';
    } else if (status.tunnelStatus === 'active') {
      label.textContent = 'Connected via Public Tunnel';
      label.style.color = '#60a5fa';
    } else {
      label.textContent = 'Not connected';
      label.style.color = 'var(--muted)';
    }
  }
  if (btnConnect) btnConnect.style.display = status.wsConnected ? 'none' : '';
  if (btnDisconnect) btnDisconnect.style.display = status.wsConnected ? '' : 'none';

  // Update ws-host input if value differs
  const wsHostInput = document.getElementById('tunnel-ws-host');
  if (wsHostInput && status.wsHost && wsHostInput.value !== status.wsHost) {
    wsHostInput.value = status.wsHost;
  }
}

// ── Request log ──────────────────────────────────────────────

function updateRequestLog(entries) {
  _logEntries = entries || [];
  applyFilters();
}

function applyFilters() {
  let filtered = _logEntries.slice();
  if (_logFilter === 'success') filtered = filtered.filter(e => e.status === 'success' || e.status === 'COMPLETED');
  if (_logFilter === 'failed') filtered = filtered.filter(e => e.status === 'failed' || e.status === 'FAILED' || (typeof e.status === 'number' && e.status >= 400));
  if (_logSearch) {
    const q = _logSearch.toLowerCase();
    filtered = filtered.filter(e =>
      (e.id && e.id.toLowerCase().includes(q)) ||
      (e.type && e.type.toLowerCase().includes(q)) ||
      (e.error && e.error.toLowerCase().includes(q)) ||
      (e.url && e.url.toLowerCase().includes(q))
    );
  }
  _filteredLogs = filtered;
  renderLogTable(filtered);
  updateLogCountBadge();
}

function updateLogCountBadge() {
  document.getElementById('log-count').textContent = _logEntries.length;
  document.getElementById('tab-log-count').textContent = _filteredLogs.length;
  const statsEl = document.getElementById('settings-log-count');
  if (statsEl) statsEl.textContent = _logEntries.length;
}

function renderLogTable(entries) {
  const tbody = document.getElementById('log-body');
  const countEl = document.getElementById('log-count');

  if (!entries || entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="log-empty">No requests yet</td></tr>';
    countEl.textContent = '0';
    return;
  }

  tbody.innerHTML = entries.map((entry) => {
    const shortId = entry.id ? String(entry.id).slice(0, 8) : '—';
    const type   = formatType(entry.type || entry.method);
    const time   = formatTime(entry.time || entry.timestamp || entry.createdAt);
    const rel    = relativeTime(entry.time || entry.timestamp || entry.startedAt || entry.createdAt);
    const status = entry.status || entry.state || 'pending';
    const error  = entry.error || '';
    const dur    = formatDuration(entry.duration);

    let badgeHtml;
    if (status === 'COMPLETED' || status === 'success') {
      badgeHtml = '<span class="badge badge-ok">✓</span>';
    } else if (status === 'FAILED' || status === 'failed' || (typeof status === 'number' && status >= 400)) {
      badgeHtml = '<span class="badge badge-fail">✗</span>';
    } else if (status === 'PROCESSING') {
      badgeHtml = '<span class="badge badge-proc">⏳</span>';
    } else {
      badgeHtml = '<span class="badge badge-proc">⏳</span>';
    }

    const rowClass = (status === 'success' || status === 'COMPLETED') ? 'success' :
                     (status === 'failed' || status === 'FAILED') ? 'failed' : '';

    const errorDisplay = error
      ? `<td class="td-error" title="${escHtml(error)}">${escHtml(truncate(error, 24))}</td>`
      : `<td class="td-error empty">—</td>`;

    const timeDisplay = rel ? `${time}<br><span style="font-size:7px;color:var(--muted)">${rel}</span>` : time;

    return `<tr class="${rowClass}">
      <td class="td-id" data-request-id="${escHtml(entry.id || '')}">${escHtml(shortId)}</td>
      <td class="td-type">${escHtml(type)}</td>
      <td class="td-time" title="${escHtml(entry.time || '')}">${timeDisplay}${dur ? '<br><span class="td-duration">' + dur + '</span>' : ''}</td>
      <td>${badgeHtml}</td>
      ${errorDisplay}
      <td><span class="td-del" data-del-id="${escHtml(entry.id || '')}">✕</span></td>
    </tr>`;
  }).join('');

  // Click handlers
  tbody.querySelectorAll('.td-id[data-request-id]').forEach(td => {
    td.addEventListener('click', () => {
      const reqId = td.getAttribute('data-request-id');
      if (reqId) showRequestDetail(reqId);
    });
  });

  tbody.querySelectorAll('.td-del').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.getAttribute('data-del-id');
      if (id) chrome.runtime.sendMessage({ type: 'DELETE_LOG_ENTRY', id });
    });
  });
}

// ── Request detail modal ────────────────────────────────────

function showRequestDetail(reqId) {
  const entry = _logEntries.find(e => e.id === reqId);
  if (!entry) return;

  const overlay = document.getElementById('detail-overlay');
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');

  title.textContent = 'Request ' + String(reqId).slice(0, 12);

  const fields = [
    ['ID', entry.id],
    ['Type', formatType(entry.type || entry.method)],
    ['Time', entry.time || entry.timestamp || entry.createdAt || '—'],
    ['Duration', formatDuration(entry.duration) || '—'],
    ['Status', entry.status || entry.state || 'pending'],
    ['HTTP', entry.httpStatus || '—'],
    ['Extension', entry.extensionId || '—'],
    ['URL', entry.url || '—'],
    ['Payload', entry.requestBody || entry.payloadSummary || '—'],
    ['Response', entry.responseBody || entry.responseSummary || '—'],
    ['Error', entry.error || '—'],
  ];

  body.innerHTML = fields.map(([label, value]) => {
    let cls = 'detail-value';
    if (label === 'Error' && value && value !== '—') cls += ' error';
    if (label === 'Status' && (value === 'COMPLETED' || value === 'success')) cls += ' ok';

    let valHtml = escHtml(String(value || '—'));

    // For large JSON values, render in a pre block with toggle
    if (typeof value === 'string' && value.length > 80 && (value.startsWith('{') || value.startsWith('['))) {
      const pretty = tryPrettyPrint(value);
      valHtml = `<pre class="json-pretty">${escHtml(pretty)}</pre>`;
    }

    return `<div class="detail-row">
      <div class="detail-label">${escHtml(label)}</div>
      <div class="${cls}">${valHtml}</div>
    </div>`;
  }).join('');

  overlay.classList.add('open');

  // Store current entry for copy-json
  document.getElementById('detail-copy-json').onclick = () => {
    navigator.clipboard.writeText(JSON.stringify(entry, null, 2)).then(() => {
      const btn = document.getElementById('detail-copy-json');
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⎘'; }, 1200);
    });
  };
}

function tryPrettyPrint(str) {
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

// ── Detail modal events ──────────────────────────────────────

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-overlay').classList.remove('open');
});

document.getElementById('detail-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

// ── Tab switching ────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  chrome.storage.local.set({ lastTab: name });
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
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

function fetchClientId() {
  chrome.runtime.sendMessage({ type: 'GET_CLIENT_ID' }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    _localClientId = data.clientId || '—';
    const badge = document.getElementById('client-id-badge');
    badge.textContent = data.clientId ? data.clientId.slice(0, 8) + '…' : '—';
    badge.title = 'Client ID: ' + (data.clientId || '—') + '\nClick to copy';
    const input = document.getElementById('settings-client-id-input');
    if (input) input.value = data.clientId || '';
  });
}

function fetchLogSettings() {
  chrome.runtime.sendMessage({ type: 'GET_LOG_SETTINGS' }, (data) => {
    if (chrome.runtime.lastError || !data || !data.settings) return;
    _logSettings = data.settings;
    applyLogSettingsUI();
  });
}

function applyLogSettingsUI() {
  document.getElementById('setting-auto-clear').checked = _logSettings.autoClear !== false;
  document.getElementById('setting-retention').value = String(_logSettings.retentionDays || 3);
  document.getElementById('setting-max-entries').value = String(_logSettings.maxEntries || 100);
  document.getElementById('setting-persist').checked = _logSettings.persistEnabled !== false;
}

function saveLogSettings() {
  _logSettings.autoClear = document.getElementById('setting-auto-clear').checked;
  _logSettings.retentionDays = parseInt(document.getElementById('setting-retention').value, 10);
  _logSettings.maxEntries = parseInt(document.getElementById('setting-max-entries').value, 10);
  _logSettings.persistEnabled = document.getElementById('setting-persist').checked;
  chrome.runtime.sendMessage({ type: 'SAVE_LOG_SETTINGS', settings: _logSettings }, () => {
    if (chrome.runtime.lastError) return;
  });
}

// ── Message listener ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') fetchStatus();
  if (msg.type === 'REQUEST_LOG_UPDATE') {
    if (msg.log) updateRequestLog(msg.log);
  }
  if (msg.type === 'TUNNEL_STATUS_PUSH') {
    if (msg.tunnel) applyTunnelState(msg.tunnel);
  }
  if (msg.type === 'TUNNEL_PROGRESS') {
    const startBtn = document.getElementById('btn-start-tunnel');
    if (startBtn && startBtn.disabled) startBtn.textContent = msg.step || 'Starting...';
  }
});

// ── Toggle ───────────────────────────────────────────────────

document.getElementById('main-toggle').addEventListener('change', (e) => {
  const msgType = e.target.checked ? 'RECONNECT' : 'DISCONNECT';
  chrome.runtime.sendMessage({ type: msgType }, () => {
    if (chrome.runtime.lastError) return;
    setTimeout(fetchStatus, 400);
  });
});

// ── Action buttons ───────────────────────────────────────────

document.getElementById('btn-flow').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' }).catch(() => {});
});

document.getElementById('btn-token').addEventListener('click', () => {
  const btn = document.getElementById('btn-token');
  btn.textContent = 'Opening...';
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' }, () => {
    btn.textContent = 'Refresh Token';
    btn.disabled = false;
  });
});

// ── Clear log button ─────────────────────────────────────────

document.getElementById('btn-clear-log').addEventListener('click', () => {
  if (_logEntries.length === 0) return;
  if (!confirm('Clear all log entries?')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_LOG' });
});

// ── Download log ─────────────────────────────────────────────

document.getElementById('btn-download-log').addEventListener('click', () => {
  if (!_logEntries.length) return;
  const blob = new Blob([JSON.stringify(_logEntries, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flowkit-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Log filter pills ─────────────────────────────────────────

document.querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    _logFilter = pill.dataset.filter;
    applyFilters();
  });
});

// ── Log search ───────────────────────────────────────────────

document.getElementById('log-search').addEventListener('input', (e) => {
  _logSearch = e.target.value.trim();
  applyFilters();
});

// ── Client ID copy ───────────────────────────────────────────

document.getElementById('client-id-badge').addEventListener('click', () => {
  if (_localClientId && _localClientId !== '—') {
    navigator.clipboard.writeText(_localClientId).then(() => {
      const el = document.getElementById('client-id-badge');
      el.textContent = 'copied!';
      setTimeout(() => {
        el.textContent = _localClientId.slice(0, 8) + '…';
      }, 1200);
    });
  }
});

// ── Settings button handlers ─────────────────────────────────

document.getElementById('setting-auto-clear').addEventListener('change', saveLogSettings);
document.getElementById('setting-retention').addEventListener('change', saveLogSettings);
document.getElementById('setting-max-entries').addEventListener('change', saveLogSettings);
document.getElementById('setting-persist').addEventListener('change', saveLogSettings);

// ── Client ID save ────────────────────────────────────────────

document.getElementById('btn-save-client-id').addEventListener('click', () => {
  const newId = document.getElementById('settings-client-id-input').value.trim();
  if (!newId) return;
  const btn = document.getElementById('btn-save-client-id');
  btn.textContent = 'Saving...';
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'SAVE_CLIENT_ID', clientId: newId }, (data) => {
    if (data && data.ok) {
      _localClientId = data.clientId || newId;
      const badge = document.getElementById('client-id-badge');
      badge.textContent = _localClientId.slice(0, 8) + '…';
      badge.title = 'Client ID: ' + _localClientId + '\nClick to copy';
      const savedEl = document.getElementById('settings-client-id-saved');
      savedEl.style.display = 'inline-block';
      setTimeout(() => { savedEl.style.display = 'none'; }, 2000);
    }
    btn.textContent = 'Save Client ID';
    btn.disabled = false;
  });
});

// Clipboard still works on badge

// ── Tunnel Connection ─────────────────────────────────────────

document.getElementById('btn-connect-ws').addEventListener('click', () => {
  const host = document.getElementById('tunnel-ws-host').value.trim();
  if (!host) return;
  const btn = document.getElementById('btn-connect-ws');
  btn.textContent = 'Connecting...';
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'RECONNECT', wsHost: host }, () => {
    btn.textContent = 'Connect';
    btn.disabled = false;
  });
});

document.getElementById('btn-disconnect-ws').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT' }, () => {});
});

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Restore last tab
  chrome.storage.local.get(['lastTab'], (res) => {
    if (res.lastTab) switchTab(res.lastTab);
  });

  fetchStatus();
  fetchLog();
  fetchClientId();
  fetchLogSettings();
  fetchConnStatus();
  initTunnel();

  // Periodic refresh
  setInterval(fetchStatus, 3000);
  setInterval(fetchLog, 2000);
  setInterval(fetchConnStatus, 5000);
});

// ═══════════════════════════════════════════════════════════════
// TUNNEL PANEL
// ═══════════════════════════════════════════════════════════════

function initTunnel() {
  chrome.runtime.sendMessage({ type: 'GET_NGROK_SETTINGS' }, (data) => {
    if (chrome.runtime.lastError || !data) return;

    const hasSettings = !!(data.authToken && data.domain);
    if (data.authToken) document.getElementById('ngrok-token').value = data.authToken;
    if (data.domain)    document.getElementById('ngrok-domain').value = data.domain;
    if (data.wsHost && document.getElementById('tunnel-ws-host')) document.getElementById('tunnel-ws-host').value = data.wsHost;

    if (!hasSettings) { openTunnelPanel(); openSettingsForm(); }
    if (hasSettings) document.getElementById('settings-saved-dot').style.display = 'inline-block';

    applyTunnelState({ status: data.tunnelStatus || 'stopped', url: data.tunnelUrl || null });
    if (data.tunnelStatus === 'active') refreshTunnelStatus();
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

  document.getElementById('btn-save-tunnel-settings').addEventListener('click', () => {
    const authToken = document.getElementById('ngrok-token').value.trim();
    let domain      = document.getElementById('ngrok-domain').value.trim();
    if (!authToken || !domain) {
      showTunnelError('Please fill in both Auth Token and Static Domain.');
      return;
    }

    chrome.runtime.sendMessage({ type: 'SAVE_NGROK_SETTINGS', authToken, domain }, () => {
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
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = '📋 Copy URL'; }, 1800);
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
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
      });
    });
  });

  document.getElementById('btn-copy-setup').addEventListener('click', () => {
    const code = document.getElementById('tunnel-setup-code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
      const btn = document.getElementById('btn-copy-setup');
      btn.textContent = '✓';
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
    startBtn.textContent   = '▶ Start Public URL';
    stopBtn.style.display  = 'none';
    urlBox.classList.remove('show');
    errBox.classList.remove('show');
    document.getElementById('tunnel-setup-box').classList.remove('show');
    populateCurls('<YOUR_PUBLIC_URL_HERE>');
    stopTunnelPolling();
  } else if (status === 'error') {
    _currentTunnelUrl = null;
    startBtn.style.display = 'block';
    startBtn.textContent   = '▶ Retry';
    stopBtn.style.display  = 'none';
    urlBox.classList.remove('show');
    populateCurls('<YOUR_PUBLIC_URL_HERE>');
    openTunnelPanel();
    const currentWsHost = (document.getElementById('tunnel-ws-host') || document.createElement('input')).value.trim();
    const isRemote = currentWsHost && !currentWsHost.includes('127.0.0.1');
    if (!isRemote) {
      errBox.textContent = '⚠ ' + (error || 'Unknown error. Is the server running?');
      errBox.classList.add('show');
    }
    const setupBox = document.getElementById('tunnel-setup-box');
    if (!isRemote && result.needsNativeSetup && result.extensionId) {
      const code = document.getElementById('tunnel-setup-code');
      code.textContent = `bash "${chrome.runtime.getManifest().name}-install.sh" "${result.extensionId}"`;
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
  if (_tunnelPollTimer) { clearInterval(_tunnelPollTimer); _tunnelPollTimer = null; }
}

function refreshTunnelStatus() {
  chrome.runtime.sendMessage({ type: 'GET_TUNNEL_STATUS' }, (result) => {
    if (chrome.runtime.lastError || !result) return;
    const badge = document.getElementById('tunnel-badge');
    const currentStatus = badge.className.replace('tunnel-badge ', '').trim();
    if (result.status !== currentStatus) applyTunnelState(result);
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
    '    "client_id": "your-extension-client-id"',
    '  }\'',
    '',
    '# Available Parameters:',
    '# prompt:        (string) Your image prompt',
    '# aspect_ratio:  (string) "16:9" | "9:16" | "1:1" | "4:3"',
    '# image_model:   (string) "NANO_BANANA_PRO" | "NANO_BANANA_2"',
    '# tasker:        (string) "enabled" | "disabled"',
    '# client_id:     (string) Route to a specific browser extension',
  ].join('\n');

  document.getElementById('code-edit-image').textContent = [
    'curl -X POST "' + base + '/api/edit" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{',
    '    "image_url": "https://example.com/your-image.jpg",',
    '    "prompt": "make the sky dramatic with storm clouds",',
    '    "aspect_ratio": "16:9",',
    '    "image_model": "NANO_BANANA_PRO",',
    '    "client_id": "your-extension-client-id"',
    '  }\'',
    '',
    '# Available Parameters:',
    '# image_url:     (string) URL of the image to edit',
    '# prompt:        (string) Your edit prompt',
    '# aspect_ratio:  (string) "16:9" | "9:16" | "1:1" | "4:3"',
    '# image_model:   (string) "NANO_BANANA_PRO" | "NANO_BANANA_2"',
    '# tasker:        (string) "enabled" | "disabled"',
    '# client_id:     (string) Route to a specific browser extension',
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