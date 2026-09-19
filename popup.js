/* AuScroll — popup UI (v1.1)
 * Conditional UI: mỗi nhóm tuỳ chọn chỉ hiện khi liên quan đến cài đặt hiện tại.
 * Hỗ trợ cấu hình riêng theo trang (profiles) + thống kê cục bộ.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const MATCH = window.AutoScrollMatch;

const DEFAULTS = {
  speed: 250,
  direction: 'down',
  endBehavior: 'loop',
  loopWaitMs: 900,
  continueWaitMs: 15000,
  continueIndefinite: false,
  autoContainer: true,
  manualPauseMode: 'pause-resume',
  pauseTriggers: { wheel: true, touch: true, click: false, keys: true },
  resumeAfterMs: 5000,
  humanize: false,
  jitterPct: 25,
  stepMode: false,
  stepPx: 300,
  stepIntervalMs: 2000,
  stepEasing: 'smooth',
  durationMin: 0,
  startPosition: 'current',
  autoStart: false,
  resumeAfterReload: false,
  startDelayMaxMs: 0,
  maxLoops: 0,
  pauseOnVideo: false,
  hudShow: true,
  statsEnabled: true,
  urlWhitelist: [],
  profiles: {}
};

// Những key có thể cấu hình RIÊNG theo trang
const PROFILE_KEYS = [
  'speed', 'direction', 'endBehavior', 'loopWaitMs', 'continueWaitMs', 'continueIndefinite',
  'manualPauseMode', 'pauseTriggers', 'resumeAfterMs', 'humanize', 'jitterPct',
  'stepMode', 'stepPx', 'stepIntervalMs', 'stepEasing', 'durationMin', 'pauseOnVideo',
  'hudShow', 'statsEnabled', 'startDelayMaxMs', 'maxLoops', 'startPosition'
];

const END_VALUES = ['loop', 'stop', 'continue'];
const MODE_VALUES = ['off', 'pause', 'pause-resume'];
const START_VALUES = ['current', 'top', 'bottom'];
const EASE_VALUES = ['linear', 'smooth'];

let settings = JSON.parse(JSON.stringify(DEFAULTS));
let tabId = null;
let host = '';
let running = false;
let paused = false;
let waiting = false;
let starting = false;
let videoPaused = false;
let available = false;
let resetArmed = false;
let resetTimerId = null;

function showWarn(msg, disableToggle) {
  const w = $('warn');
  if (w) { w.textContent = msg; w.classList.remove('hidden'); }
  if (disableToggle) {
    const t = $('toggleBtn');
    if (t) t.disabled = true;
  }
}

function cfgMsg(text) {
  const el = $('cfgMsg');
  if (el) el.textContent = text || '';
}

/* ---------------- site profiles ---------------- */

function siteOn() {
  return !!(host && settings.profiles && Object.prototype.hasOwnProperty.call(settings.profiles, host));
}

function effView() {
  if (!siteOn()) return settings;
  return Object.assign({}, settings, settings.profiles[host]);
}

function getVal(key) {
  const v = effView()[key];
  return v === undefined ? JSON.parse(JSON.stringify(DEFAULTS[key])) : v;
}

function setVal(key, value) {
  if (siteOn() && PROFILE_KEYS.indexOf(key) !== -1) {
    settings.profiles[host][key] = value;
  } else {
    settings[key] = value;
  }
}

/* ---------------- trạng thái ---------------- */

function setRunningState(r, p, container, isWaiting, isStarting, vidPaused) {
  running = !!r;
  paused = !!p;
  waiting = !!isWaiting;
  starting = !!isStarting;
  videoPaused = !!vidPaused;
  const status = $('status');
  const toggle = $('toggleBtn');
  const pauseBtn = $('pauseBtn');

  if (!running && !starting) {
    status.textContent = 'Đang dừng';
    status.className = 'status stopped';
    toggle.textContent = '▶ Bật auto scroll';
    toggle.className = 'toggle off';
    pauseBtn.textContent = '⏸ Tạm dừng';
    pauseBtn.disabled = !available;
    $('substatus').classList.add('hidden');
    $('quick').classList.add('hidden');
    return;
  }

  toggle.textContent = '■ Dừng';
  toggle.className = 'toggle on';
  pauseBtn.disabled = !available;

  if (starting) {
    status.textContent = '⏲ Sẽ bắt đầu ngay…';
    status.className = 'status waiting';
    pauseBtn.textContent = '⏸ Tạm dừng';
  } else if (paused) {
    status.textContent = videoPaused ? '⏸ Video đang phát' : 'Tạm dừng';
    status.className = 'status paused';
    pauseBtn.textContent = '▶ Tiếp tục';
  } else if (waiting) {
    status.textContent = '⏳ Đang chờ nội dung mới…';
    status.className = 'status waiting';
    pauseBtn.textContent = '⏸ Tạm dừng';
  } else {
    status.textContent = container ? 'Đang chạy • ' + container : 'Đang chạy';
    status.className = 'status running';
    pauseBtn.textContent = '⏸ Tạm dừng';
  }

  $('quick').classList.toggle('hidden', !waiting);
}

function setSubStatus(text) {
  const el = $('substatus');
  if (!el) return;
  if (text) {
    el.textContent = text;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
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
      setRunningState(res.running, res.paused, undefined, res.waiting, res.starting);
      if (!res.running && res.reason) {
        showWarn(res.reason);
        setSubStatus(res.reason);
      }
    }
  } catch (e) { /* bỏ qua */ }
}

/* ---------------- Conditional UI ---------------- */

function refreshCond() {
  const eff = effView();
  const show = (el, cond) => { if (el) el.classList.toggle('hidden', !cond); };
  show($('continueOpts'), eff.endBehavior === 'continue');
  show($('trigWrap'), eff.manualPauseMode !== 'off');
  show($('resumeWrap'), eff.manualPauseMode === 'pause-resume');
  show($('maxLoopsWrap'), eff.endBehavior === 'loop');
  show($('stepOpts'), eff.stepMode);
  show($('jitterWrap'), eff.humanize);
  show($('siteBanner'), siteOn());
  $('siteHost').textContent = host || 'trang này';
}

/* ---------------- hiển thị / lưu cài đặt ---------------- */

function fmtSec(ms) {
  const s = ms / 1000;
  return (Math.round(s * 10) / 10).toString().replace(/\.0$/, '') + 's';
}

function fmtDur(min) {
  if (!min) return 'Tắt';
  if (min < 60) return min + ' phút';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + 'h' + m + 'p' : h + ' giờ';
}

function fmtMs(ms) {
  if (!ms) return 'Tắt';
  return (ms / 1000) + 's';
}

function renderSettings() {
  const eff = effView();
  $('speed').value = String(eff.speed);
  $('speedVal').textContent = eff.speed + ' px/giây';

  const dir = document.querySelector('input[name="direction"][value="' + eff.direction + '"]');
  if (dir) dir.checked = true;

  const end = document.querySelector('input[name="end"][value="' + eff.endBehavior + '"]');
  if (end) end.checked = true;

  $('cwait').value = String(Math.round(eff.continueWaitMs / 1000));
  $('cwaitVal').textContent = fmtSec(eff.continueWaitMs);
  $('cwaitInf').checked = !!eff.continueIndefinite;

  $('loopWait').value = String(Math.round(eff.loopWaitMs / 100) / 10);
  $('loopWaitVal').textContent = fmtSec(eff.loopWaitMs);

  $('maxLoops').value = String(eff.maxLoops || 0);
  $('maxLoopsVal').textContent = eff.maxLoops > 0 ? eff.maxLoops + ' vòng' : 'Vô hạn';

  const mp = document.querySelector('input[name="mpause"][value="' + eff.manualPauseMode + '"]');
  if (mp) mp.checked = true;

  const tr = eff.pauseTriggers || DEFAULTS.pauseTriggers;
  $('trigWheel').checked = !!tr.wheel;
  $('trigTouch').checked = !!tr.touch;
  $('trigClick').checked = !!tr.click;
  $('trigKeys').checked = !!tr.keys;

  $('resume').value = String(Math.round(eff.resumeAfterMs / 1000));
  $('resumeVal').textContent = fmtSec(eff.resumeAfterMs);

  $('stepMode').checked = !!eff.stepMode;
  $('stepPx').value = String(eff.stepPx);
  $('stepPxVal').textContent = eff.stepPx + ' px';
  $('stepInt').value = String(Math.round(eff.stepIntervalMs / 500) / 2);
  $('stepIntVal').textContent = fmtSec(eff.stepIntervalMs);
  const se = document.querySelector('input[name="stepease"][value="' + (eff.stepEasing || 'smooth') + '"]');
  if (se) se.checked = true;

  $('dur').value = String(eff.durationMin || 0);
  $('durVal').textContent = fmtDur(eff.durationMin || 0);

  $('humanize').checked = !!eff.humanize;
  $('jitter').value = String(eff.jitterPct);
  $('jitterVal').textContent = eff.jitterPct + '%';
  $('sd').value = String(eff.startDelayMaxMs || 0);
  $('sdVal').textContent = fmtMs(eff.startDelayMaxMs || 0);

  $('pauseOnVideo').checked = !!eff.pauseOnVideo;
  $('hudShow').checked = !!eff.hudShow;
  $('statsEnabled').checked = !!eff.statsEnabled;

  const sp = document.querySelector('input[name="startpos"][value="' + eff.startPosition + '"]');
  if (sp) sp.checked = true;

  $('autoStart').checked = !!eff.autoStart;
  $('resumeReload').checked = !!eff.resumeAfterReload;
  $('autoContainer').checked = eff.autoContainer !== false;
  $('siteSpecific').checked = siteOn();
}

function saveSettings() {
  try {
    const p = chrome.storage.local.set({ settings });
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

// Sau MỌI thay đổi: lưu + vẽ lại UI điều kiện
function changed() {
  saveSettings();
  renderSettings();
  refreshCond();
}

/* ---------------- xuất / nhập / đặt lại ---------------- */

function exportSettings() {
  try {
    const data = JSON.stringify(settings, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'auscroll-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    cfgMsg('✓ Đã xuất auscroll-settings.json');
  } catch (e) {
    cfgMsg('✗ Không xuất được: ' + e.message);
  }
}

function importSettings(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('file không phải object cài đặt');
      }
      settings = applySanitize(parsed);
      saveSettings();
      renderSettings();
      renderUrlList();
      refreshUrlMatch();
      refreshCond();
      cfgMsg('✓ Đã nhập cấu hình từ ' + file.name);
    } catch (e) {
      cfgMsg('✗ File không hợp lệ: ' + e.message);
    }
  };
  reader.onerror = () => cfgMsg('✗ Không đọc được file');
  reader.readAsText(file);
}

function resetSettings() {
  if (!resetArmed) {
    resetArmed = true;
    $('resetBtn').textContent = 'Chắc chắn?';
    resetTimerId = setTimeout(() => {
      resetArmed = false;
      $('resetBtn').textContent = '↺ Đặt lại';
    }, 3000);
    return;
  }
  clearTimeout(resetTimerId);
  resetArmed = false;
  $('resetBtn').textContent = '↺ Đặt lại';
  settings = JSON.parse(JSON.stringify(DEFAULTS));
  saveSettings();
  renderSettings();
  renderUrlList();
  refreshUrlMatch();
  refreshCond();
  cfgMsg('✓ Đã đặt lại toàn bộ về mặc định');
}

/* ---------------- khớp kiểu + giới hạn (mirror của sanitize bên content) ------- */

function applySanitize(s) {
  const src = s && typeof s === 'object' ? s : {};
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  out.speed = Math.min(1000, Math.max(10, Number(src.speed) || DEFAULTS.speed));
  out.direction = src.direction === 'up' ? 'up' : 'down';
  out.endBehavior = END_VALUES.indexOf(src.endBehavior) !== -1 ? src.endBehavior
    : (src.loopAtEnd === false ? 'stop' : 'loop');
  out.loopWaitMs = Math.min(10000, Math.max(300, Number(src.loopWaitMs) || DEFAULTS.loopWaitMs));
  out.continueWaitMs = Math.min(120000, Math.max(1000, Number(src.continueWaitMs) || DEFAULTS.continueWaitMs));
  out.continueIndefinite = !!src.continueIndefinite;
  out.autoContainer = src.autoContainer !== false;
  out.manualPauseMode = MODE_VALUES.indexOf(src.manualPauseMode) !== -1 ? src.manualPauseMode
    : (src.pauseOnManualScroll === false ? 'off' : DEFAULTS.manualPauseMode);
  const tr = src.pauseTriggers;
  if (tr && typeof tr === 'object') {
    out.pauseTriggers = {
      wheel: tr.wheel !== false,
      touch: tr.touch !== false,
      click: tr.click === true,
      keys: tr.keys !== false
    };
  }
  out.resumeAfterMs = Math.min(120000, Math.max(0, Number(src.resumeAfterMs) || DEFAULTS.resumeAfterMs));
  out.humanize = !!src.humanize;
  out.jitterPct = Math.min(80, Math.max(0, Number(src.jitterPct) || DEFAULTS.jitterPct));
  out.stepMode = !!src.stepMode;
  out.stepPx = Math.min(1000, Math.max(50, Number(src.stepPx) || DEFAULTS.stepPx));
  out.stepIntervalMs = Math.min(10000, Math.max(500, Number(src.stepIntervalMs) || DEFAULTS.stepIntervalMs));
  out.stepEasing = EASE_VALUES.indexOf(src.stepEasing) !== -1 ? src.stepEasing : DEFAULTS.stepEasing;
  const d = Number(src.durationMin);
  out.durationMin = !isFinite(d) || d < 0 ? 0 : Math.min(240, d);
  out.startPosition = START_VALUES.indexOf(src.startPosition) !== -1 ? src.startPosition : 'current';
  out.autoStart = !!src.autoStart;
  out.resumeAfterReload = !!src.resumeAfterReload;
  const sd = Number(src.startDelayMaxMs);
  out.startDelayMaxMs = !isFinite(sd) || sd < 0 ? 0 : Math.min(5000, sd);
  const ml = Number(src.maxLoops);
  out.maxLoops = !isFinite(ml) || ml < 0 ? 0 : Math.min(50, Math.round(ml));
  out.pauseOnVideo = !!src.pauseOnVideo;
  out.hudShow = !!src.hudShow;
  out.statsEnabled = !!src.statsEnabled;
  out.urlWhitelist = Array.isArray(src.urlWhitelist)
    ? src.urlWhitelist.map((x) => String(x).trim()).filter(Boolean)
    : [];
  if (src.profiles && typeof src.profiles === 'object' && !Array.isArray(src.profiles)) {
    out.profiles = src.profiles;
  }
  return out;
}

/* ---------------- whitelist URL ---------------- */

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
      changed();
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
  changed();
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
  let hostName = '';
  try { hostName = new URL(url).hostname; } catch (e) {}
  const ok = MATCH ? MATCH.urlAllowed(settings.urlWhitelist, url) : true;
  el.textContent = ok
    ? '✓ Trang hiện tại (' + hostName + ') được phép cuộn'
    : '✗ Trang hiện tại (' + hostName + ') KHÔNG được cuộn';
  el.className = 'urlMatch ' + (ok ? 'ok' : 'no');
}

/* ---------------- thống kê ---------------- */

function fmtPx(px) {
  if (px >= 1000000) return (px / 1000000).toFixed(1) + 'M px';
  if (px >= 1000) return (px / 1000).toFixed(1) + 'k px';
  return Math.round(px) + ' px';
}

function fmtStatMs(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec >= 3600) return Math.floor(totalSec / 3600) + 'h' + Math.round((totalSec % 3600) / 60) + 'p';
  if (totalSec >= 60) return Math.floor(totalSec / 60) + 'p' + (totalSec % 60) + 's';
  return totalSec + 's';
}

async function refreshStats() {
  const el = $('statsLine');
  if (!getVal('statsEnabled')) { el.classList.add('hidden'); return; }
  let stats = null;
  try {
    const res = await chrome.storage.local.get(['stats']);
    stats = res && res.stats;
  } catch (e) {}
  if (!stats || !stats.px) {
    el.textContent = 'Chưa có thống kê — hãy bật auto scroll thử.';
  } else {
    el.textContent = '📊 Đã cuộn ' + fmtPx(stats.px) + ' · ' + fmtStatMs(stats.ms || 0) + ' (tổng trên máy này)';
  }
  el.classList.remove('hidden');
}

/* ---------------- khởi động ---------------- */

async function init() {
  try {
    const res = await chrome.storage.local.get(['settings']);
    if (res && res.settings && typeof res.settings === 'object') {
      settings = applySanitize(res.settings);
    }
  } catch (e) {}
  if (!settings.profiles || typeof settings.profiles !== 'object') settings.profiles = {};
  renderSettings();
  renderUrlList();
  refreshCond();

  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
  } catch (e) {}
  tabId = tab ? tab.id : null;
  try { host = tab && tab.url ? new URL(tab.url).hostname : ''; } catch (e) { host = ''; }
  renderSettings();
  refreshCond();

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
    setRunningState(st.running, st.paused, st.container, st.waiting, st.starting);
    if (typeof st.speed === 'number' && st.speed !== getVal('speed')) {
      setVal('speed', st.speed);
      renderSettings();
    }
  } else {
    available = false;
    setRunningState(false, false);
    showWarn('Trang này không hỗ trợ (brave://, cửa hàng extension, PDF…). Hãy mở một trang web bình thường rồi thử lại.', true);
  }

  refreshUrlMatch();
  refreshStats();
}

document.addEventListener('DOMContentLoaded', () => {
  $('toggleBtn').addEventListener('click', () => {
    if (!available) return;
    sendCommand((running || starting) ? 'stop' : 'start');
  });

  $('pauseBtn').addEventListener('click', () => {
    if (!available || !running) return;
    sendCommand('pause');
  });

  $('skipWaitBtn').addEventListener('click', () => sendCommand('skipwait'));
  $('quickStopBtn').addEventListener('click', () => sendCommand('stop'));

  /* --- site profile --- */
  $('siteSpecific').addEventListener('change', () => {
    if (!host) return;
    if ($('siteSpecific').checked) {
      const eff = effView();
      const prof = {};
      PROFILE_KEYS.forEach((k) => {
        if (k === 'pauseTriggers') prof[k] = { ...(eff.pauseTriggers || DEFAULTS.pauseTriggers) };
        else prof[k] = eff[k];
      });
      settings.profiles[host] = prof;
    } else {
      delete settings.profiles[host];
    }
    changed();
  });

  /* --- tốc độ + hướng --- */
  $('speed').addEventListener('input', () => {
    setVal('speed', Number($('speed').value) || DEFAULTS.speed);
    $('speedVal').textContent = getVal('speed') + ' px/giây';
    saveSettings();
  });

  document.querySelectorAll('input[name="direction"]').forEach((r) => {
    r.addEventListener('change', () => { setVal('direction', r.value); changed(); });
  });

  /* --- khi tới cuối trang --- */
  document.querySelectorAll('input[name="end"]').forEach((r) => {
    r.addEventListener('change', () => { setVal('endBehavior', r.value); changed(); });
  });

  $('cwait').addEventListener('input', () => {
    setVal('continueWaitMs', Number($('cwait').value) * 1000);
    $('cwaitVal').textContent = fmtSec(getVal('continueWaitMs'));
    saveSettings();
  });

  $('cwaitInf').addEventListener('change', () => {
    setVal('continueIndefinite', $('cwaitInf').checked);
    changed();
  });

  /* --- nâng cao: pause tay --- */
  document.querySelectorAll('input[name="mpause"]').forEach((r) => {
    r.addEventListener('change', () => {
      setVal('manualPauseMode', r.value);
      changed();
      setRunningState(running, paused, undefined, waiting, starting, videoPaused);
    });
  });

  [['trigWheel', 'wheel'], ['trigTouch', 'touch'], ['trigClick', 'click'], ['trigKeys', 'keys']].forEach(([id, key]) => {
    $(id).addEventListener('change', () => {
      const tr = { ...(getVal('pauseTriggers') || DEFAULTS.pauseTriggers) };
      tr[key] = $(id).checked;
      setVal('pauseTriggers', tr);
      changed();
    });
  });

  $('resume').addEventListener('input', () => {
    setVal('resumeAfterMs', Number($('resume').value) * 1000);
    $('resumeVal').textContent = fmtSec(getVal('resumeAfterMs'));
    saveSettings();
  });

  /* --- loop --- */
  $('loopWait').addEventListener('input', () => {
    setVal('loopWaitMs', Math.round(Number($('loopWait').value) * 1000));
    $('loopWaitVal').textContent = fmtSec(getVal('loopWaitMs'));
    saveSettings();
  });

  $('maxLoops').addEventListener('input', () => {
    setVal('maxLoops', Number($('maxLoops').value) || 0);
    const v = getVal('maxLoops');
    $('maxLoopsVal').textContent = v > 0 ? v + ' vòng' : 'Vô hạn';
    saveSettings();
  });

  /* --- step mode --- */
  $('stepMode').addEventListener('change', () => {
    setVal('stepMode', $('stepMode').checked);
    changed();
  });

  $('stepPx').addEventListener('input', () => {
    setVal('stepPx', Number($('stepPx').value) || DEFAULTS.stepPx);
    $('stepPxVal').textContent = getVal('stepPx') + ' px';
    saveSettings();
  });

  $('stepInt').addEventListener('input', () => {
    setVal('stepIntervalMs', Math.round(Number($('stepInt').value) * 1000));
    $('stepIntVal').textContent = fmtSec(getVal('stepIntervalMs'));
    saveSettings();
  });

  document.querySelectorAll('input[name="stepease"]').forEach((r) => {
    r.addEventListener('change', () => { setVal('stepEasing', r.value); changed(); });
  });

  /* --- hẹn giờ --- */
  $('dur').addEventListener('input', () => {
    setVal('durationMin', Number($('dur').value) || 0);
    $('durVal').textContent = fmtDur(getVal('durationMin'));
    saveSettings();
  });

  /* --- humanize --- */
  $('humanize').addEventListener('change', () => {
    setVal('humanize', $('humanize').checked);
    changed();
  });

  $('jitter').addEventListener('input', () => {
    setVal('jitterPct', Number($('jitter').value) || DEFAULTS.jitterPct);
    $('jitterVal').textContent = getVal('jitterPct') + '%';
    saveSettings();
  });

  $('sd').addEventListener('input', () => {
    setVal('startDelayMaxMs', Number($('sd').value) || 0);
    $('sdVal').textContent = fmtMs(getVal('startDelayMaxMs'));
    saveSettings();
  });

  /* --- tính năng thêm --- */
  $('pauseOnVideo').addEventListener('change', () => {
    setVal('pauseOnVideo', $('pauseOnVideo').checked);
    changed();
  });

  $('hudShow').addEventListener('change', () => {
    setVal('hudShow', $('hudShow').checked);
    changed();
  });

  $('statsEnabled').addEventListener('change', () => {
    setVal('statsEnabled', $('statsEnabled').checked);
    changed();
    refreshStats();
  });

  document.querySelectorAll('input[name="startpos"]').forEach((r) => {
    r.addEventListener('change', () => { setVal('startPosition', r.value); changed(); });
  });

  $('autoStart').addEventListener('change', () => {
    setVal('autoStart', $('autoStart').checked);
    changed();
  });

  $('resumeReload').addEventListener('change', () => {
    setVal('resumeAfterReload', $('resumeReload').checked);
    changed();
  });

  $('autoContainer').addEventListener('change', () => {
    setVal('autoContainer', $('autoContainer').checked);
    changed();
  });

  /* --- backup --- */
  $('exportBtn').addEventListener('click', exportSettings);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', () => {
    const f = $('importFile').files && $('importFile').files[0];
    if (f) importSettings(f);
    $('importFile').value = '';
  });
  $('resetBtn').addEventListener('click', resetSettings);

  /* --- whitelist --- */
  $('urlAddBtn').addEventListener('click', addUrl);
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addUrl();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'scroller.broadcast') {
      setRunningState(msg.running, msg.paused, undefined, msg.waiting, msg.starting, msg.videoPaused);
      if (typeof msg.speed === 'number' && msg.speed !== getVal('speed')) {
        setVal('speed', msg.speed);
        $('speed').value = String(msg.speed);
        $('speedVal').textContent = msg.speed + ' px/giây';
      }
      if (!msg.running && msg.reason) {
        showWarn(msg.reason);
        setSubStatus(msg.reason);
      } else if (msg.waiting) {
        setSubStatus('Trang đã hết nội dung — sẽ tự cuộn tiếp khi trang tải thêm (AI stream, feed vô hạn). Bấm "Cuộn tiếp ngay" nếu bạn muốn ép cuộn.');
      } else {
        setSubStatus('');
      }
      refreshStats();
    }
  });

  init();
});
