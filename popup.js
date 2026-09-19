/* AuScroll — popup UI */
'use strict';

const $ = (id) => document.getElementById(id);
const MATCH = window.AutoScrollMatch;

const DEFAULTS = {
  speed: 250,
  direction: 'down',
  endBehavior: 'loop',
  loopWaitMs: 900,
  autoContainer: true,
  manualPauseMode: 'pause-resume',
  resumeAfterMs: 5000,
  humanize: false,
  jitterPct: 25,
  startPosition: 'current',
  urlWhitelist: []
};

const END_VALUES = ['loop', 'stop', 'continue'];
const MODE_VALUES = ['off', 'pause', 'pause-resume'];
const START_VALUES = ['current', 'top', 'bottom'];

let settings = { ...DEFAULTS, urlWhitelist: [] };
let tabId = null;
let running = false;
let paused = false;
let available = false;

function showWarn(msg, disableToggle) {
  const w = $('warn');
  if (w) { w.textContent = msg; w.classList.remove('hidden'); }
  if (disableToggle) {
    const t = $('toggleBtn');
    if (t) t.disabled = true;
  }
}

function setRunningState(r, p, container) {
  running = !!r;
  paused = !!p;
  const status = $('status');
  const toggle = $('toggleBtn');
  const pauseBtn = $('pauseBtn');

  if (!running) {
    status.textContent = 'Đang dừng';
    status.className = 'status stopped';
    toggle.textContent = '▶ Bật auto scroll';
    toggle.className = 'toggle off';
    pauseBtn.textContent = '⏸ Tạm dừng';
    pauseBtn.disabled = !available;
  } else if (paused) {
    status.textContent =
      settings.manualPauseMode === 'pause-resume' && settings.resumeAfterMs > 0
        ? 'Tạm dừng — sẽ tự chạy lại'
        : 'Đang chạy — tạm dừng';
    status.className = 'status paused';
    toggle.textContent = '■ Dừng';
    toggle.className = 'toggle on';
    pauseBtn.textContent = '▶ Tiếp tục';
    pauseBtn.disabled = !available;
  } else {
    status.textContent = container ? 'Đang chạy • ' + container : 'Đang chạy';
    status.className = 'status running';
    toggle.textContent = '■ Dừng';
    toggle.className = 'toggle on';
    pauseBtn.textContent = '⏸ Tạm dừng';
    pauseBtn.disabled = !available;
  }
}

async function sendCommand(command) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'scroller.command',
      command,
      tabId
    });
    if (res && typeof res === 'object') {
      setRunningState(res.running, res.paused);
      if (!res.running && res.reason) showWarn(res.reason);
    }
  } catch (e) { /* bỏ qua */ }
}

/* ---------------- Hiển thị / lưu cài đặt ---------------- */

function fmtSec(ms) {
  const s = ms / 1000;
  return (Math.round(s * 10) / 10).toString().replace(/\.0$/, '') + 's';
}

function renderSettings() {
  $('speed').value = String(settings.speed);
  $('speedVal').textContent = settings.speed + ' px/giây';

  const dir = document.querySelector('input[name="direction"][value="' + settings.direction + '"]');
  if (dir) dir.checked = true;

  const end = document.querySelector('input[name="end"][value="' + settings.endBehavior + '"]');
  if (end) end.checked = true;

  $('loopWait').value = String(Math.round(settings.loopWaitMs / 100) / 10);
  $('loopWaitVal').textContent = fmtSec(settings.loopWaitMs);

  const mp = document.querySelector('input[name="mpause"][value="' + settings.manualPauseMode + '"]');
  if (mp) mp.checked = true;

  $('resume').value = String(Math.round(settings.resumeAfterMs / 1000));
  $('resumeVal').textContent = fmtSec(settings.resumeAfterMs);

  $('humanize').checked = settings.humanize;
  $('jitter').value = String(settings.jitterPct);
  $('jitterVal').textContent = settings.jitterPct + '%';

  const sp = document.querySelector('input[name="startpos"][value="' + settings.startPosition + '"]');
  if (sp) sp.checked = true;

  $('autoContainer').checked = settings.autoContainer;
}

function saveSettings() {
  try {
    const p = chrome.storage.local.set({ settings });
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

/* ---------------- Whitelist URL ---------------- */

function renderUrlList() {
  const list = $('urlList');
  list.innerHTML = '';
  if (!settings.urlWhitelist.length) {
    const empty = document.createElement('div');
    empty.className = 'urlEmpty';
    empty.textContent = 'Trống — mọi trang đều được cuộn.';
    list.appendChild(empty);
    return;
  }
  settings.urlWhitelist.forEach((entry, i) => {
    const item = document.createElement('div');
    item.className = 'urlItem';
    const span = document.createElement('span');
    span.className = 'urlText';
    span.textContent = MATCH ? MATCH.labelForEntry(entry) : entry;
    span.title = entry;
    const del = document.createElement('button');
    del.className = 'urlDel';
    del.textContent = '✕';
    del.title = 'Xoá';
    del.addEventListener('click', () => {
      settings.urlWhitelist.splice(i, 1);
      saveSettings();
      renderUrlList();
      refreshUrlMatch();
    });
    item.appendChild(span);
    item.appendChild(del);
    list.appendChild(item);
  });
}

function addUrl() {
  const v = $('urlInput').value.trim();
  if (!v) return;
  const norm = v.toLowerCase();
  const exists = settings.urlWhitelist.some((e) => e.toLowerCase() === norm);
  if (!exists) settings.urlWhitelist.push(v);
  $('urlInput').value = '';
  saveSettings();
  renderUrlList();
  refreshUrlMatch();
}

async function refreshUrlMatch() {
  const el = $('urlMatch');
  if (!settings.urlWhitelist.length) {
    el.textContent = '';
    el.className = 'urlMatch';
    return;
  }
  let url = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    url = tabs && tabs[0] ? tabs[0].url : null;
  } catch (e) {}
  if (!url) {
    el.textContent = '⚠ Không kiểm tra được trang hiện tại.';
    el.className = 'urlMatch unknown';
    return;
  }
  let host = '';
  try { host = new URL(url).hostname; } catch (e) {}
  const ok = MATCH ? MATCH.urlAllowed(settings.urlWhitelist, url) : true;
  el.textContent = ok
    ? '✓ Trang hiện tại (' + host + ') được phép cuộn'
    : '✗ Trang hiện tại (' + host + ') KHÔNG được cuộn';
  el.className = 'urlMatch ' + (ok ? 'ok' : 'no');
}

/* ---------------- Khởi động ---------------- */

async function init() {
  try {
    const res = await chrome.storage.local.get(['settings']);
    if (res && res.settings && typeof res.settings === 'object') {
      settings = { ...DEFAULTS, ...res.settings };
    }
  } catch (e) {}
  // migration + bảo vệ kiểu dữ liệu
  settings.speed = Math.min(1000, Math.max(10, Number(settings.speed) || DEFAULTS.speed));
  if (settings.direction !== 'up') settings.direction = 'down';
  if (END_VALUES.indexOf(settings.endBehavior) === -1) {
    settings.endBehavior = settings.loopAtEnd === false ? 'stop' : 'loop';
  }
  if (MODE_VALUES.indexOf(settings.manualPauseMode) === -1) {
    settings.manualPauseMode = settings.pauseOnManualScroll === false ? 'off' : DEFAULTS.manualPauseMode;
  }
  if (START_VALUES.indexOf(settings.startPosition) === -1) settings.startPosition = 'current';
  if (!Array.isArray(settings.urlWhitelist)) settings.urlWhitelist = [];
  renderSettings();
  renderUrlList();

  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
  } catch (e) {}
  tabId = tab ? tab.id : null;

  if (tabId == null) {
    available = false;
    setRunningState(false, false);
    showWarn('Không tìm thấy tab hiện tại.', true);
    return;
  }

  let st = null;
  try {
    st = await chrome.runtime.sendMessage({ type: 'scroller.getTabState', tabId });
  } catch (e) {}

  if (st && st.ok === true) {
    available = true;
    setRunningState(st.running, st.paused, st.container);
  } else {
    available = false;
    setRunningState(false, false);
    showWarn('Trang này không hỗ trợ (brave://, cửa hàng extension, PDF…). Hãy mở một trang web bình thường rồi thử lại.', true);
  }

  refreshUrlMatch();
}

document.addEventListener('DOMContentLoaded', () => {
  $('toggleBtn').addEventListener('click', () => {
    if (!available) return;
    sendCommand(running ? 'stop' : 'start');
  });

  $('pauseBtn').addEventListener('click', () => {
    if (!available || !running) return;
    sendCommand('pause');
  });

  $('speed').addEventListener('input', () => {
    settings.speed = Number($('speed').value) || DEFAULTS.speed;
    $('speedVal').textContent = settings.speed + ' px/giây';
    saveSettings();
  });

  document.querySelectorAll('input[name="direction"]').forEach((r) => {
    r.addEventListener('change', () => { settings.direction = r.value; saveSettings(); });
  });

  document.querySelectorAll('input[name="end"]').forEach((r) => {
    r.addEventListener('change', () => { settings.endBehavior = r.value; saveSettings(); });
  });

  document.querySelectorAll('input[name="mpause"]').forEach((r) => {
    r.addEventListener('change', () => {
      settings.manualPauseMode = r.value;
      saveSettings();
      setRunningState(running, paused);
    });
  });

  $('resume').addEventListener('input', () => {
    settings.resumeAfterMs = Number($('resume').value) * 1000;
    $('resumeVal').textContent = fmtSec(settings.resumeAfterMs);
    saveSettings();
  });

  $('loopWait').addEventListener('input', () => {
    settings.loopWaitMs = Math.round(Number($('loopWait').value) * 1000);
    $('loopWaitVal').textContent = fmtSec(settings.loopWaitMs);
    saveSettings();
  });

  $('humanize').addEventListener('change', () => {
    settings.humanize = $('humanize').checked;
    saveSettings();
  });

  $('jitter').addEventListener('input', () => {
    settings.jitterPct = Number($('jitter').value) || DEFAULTS.jitterPct;
    $('jitterVal').textContent = settings.jitterPct + '%';
    saveSettings();
  });

  document.querySelectorAll('input[name="startpos"]').forEach((r) => {
    r.addEventListener('change', () => { settings.startPosition = r.value; saveSettings(); });
  });

  $('autoContainer').addEventListener('change', () => {
    settings.autoContainer = $('autoContainer').checked;
    saveSettings();
  });

  $('urlAddBtn').addEventListener('click', addUrl);
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addUrl();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'scroller.broadcast') {
      setRunningState(msg.running, msg.paused);
      if (!msg.running && msg.reason) showWarn(msg.reason);
    }
  });

  init();
});
