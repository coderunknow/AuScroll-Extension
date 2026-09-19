/* AuScroll — background service worker (Manifest V3)
 * Nhận phím tắt, relay lệnh tới content script, cập nhật badge.
 * Chỉ tin dữ liệu 'scroller.state' từ content script của chính extension.
 */
'use strict';

const BLOCKED = [
  /^chrome:/i,
  /^chrome-extension:/i,
  /^devtools:/i,
  /^view-source:/i,
  /^edge:/i,
  /^brave:/i,
  /^about:/i,
  /^chrome-search:/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/chromewebstore\.google\.com/i
];

const BADGES = {
  running: { text: '▶', color: '#15803d' },
  paused: { text: 'II', color: '#b45309' },
  stopped: { text: '', color: '#1f2937' }
};

const COMMANDS = { start: 1, stop: 1, pause: 1, toggle: 1 };

function setBadge(running, paused) {
  const b = !running ? BADGES.stopped : (paused ? BADGES.paused : BADGES.running);
  try {
    const p1 = chrome.action.setBadgeText({ text: b.text });
    if (p1 && p1.catch) p1.catch(() => {});
    const p2 = chrome.action.setBadgeBackgroundColor({ color: b.color });
    if (p2 && p2.catch) p2.catch(() => {});
  } catch (e) {}
}

function isBlockedUrl(url) {
  if (!url) return false;
  for (let i = 0; i < BLOCKED.length; i++) {
    if (BLOCKED[i].test(url)) return true;
  }
  return false;
}

// Đảm bảo content script đã nạp trong tab (tự nạp cho các tab mở trước khi cài)
async function ensureContent(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'scroller.ping' });
    return true;
  } catch (e) { /* chưa có content script */ }

  let url = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    url = (tab && tab.url) || '';
  } catch (e) {
    return false; // tab đã đóng
  }
  if (isBlockedUrl(url)) return false;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 80));
    try { await chrome.tabs.sendMessage(tabId, { type: 'scroller.ping' }); } catch (e) {}
    return true;
  } catch (e) {
    return false;
  }
}

async function relay(tabId, msg) {
  if (!(await ensureContent(tabId))) return { ok: false, reason: 'no-content' };
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg);
    if (res && typeof res === 'object') return res;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'no-content' };
  }
}

async function activeTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0].id : null;
  } catch (e) {
    return null;
  }
}

/* Phím tắt: Alt+S bật/tắt, Alt+P tạm dừng/tiếp tục */
chrome.commands.onCommand.addListener(async (command) => {
  const name = command === 'pause-scroll' ? 'pause' : 'toggle';
  const tabId = await activeTabId();
  if (tabId == null) return;
  await relay(tabId, { type: 'scroller.command', command: name });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // Trạng thái từ content script → badge + lưu + broadcast tới popup
  if (msg.type === 'scroller.state') {
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab) return;
    setBadge(!!msg.running, !!msg.paused);
    try {
      const p = chrome.storage.session.set({
        lastState: { running: !!msg.running, paused: !!msg.paused }
      });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    try {
      const p = chrome.runtime.sendMessage({
        type: 'scroller.broadcast',
        running: !!msg.running,
        paused: !!msg.paused,
        reason: msg.reason || ''
      });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    return;
  }

  if (msg.type === 'scroller.getTabState') {
    (async () => {
      const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
      if (tabId == null) { sendResponse({ ok: false, reason: 'no-tab' }); return; }
      const res = await relay(tabId, { type: 'scroller.getState' });
      sendResponse(
        res && res.ok === true && typeof res.running === 'boolean'
          ? res
          : { ok: false, reason: 'no-content' }
      );
    })();
    return true;
  }

  if (msg.type === 'scroller.command') {
    if (!COMMANDS[msg.command]) {
      sendResponse({ ok: false, reason: 'bad-command' });
      return;
    }
    (async () => {
      const tabId = msg.tabId != null ? msg.tabId : await activeTabId();
      if (tabId == null) { sendResponse({ ok: false, reason: 'no-tab' }); return; }
      sendResponse(await relay(tabId, { type: 'scroller.command', command: msg.command }));
    })();
    return true;
  }
});

// Khôi phục badge khi service worker khởi động lại
try {
  chrome.storage.session.get(['lastState'], (res) => {
    if (chrome.runtime.lastError) return;
    const s = res && res.lastState;
    if (s && s.running) setBadge(s.running, s.paused);
  });
} catch (e) {}
