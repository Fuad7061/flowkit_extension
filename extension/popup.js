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
  GEN_IMG:                  'GEN IMAGE',
  GEN_VID:                  'GEN VIDEO',
  GEN_VID_REF:              'GEN VIDEO FROM REFS',
  UPSCALE:                  'UPSCALE VIDEO',
  TRACKING:                 'TRACKING',
  URL_REFRESH:              'URL REFRESH',
};

function formatType(type) {
  if (!type) return '—';
  return TYPE_LABELS[type] || type.slice(0, 12).toUpperCase();
}

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

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badgeHtml(status) {
  if (status === 'COMPLETED' || status === 'success') {
    return '<span class="badge badge-ok">✓ done</span>';
  } else if (status === 'FAILED' || status === 'failed' || (typeof status === 'number' && status >= 400)) {
    return '<span class="badge badge-fail">✗ fail</span>';
  } else if (status === 'PROCESSING') {
    return '<span class="badge badge-proc">⏳ gen...</span>';
  } else {
    return '<span class="badge badge-proc">⏳ sent</span>';
  }
}

let _logEntries = [];

function renderLog(entries) {
  _logEntries = entries || [];
  applyPopupFilter();
}

function applyPopupFilter() {
  const filter = document.querySelector('.filter-pill.active');
  const f = filter ? filter.dataset.f : 'all';
  let filtered = _logEntries.slice();
  if (f === 'success') filtered = filtered.filter(e => e.status === 'success' || e.status === 'COMPLETED');
  if (f === 'failed') filtered = filtered.filter(e => e.status === 'failed' || e.status === 'FAILED' || (typeof e.status === 'number' && e.status >= 400));
  renderLogList(filtered);
}

function renderLogList(entries) {
  const list = document.getElementById('log-list');
  const countEl = document.getElementById('log-count');

  if (!entries || entries.length === 0) {
    list.innerHTML = '<div class="log-empty">No requests yet</div>';
    countEl.textContent = String(_logEntries.length);
    return;
  }

  countEl.textContent = String(_logEntries.length);

  list.innerHTML = entries.map((entry, i) => {
    const shortId = entry.id ? String(entry.id).slice(0, 8) : '—';
    const type = formatType(entry.type || entry.method);
    const time = formatTime(entry.time || entry.timestamp);
    const status = entry.status || 'pending';
    const error = entry.error || '';

    const urlDisplay = entry.url
      ? `<div class="detail-section">
           <div class="detail-label">URL</div>
           <div class="detail-value url" title="${escHtml(entry.url)}">${escHtml(entry.url)}</div>
         </div>`
      : '';

    const payloadDisplay = entry.payloadSummary || entry.requestBody
      ? `<div class="detail-section">
           <div class="detail-label">Payload</div>
           <div class="detail-value">${escHtml(entry.payloadSummary || entry.requestBody || '')}</div>
         </div>`
      : '';

    const responseDisplay = entry.responseSummary || entry.responseBody
      ? `<div class="detail-section">
           <div class="detail-label">Response${entry.httpStatus ? ` (${entry.httpStatus})` : ''}</div>
           <div class="detail-value">${escHtml(entry.responseSummary || entry.responseBody || '')}</div>
         </div>`
      : '';

    const errorDisplay = error
      ? `<div class="detail-section">
           <div class="detail-label">Error</div>
           <div class="detail-value detail-error">${escHtml(error)}</div>
         </div>`
      : '';

    const hasDetails = entry.url || entry.payloadSummary || entry.requestBody || entry.responseSummary || entry.responseBody || error;

    return `<div class="entry" data-idx="${i}">
      <div class="entry-row">
        <span class="entry-id">${escHtml(shortId)}</span>
        <span class="entry-type">${escHtml(type)}</span>
        <span class="entry-time">${escHtml(time)}</span>
        ${badgeHtml(status)}
        ${hasDetails ? '<span class="expand-icon">▶</span>' : '<span class="expand-icon" style="visibility:hidden">▶</span>'}
      </div>
      ${hasDetails ? `<div class="entry-details">${urlDisplay}${payloadDisplay}${responseDisplay}${errorDisplay}</div>` : ''}
    </div>`;
  }).join('');

  list.querySelectorAll('.entry-row').forEach((row) => {
    row.addEventListener('click', () => {
      const entry = row.closest('.entry');
      if (entry.querySelector('.entry-details')) entry.classList.toggle('open');
    });
  });
}

// ── Side panel button ─────────────────────────────────────────

document.getElementById('btn-panel').addEventListener('click', () => {
  chrome.windows.getCurrent((win) => {
    chrome.sidePanel.open({ windowId: win.id });
  });
});

// ── Clear button ──────────────────────────────────────────────

document.getElementById('btn-clear-log').addEventListener('click', () => {
  if (_logEntries.length === 0) return;
  if (!confirm('Clear all log entries?')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_LOG' });
});

// ── Filter pills ──────────────────────────────────────────────

document.querySelectorAll('.filter-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    applyPopupFilter();
  });
});

// ── Message listener (live updates) ───────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'REQUEST_LOG_UPDATE' && msg.log) renderLog(msg.log);
});

// ── Initial fetch ─────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'REQUEST_LOG' }, (data) => {
  if (chrome.runtime.lastError) return;
  if (data && data.log) renderLog(data.log);
});