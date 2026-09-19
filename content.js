/* AuScroll — content script (Manifest V3)
 *
 * Vòng lặp cuộn chạy bằng requestAnimationFrame + dt (độc lập tần số khung hình),
 * tự chọn đối tượng cuộn: khung feed còn chỗ cuộn dưới chuột → khung chính giữa
 * màn hình → cả trang. "endBehavior: continue" leo cấp từ feed lên cả trang.
 */
(() => {
  'use strict';

  if (window.__auScrollLoaded) return;
  window.__auScrollLoaded = true;

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const DEFAULTS = Object.freeze({
    speed: 250,                     // px/giây
    direction: 'down',              // 'down' | 'up'
    endBehavior: 'loop',            // 'loop' | 'stop' | 'continue'
    loopWaitMs: 900,                // dừng ở cuối bao lâu trước khi quay đầu (loop)
    autoContainer: true,            // tự nhận khung cuộn nội bộ
    manualPauseMode: 'pause-resume',// 'off' | 'pause' | 'pause-resume'
    resumeAfterMs: 5000,            // auto-resume sau bao lâu (pause-resume)
    humanize: false,                // tốc độ ngẫu nhiên (giống người thật)
    jitterPct: 25,                  // biến thiên ±%
    startPosition: 'current',       // 'current' | 'top' | 'bottom'
    urlWhitelist: []                // trống = mọi trang
  });

  const SCAN_LIMIT = 15000;        // không quét DOM lớn hơn
  const SCAN_STYLE_BUDGET = 3000;  // tối đa lần getComputedStyle mỗi lần quét
  const CACHE_TTL = 1000;          // ms — cache khung cuộn
  const MIN_ROOM = 150;            // khung cuộn phải còn ≥150px chỗ cuộn theo hướng
  const FACTOR_MS = 700;           // chu kỳ rút lại hệ số tốc độ ngẫu nhiên
  const EMPTY_MS = 1500;           // trang không cuộn được liên tục bao lâu → tự dừng

  let settings = { ...DEFAULTS };
  let running = false;
  let paused = false;
  let atEnd = false;
  let level = 'auto';              // 'auto' | 'window' (sau khi "continue" leo cấp)
  let rafId = null;
  let lastTime = 0;
  let resetTimer = null;
  let resumeTimer = null;
  let factorTimer = null;
  let speedFactor = 1;
  let mouse = null;
  let cache = { el: null, at: 0 };
  let emptySince = 0;

  /* ---------------- Cài đặt (kèm migration từ các bản cũ) ---------------- */

  function sanitize(s) {
    const src = s && typeof s === 'object' ? s : {};
    const wl = Array.isArray(src.urlWhitelist) ? src.urlWhitelist : [];

    let end = src.endBehavior;
    if (end !== 'loop' && end !== 'stop' && end !== 'continue') {
      end = src.loopAtEnd === false ? 'stop' : 'loop'; // migration v1.x dev
    }
    let mode = src.manualPauseMode;
    if (mode !== 'off' && mode !== 'pause' && mode !== 'pause-resume') {
      mode = src.pauseOnManualScroll === false ? 'off' : DEFAULTS.manualPauseMode;
    }
    let sp = src.startPosition;
    if (sp !== 'top' && sp !== 'bottom') sp = DEFAULTS.startPosition;

    return {
      speed: Math.min(2000, Math.max(10, Number(src.speed) || DEFAULTS.speed)),
      direction: src.direction === 'up' ? 'up' : 'down',
      endBehavior: end,
      loopWaitMs: Math.min(10000, Math.max(300, Number(src.loopWaitMs) || DEFAULTS.loopWaitMs)),
      autoContainer: src.autoContainer !== false,
      manualPauseMode: mode,
      resumeAfterMs: Math.min(120000, Math.max(0, Number(src.resumeAfterMs) || DEFAULTS.resumeAfterMs)),
      humanize: !!src.humanize,
      jitterPct: Math.min(80, Math.max(0, Number(src.jitterPct) || DEFAULTS.jitterPct)),
      startPosition: sp,
      urlWhitelist: wl.map((x) => String(x).trim()).filter(Boolean)
    };
  }

  function applyStored(s) {
    const next = sanitize(s);
    const dirChanged = next.direction !== settings.direction;
    const endChanged = next.endBehavior !== settings.endBehavior;
    settings = next;
    if ((dirChanged || endChanged) && atEnd) atEnd = false;
    if (dirChanged) level = 'auto'; // hướng mới → đánh giá lại khung cuộn
    if (!settings.humanize) speedFactor = 1;
    if (running && !pageAllowed()) stop('Trang không còn trong danh sách cho phép');
  }

  try {
    chrome.storage.local.get(['settings'], (res) => {
      if (chrome.runtime.lastError) return;
      applyStored(res && res.settings);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings && changes.settings.newValue) {
        applyStored(changes.settings.newValue);
      }
    });
  } catch (e) { /* storage không khả dụng — dùng default */ }

  /* ---------------- Whitelist URL ---------------- */

  function pageAllowed() {
    const wl = settings.urlWhitelist;
    if (!Array.isArray(wl) || wl.length === 0) return true;
    const M = window.AutoScrollMatch;
    if (!M) return true;
    let href = '';
    try { href = location.href; } catch (e) { return true; }
    return M.urlAllowed(wl, href);
  }

  /* ---------------- Tốc độ ngẫu nhiên (humanize) ---------------- */

  function refreshSpeedFactor() {
    if (!settings.humanize) { speedFactor = 1; return; }
    const j = settings.jitterPct / 100;
    speedFactor = Math.min(1.8, Math.max(0.2, 1 + (Math.random() * 2 - 1) * j));
  }

  function startFactorTimer() {
    if (factorTimer) clearInterval(factorTimer);
    refreshSpeedFactor();
    factorTimer = setInterval(refreshSpeedFactor, FACTOR_MS);
  }

  function stopFactorTimer() {
    if (factorTimer) { clearInterval(factorTimer); factorTimer = null; }
    speedFactor = 1;
  }

  /* ---------------- Đối tượng cuộn ---------------- */

  function docEl() {
    return document.scrollingElement || document.documentElement;
  }

  function windowTarget() {
    return {
      isEl: false,
      el: null,
      label: 'Toàn trang',
      getPos: () => docEl().scrollTop || window.scrollY || 0,
      getMax: () => Math.max(0, docEl().scrollHeight - window.innerHeight),
      step: (d) => window.scrollBy({ top: d, behavior: 'auto' }),
      jump: (v) => window.scrollTo({ top: v, behavior: 'auto' })
    };
  }

  function elTarget(el) {
    let label = el.tagName ? el.tagName.toLowerCase() : 'element';
    if (el.id) {
      label = '#' + String(el.id).slice(0, 24);
    } else if (typeof el.className === 'string' && el.className.trim()) {
      label = '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.').slice(0, 28);
    }
    return {
      isEl: true,
      el,
      label,
      getPos: () => el.scrollTop || 0,
      getMax: () => Math.max(0, el.scrollHeight - el.clientHeight),
      step: (d) => { el.scrollTop += d; },
      jump: (v) => { el.scrollTop = v; }
    };
  }

  // Chặn bug "dừng giữa chừng": element phải CÒN CHỖ CUỘN theo hướng đang chạy
  function hasRoom(el) {
    const max = el.scrollHeight - el.clientHeight;
    if (max < MIN_ROOM) return false;
    const pos = el.scrollTop || 0;
    return settings.direction === 'down' ? pos < max - 1 : pos > 1;
  }

  function isScrollableStyle(el) {
    let st;
    try { st = getComputedStyle(el); } catch (e) { return false; }
    const oy = st.overflowY;
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
  }

  // Quét DOM: khung cuộn LỚN NHẤT chứa điểm giữa màn hình, còn chỗ cuộn.
  // Ngưng sớm nếu DOM quá lớn hoặc vượt ngân sách getComputedStyle (tránh jank).
  function scanMainContainer() {
    const all = document.getElementsByTagName('*');
    if (all.length > SCAN_LIMIT) return null;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let best = null;
    let bestArea = 0;
    let styled = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el || el.nodeType !== 1) continue;
      if (el === document.documentElement || el === document.body) continue;
      if (el.scrollHeight <= el.clientHeight + 2) continue; // pre-filter rẻ
      if (++styled > SCAN_STYLE_BUDGET) break;
      if (!isScrollableStyle(el)) continue;
      if (!hasRoom(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 120) continue;
      if (!(rect.left <= cx && rect.right >= cx && rect.top <= cy && rect.bottom >= cy)) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  // Ưu tiên 1: khung cuộn DƯỚI chuột (còn chỗ cuộn, đủ lớn)
  // Ưu tiên 2: khung cuộn chính ở giữa màn hình (còn chỗ cuộn)
  // Còn lại: cuộn cả trang (window)
  function findContainer() {
    if (!settings.autoContainer || level !== 'auto') return null;
    const now = performance.now();
    if (cache.el && now - cache.at < CACHE_TTL &&
        document.contains(cache.el) &&
        cache.el.scrollHeight - cache.el.clientHeight >= MIN_ROOM &&
        hasRoom(cache.el)) {
      return cache.el;
    }
    let found = null;
    if (mouse && document.elementFromPoint) {
      try {
        let cur = document.elementFromPoint(mouse.x, mouse.y);
        while (cur && cur !== document.documentElement) {
          if (cur.nodeType === 1 &&
              cur !== document.body &&
              cur.scrollHeight > cur.clientHeight + 2 &&
              isScrollableStyle(cur) && hasRoom(cur)) {
            found = cur;
            break;
          }
          cur = cur.parentElement;
        }
      } catch (e) {}
    }
    if (!found) found = scanMainContainer();
    cache = { el: found, at: now };
    return found;
  }

  function pickTarget() {
    const el = findContainer();
    if (el) {
      const t = elTarget(el);
      if (t.getMax() > 1) return t;
      cache = { el: null, at: 0 }; // hết chỗ bất ngờ (layout đổi) → thả bỏ
    }
    return windowTarget();
  }

  /* ---------------- Vòng lặp cuộn ---------------- */

  function stopRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function ensureRaf() {
    if (!rafId && running && !paused) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  function handleReached(t) {
    // "continue": feed hết chỗ → leo cấp lên cuộn cả trang
    if (t.isEl && settings.endBehavior === 'continue') {
      level = 'window';
      cache = { el: null, at: 0 };
      const w = windowTarget();
      const wMax = w.getMax();
      const wPos = w.getPos();
      const wAtEnd = settings.direction === 'down'
        ? wPos >= wMax - 0.5
        : wPos <= 0.5;
      if (wMax <= 1 || wAtEnd) stop('Đã dừng: tới cuối trang');
      return;
    }

    atEnd = true;
    if (settings.endBehavior === 'loop') {
      stopRaf(); // tiết kiệm CPU: chỉ đánh thức lại bằng timer
      if (!resetTimer) {
        const tEnd = t;
        resetTimer = setTimeout(() => {
          resetTimer = null;
          if (running && !paused) {
            atEnd = false;
            tEnd.jump(settings.direction === 'down' ? 0 : tEnd.getMax());
            if (tEnd.isEl && tEnd.el && document.contains(tEnd.el)) {
              cache = { el: tEnd.el, at: performance.now() }; // giữ đúng khung vừa loop
            }
            ensureRaf();
          }
        }, settings.loopWaitMs);
      }
    } else {
      // 'stop' và 'continue' (đã ở cấp trang rồi)
      stop('Đã dừng: tới cuối trang');
    }
  }

  function tick(now) {
    rafId = null;
    if (!running || paused) return;

    const dt = Math.min(Math.max((now - lastTime) / 1000, 0), 0.1);
    lastTime = now;

    if (!atEnd) {
      const t = pickTarget();
      const max = t.getMax();
      if (max > 1) {
        emptySince = 0;
        const dir = settings.direction === 'up' ? -1 : 1;
        const pos = t.getPos();
        let next = pos + settings.speed * speedFactor * dt * dir;
        if (next > max) next = max;
        if (next < 0) next = 0;
        if (next !== pos) t.step(next - pos);

        const reached = settings.direction === 'down'
          ? next >= max - 0.5
          : next <= 0.5;
        if (reached) handleReached(t);
      } else {
        // Trang không đủ dài để cuộn → tự dừng sau một khoảng ngắn (có lý do)
        if (!emptySince) emptySince = now;
        else if (now - emptySince > EMPTY_MS) {
          stop('Trang không đủ dài để cuộn');
          return;
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  /* ---------------- Trạng thái ---------------- */

  function sendState(reason) {
    try {
      const msg = { type: 'scroller.state', running, paused };
      if (reason) msg.reason = reason;
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  function clearResumeTimer() {
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  }

  function scheduleResume() {
    clearResumeTimer();
    if (!running || !settings.resumeAfterMs) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (running && paused) setPaused(false);
    }, settings.resumeAfterMs);
  }

  function start() {
    if (running) return { ok: true };
    if (!pageAllowed()) {
      const reason = 'Trang này không nằm trong danh sách URL cho phép';
      sendState(reason);
      return { ok: false, reason };
    }
    running = true;
    paused = false;
    atEnd = false;
    level = 'auto';
    emptySince = 0;
    clearResumeTimer();
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    startFactorTimer();
    cache = { el: null, at: 0 };
    if (settings.startPosition !== 'current') {
      const t = pickTarget();
      t.jump(settings.startPosition === 'top' ? 0 : t.getMax());
    }
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
    sendState();
    return { ok: true };
  }

  function stop(reason) {
    const wasRunning = running;
    running = false;
    paused = false;
    atEnd = false;
    level = 'auto';
    emptySince = 0;
    stopRaf();
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    clearResumeTimer();
    stopFactorTimer();
    if (wasRunning) sendState(reason);
  }

  function setPaused(p) {
    if (!running) return;
    paused = !!p;
    clearResumeTimer();
    if (paused) {
      stopRaf();
    } else {
      atEnd = false;
      ensureRaf();
    }
    sendState();
  }

  /* ---------------- Tự tạm dừng khi user thao tác (cấu hình được) ---------------- */

  function onManualScroll() {
    if (!running || settings.manualPauseMode === 'off') return;
    if (!paused) setPaused(true);
    if (settings.manualPauseMode === 'pause-resume') scheduleResume();
  }

  document.addEventListener('wheel', onManualScroll, { passive: true, capture: true });
  document.addEventListener('touchmove', onManualScroll, { passive: true, capture: true });
  document.addEventListener('mousedown', onManualScroll, { passive: true, capture: true });
  document.addEventListener('keydown', (e) => {
    if (settings.manualPauseMode === 'off') return;
    const key = e.key;
    if (key !== ' ' && key !== 'PageDown' && key !== 'PageUp' &&
        key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (t && t.isContentEditable)) return;
    onManualScroll();
  }, true);

  document.addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
  }, { passive: true });

  /* ---------------- Tiết kiệm tài nguyên ---------------- */

  // Tab ẩn: huỷ rAF hẳn; tab hiện trở lại: đánh thức (không nhảy vị trí)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopRaf();
    } else {
      ensureRaf();
    }
  });

  window.addEventListener('resize', () => { cache = { el: null, at: 0 }; }, { passive: true });

  // SPA navigation & layout thay đổi lớn → đánh giá lại khung cuộn (tối đa 1 lần/giây nhờ TTL)
  function invalidateCache() { cache = { el: null, at: 0 }; }
  window.addEventListener('popstate', invalidateCache);
  window.addEventListener('hashchange', invalidateCache);
  try {
    const mo = new MutationObserver(invalidateCache);
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  /* ---------------- Nhận lệnh ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'scroller.ping':
        sendResponse({ ok: true, v: 1 });
        break;
      case 'scroller.getState':
        sendResponse({
          ok: true,
          running,
          paused,
          allowed: pageAllowed(),
          container: pickTarget().label
        });
        break;
      case 'scroller.command': {
        let extra = {};
        if (msg.command === 'start') {
          extra = start() || {};
        } else if (msg.command === 'stop') {
          stop();
        } else if (msg.command === 'pause') {
          setPaused(!paused);
        } else if (msg.command === 'toggle') {
          if (running) stop();
          else extra = start() || {};
        }
        sendResponse(Object.assign({ ok: true, running, paused }, extra));
        break;
      }
    }
  });
})();
