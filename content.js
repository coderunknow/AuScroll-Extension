/* AuScroll — content script (Manifest V3)
 *
 * Vòng lặp cuộn chạy bằng requestAnimationFrame + dt (độc lập tần số khung hình),
 * tự chọn đối tượng cuộn: khung feed còn chỗ cuộn dưới chuột → khung chính giữa
 * màn hình → cả trang.
 *
 * v1.1 (bản cập nhật theo phản hồi thực tế):
 *  - Sửa lỗi "chờ nội dung mới vô hạn dù trang còn nội dung":
 *      + Khi leo cấp feed → cả trang, engine GIỮ baseline của feed; feed lớn thêm
 *        (AI stream vào container) → quay lại cuộn feed.
 *      + Poll kiểm tra cả "chiều cao tăng" LẪN "đã có chỗ cuộn trở lại" (bạn cuộn
 *        tay lên, layout co giãn...).
 *  - Watchdog: chạy mà vị trí không nhúc nhích → tự thử lại; quá 6s → dừng có lý
 *    do (không bao giờ "mơ chạy" nữa).
 *  - Cấu hình riêng theo trang (profiles), HUD trên trang, tự pause khi có video
 *    đang phát, giới hạn số vòng lặp, trễ ngẫu nhiên khi bật, thống kê cục bộ,
 *    easing cho step mode, lệnh "cuộn tiếp ngay" khi đang chờ.
 */
(() => {
  'use strict';

  if (window.__auScrollLoaded) return;
  window.__auScrollLoaded = true;

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const DEFAULTS = Object.freeze({
    speed: 250,                      // px/giây
    direction: 'down',               // 'down' | 'up'
    endBehavior: 'loop',             // 'loop' | 'stop' | 'continue'
    loopWaitMs: 900,                 // dừng ở cuối bao lâu trước khi quay đầu (loop)
    continueWaitMs: 15000,           // 'continue': chờ nội dung mới tối đa (mỗi giai đoạn)
    continueIndefinite: false,       // 'continue': chờ vô hạn tới khi có nội dung mới
    autoContainer: true,             // tự nhận khung cuộn nội bộ
    manualPauseMode: 'pause-resume', // 'off' | 'pause' | 'pause-resume'
    pauseTriggers: { wheel: true, touch: true, click: false, keys: true },
    resumeAfterMs: 5000,             // auto-resume sau bao lâu (pause-resume)
    humanize: false,                 // tốc độ ngẫu nhiên (giống người thật)
    jitterPct: 25,                   // biến thiên ±%
    stepMode: false,                 // cuộn từng bước thay vì liên tục
    stepPx: 300,                     // mỗi bước cuộn bao nhiêu px
    stepIntervalMs: 2000,            // nghỉ bao lâu giữa các bước
    stepEasing: 'smooth',            // 'linear' | 'smooth' (cho bước nhảy)
    durationMin: 0,                  // tự dừng sau N phút (0 = tắt)
    startPosition: 'current',        // 'current' | 'top' | 'bottom'
    autoStart: false,                // tự bật khi mở trang trong danh sách URL
    resumeAfterReload: false,        // chạy lại nếu đang chạy khi trang được tải lại
    startDelayMaxMs: 0,              // trễ ngẫu nhiên 0..N ms khi bật (0 = tắt)
    maxLoops: 0,                     // tối đa số vòng quay đầu (0 = vô hạn)
    pauseOnVideo: false,             // tự pause khi có video đang phát
    hudShow: true,                   // hiển thị chỉ báo nhỏ trên trang
    statsEnabled: true,              // ghi lại tổng px/giờ đã cuộn (cục bộ)
    urlWhitelist: [],                // trống = mọi trang
    profiles: {}                     // { "host[/path]": {cấu hình riêng theo trang} }
  });

  const SCAN_LIMIT = 15000;        // không quét DOM lớn hơn
  const SCAN_STYLE_BUDGET = 3000;  // tối đa lần getComputedStyle mỗi lần quét
  const CACHE_TTL = 1000;          // ms — cache khung cuộn
  const MIN_ROOM = 150;            // khung cuộn phải còn ≥150px chỗ cuộn theo hướng
  const FACTOR_MS = 700;           // chu kỳ rút lại hệ số tốc độ ngẫu nhiên
  const EMPTY_MS = 1500;           // trang không cuộn được liên tục bao lâu → tự dừng
  const FLAG_KEY = '__auScrollWasRunning';
  const STUCK_HEAL_MS = 2000;      // watchdog: thử tự phục hồi mỗi 2s
  const STUCK_STOP_MS = 6000;      // watchdog: không nhúc nhích 6s → dừng có lý do

  let settings = { ...DEFAULTS, pauseTriggers: { ...DEFAULTS.pauseTriggers }, profiles: {} };
  let eff = settings;              // cấu hình hiệu lực (global + profile của trang hiện tại)
  let effHref = '';
  let running = false;
  let starting = false;            // đang chờ trễ ngẫu nhiên trước khi chạy
  let paused = false;
  let atEnd = false;
  let level = 'auto';              // 'auto' | 'window' (sau khi "continue" leo cấp)
  let lastFeedEl = null;           // feed đã leo cấp từ — giữ để phát hiện feed lớn thêm
  let rafId = null;
  let lastTime = 0;
  let resetTimer = null;           // loop-wait
  let resumeTimer = null;          // auto-resume sau thao tác tay
  let factorTimer = null;          // humanize
  let waitTimer = null;            // continue-wait poll
  let waitState = null;            // { el, feedEl, startedAt, pausedAt, stage, baseFeed, baseDoc }
  let startTimer = null;           // trễ ngẫu nhiên khi bật
  let loopsDone = 0;               // đếm vòng lặp (maxLoops)
  let skipGuardUntil = 0;          // sau "cuộn tiếp ngay": nếu chạm đáy ngay → dừng hẳn
  let stepAcc = 0;                 // đồng hồ tích luỹ cho step mode
  let stepAnim = null;             // animation bước nhảy hiện tại (step mode smooth)
  let durationStart = null;        // mốc bắt đầu cho hẹn giờ tự dừng
  let tickErrors = 0;              // đếm lỗi liên tiếp trong tick
  let lastPos = null;              // watchdog: vị trí khung gần nhất
  let stuckSince = 0;              // watchdog: mốc bắt đầu đứng yên
  let healAt = 0;                  // watchdog: mốc thử tự phục hồi kế
  let videoPauseActive = false;    // chính engine pause vì video
  let videoWatchTimer = null;      // theo dõi hết video trong lúc pause (tick đã dừng)
  let videoCheckedAt = 0;
  let statsPx = 0;                 // px đã cuộn (chưa lưu)
  let statsMs = 0;                 // thời gian cuộn thực (chưa lưu)
  let statsFlushAt = 0;
  let speedFactor = 1;
  let mouse = null;
  let cache = { el: null, at: 0 };
  let emptySince = 0;

  /* ---------------- Cài đặt (kèm migration + sanitize) ---------------- */

  function sanitizeTriggers(t) {
    const src = t && typeof t === 'object' ? t : {};
    return {
      wheel: src.wheel !== false,
      touch: src.touch !== false,
      click: src.click === true,   // mặc định OFF — bấm chuột không làm pause
      keys: src.keys !== false
    };
  }

  function sanitizeProfiles(p) {
    const out = {};
    if (!p || typeof p !== 'object') return out;
    const keys = Object.keys(p).slice(0, 30);
    for (const k of keys) {
      if (typeof k === 'string' && k.length <= 200 && p[k] && typeof p[k] === 'object' &&
          !Array.isArray(p[k])) {
        out[k] = p[k];
      }
    }
    return out;
  }

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
    let se = src.stepEasing;
    if (se !== 'linear' && se !== 'smooth') se = DEFAULTS.stepEasing;

    const durNum = Number(src.durationMin);
    const dur = !isFinite(durNum) || durNum < 0 ? DEFAULTS.durationMin : Math.min(240, durNum);
    const sdNum = Number(src.startDelayMaxMs);
    const sd = !isFinite(sdNum) || sdNum < 0 ? 0 : Math.min(5000, sdNum);
    const mlNum = Number(src.maxLoops);
    const ml = !isFinite(mlNum) || mlNum < 0 ? 0 : Math.min(50, Math.round(mlNum));

    return {
      speed: Math.min(1000, Math.max(10, Number(src.speed) || DEFAULTS.speed)),
      direction: src.direction === 'up' ? 'up' : 'down',
      endBehavior: end,
      loopWaitMs: Math.min(10000, Math.max(300, Number(src.loopWaitMs) || DEFAULTS.loopWaitMs)),
      continueWaitMs: Math.min(120000, Math.max(1000, Number(src.continueWaitMs) || DEFAULTS.continueWaitMs)),
      continueIndefinite: !!src.continueIndefinite,
      autoContainer: src.autoContainer !== false,
      manualPauseMode: mode,
      pauseTriggers: sanitizeTriggers(src.pauseTriggers),
      resumeAfterMs: Math.min(120000, Math.max(0, Number(src.resumeAfterMs) || DEFAULTS.resumeAfterMs)),
      humanize: !!src.humanize,
      jitterPct: Math.min(80, Math.max(0, Number(src.jitterPct) || DEFAULTS.jitterPct)),
      stepMode: !!src.stepMode,
      stepPx: Math.min(1000, Math.max(50, Number(src.stepPx) || DEFAULTS.stepPx)),
      stepIntervalMs: Math.min(10000, Math.max(500, Number(src.stepIntervalMs) || DEFAULTS.stepIntervalMs)),
      stepEasing: se,
      durationMin: dur,
      startPosition: sp,
      autoStart: !!src.autoStart,
      resumeAfterReload: !!src.resumeAfterReload,
      startDelayMaxMs: sd,
      maxLoops: ml,
      pauseOnVideo: !!src.pauseOnVideo,
      hudShow: !!src.hudShow,
      statsEnabled: !!src.statsEnabled,
      urlWhitelist: wl.map((x) => String(x).trim()).filter(Boolean),
      profiles: sanitizeProfiles(src.profiles)
    };
  }

  // Cấu hình hiệu lực = global + profile khớp URL hiện tại (key dài nhất thắng)
  function currentHref() {
    try { return location.href || ''; } catch (e) { return ''; }
  }

  function rebuildEff() {
    effHref = currentHref();
    const profs = settings.profiles || {};
    let bestKey = null;
    let bestLen = -1;
    const M = window.AutoScrollMatch;
    if (M && effHref) {
      for (const k of Object.keys(profs)) {
        let matched = false;
        try { matched = M.entryMatches(k, effHref); } catch (e) { matched = false; }
        if (matched && k.length > bestLen) { bestKey = k; bestLen = k.length; }
      }
    }
    eff = bestKey
      ? Object.assign({}, settings, profs[bestKey], { pauseTriggers: sanitizeTriggers((profs[bestKey] || {}).pauseTriggers || settings.pauseTriggers) })
      : settings;
  }

  // Đọc cấu hình hiệu lực (luôn mới nhất)
  function S() { return eff; }

  function applyStored(s) {
    const next = sanitize(s);
    const dirChanged = next.direction !== settings.direction;
    const endChanged = next.endBehavior !== settings.endBehavior;
    settings = next;
    rebuildEff();
    if ((dirChanged || endChanged) && atEnd) atEnd = false;
    if (dirChanged) level = 'auto'; // hướng mới → đánh giá lại khung cuộn
    if (!S().humanize) speedFactor = 1;
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

  /* ---------------- Whitelist URL (dùng danh sách global) ---------------- */

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
    if (!S().humanize) { speedFactor = 1; return; }
    const j = S().jitterPct / 100;
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
    return S().direction === 'down' ? pos < max - 1 : pos > 1;
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
  // Ưu tiên 3: chính <html>/<body> nếu chúng mới là thằng cuộn thật (một số app
  //            khoá window, cuộn bằng body) — tránh "chạy mà không nhúc nhích"
  // Còn lại: cuộn cả trang (window)
  function rootScrollTarget() {
    const de = document.documentElement;
    const body = document.body;
    const cands = [de, body];
    for (const el of cands) {
      if (!el || el.nodeType !== 1) continue;
      if (el.scrollHeight - el.clientHeight > 2 && isScrollableStyle(el)) {
        const t = elTarget(el);
        if (t.getMax() > 1) return t;
      }
    }
    return null;
  }

  function findContainer() {
    if (!S().autoContainer || level !== 'auto') return null;
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
    const root = rootScrollTarget();
    if (root) return root;
    return windowTarget();
  }

  /* ---------------- "Tiếp tục cuộn": chờ nội dung mới (AI stream, feed vô hạn) ---------------- */

  function clearWaitTimer() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
  }

  function windowHasRoom() {
    const w = windowTarget();
    const max = w.getMax();
    if (max <= 1) return false;
    const pos = w.getPos();
    return S().direction === 'down' ? pos < max - 0.5 : pos > 0.5;
  }

  function enterContinueWait(t) {
    atEnd = true;
    stopRaf();
    const feedEl = (t && t.isEl && t.el) ? t.el : lastFeedEl;
    let baseFeed = 0;
    if (feedEl) {
      try { baseFeed = feedEl.scrollHeight || 0; } catch (e) { baseFeed = 0; }
    }
    let baseDoc = 0;
    try { baseDoc = docEl().scrollHeight || 0; } catch (e) {}
    waitState = {
      el: (t && t.isEl && t.el) ? t.el : null,   // feed chạm đáy trực tiếp
      feedEl: feedEl || null,                     // feed đã leo cấp từ (nếu có)
      startedAt: performance.now(),
      pausedAt: null,
      stage: 1,
      baseFeed: baseFeed,
      baseDoc: baseDoc
    };
    armWaitPoll(400);
  }

  function armWaitPoll(ms) {
    clearWaitTimer();
    waitTimer = setInterval(onWaitPoll, ms);
  }

  function waitFeedEl() {
    if (!waitState) return null;
    if (waitState.el && document.contains(waitState.el)) return waitState.el;
    if (waitState.feedEl && document.contains(waitState.feedEl)) return waitState.feedEl;
    return null;
  }

  // Nội dung mới? = chiều cao tăng SO VỚI baseline, HOẶC đã có chỗ cuộn trở lại
  // (bạn cuộn tay lên, ảnh/layout co lại, SPA thay nội dung...)
  function contentGrew() {
    if (!waitState) return false;
    const dir = S().direction;
    try {
      const f = waitFeedEl();
      if (f) {
        if ((f.scrollHeight || 0) > waitState.baseFeed + 1) return true;
        const fMax = (f.scrollHeight || 0) - (f.clientHeight || 0);
        const fPos = f.scrollTop || 0;
        if (fMax > 1 && (dir === 'down' ? fPos < fMax - 0.5 : fPos > 0.5)) return true;
      }
    } catch (e) {}
    try {
      if ((docEl().scrollHeight || 0) > waitState.baseDoc + 1) return true;
    } catch (e) {}
    // không có feed nào theo dõi → kiểm tra cả trang đã có chỗ cuộn trở lại chưa
    try {
      if (!waitFeedEl()) {
        const w = windowTarget();
        const max = w.getMax();
        if (max > 1) {
          const pos = w.getPos();
          if (S().direction === 'down' ? pos < max - 0.5 : pos > 0.5) return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function onWaitPoll() {
    if (!running) { clearWaitTimer(); waitState = null; return; }
    if (paused || !waitState) return;
    if (contentGrew()) {
      const f = waitFeedEl();
      const backToFeed = !!(f && hasRoom(f));
      clearWaitTimer();
      waitState = null;
      atEnd = false;
      if (backToFeed) level = 'auto'; // feed có nội dung mới → cuộn lại feed
      cache = { el: null, at: 0 };
      ensureRaf();
      return;
    }
    if (S().continueIndefinite) return; // chờ mãi tới khi có nội dung mới
    const elapsed = performance.now() - waitState.startedAt;
    const limit = S().continueWaitMs;
    if (waitState.stage === 1 && elapsed >= limit) {
      // giai đoạn 2: kiên nhẫn thêm một lượt nữa (poll chậm hơn), rồi mới dừng
      waitState.stage = 2;
      waitState.startedAt = performance.now();
      armWaitPoll(1000);
      return;
    }
    if (elapsed >= limit) {
      clearWaitTimer();
      waitState = null;
      stop('Đã dừng: tới cuối trang (không có nội dung mới)');
    }
  }

  function suspendWaitForPause() {
    if (waitTimer && waitState) {
      clearWaitTimer();
      waitState.pausedAt = performance.now();
    }
  }

  function resumeWaitAfterPause() {
    if (waitState && atEnd) {
      if (waitState.pausedAt != null) {
        waitState.startedAt += performance.now() - waitState.pausedAt;
        waitState.pausedAt = null;
      }
      armWaitPoll(waitState.stage === 2 ? 1000 : 400);
      return true;
    }
    return false;
  }

  // "Cuộn tiếp ngay" từ popup/HUD: bỏ qua trạng thái chờ.
  // Nếu ngay sau đó lại chạm đáy (không có gì để cuộn) → dừng hẳn thay vì chờ lại.
  function skipWait() {
    if (!running || !waitState) return false;
    clearWaitTimer();
    waitState = null;
    atEnd = false;
    skipGuardUntil = performance.now() + 800;
    level = 'auto';
    cache = { el: null, at: 0 };
    ensureRaf();
    return true;
  }

  /* ---------------- Video đang phát → tạm dừng (tuỳ chọn) ---------------- */

  function playingVideo() {
    if (!document.querySelectorAll) return null;
    let vids = null;
    try { vids = document.querySelectorAll('video'); } catch (e) { return null; }
    if (!vids || !vids.length) return null;
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      try {
        if (v && typeof v.paused === 'boolean' && !v.paused && !v.ended &&
            (typeof v.readyState !== 'number' || v.readyState > 1)) return v;
      } catch (e) {}
    }
    return null;
  }

  function clearVideoWatch() {
    if (videoWatchTimer) { clearInterval(videoWatchTimer); videoWatchTimer = null; }
  }

  function checkVideoPause(now) {
    if (!S().pauseOnVideo) { if (videoPauseActive && !paused) videoPauseActive = false; return; }
    if (now - videoCheckedAt < 1000) return;
    videoCheckedAt = now;
    const pv = playingVideo();
    if (pv && running && !paused && !atEnd) {
      videoPauseActive = true;
      setPaused(true);
      // khi pause, tick đã dừng → cần timer riêng để biết video đã hết
      if (!videoWatchTimer) {
        videoWatchTimer = setInterval(() => {
          if (!running || !videoPauseActive) { clearVideoWatch(); return; }
          if (!playingVideo()) {
            clearVideoWatch();
            videoPauseActive = false;
            if (running && paused) setPaused(false);
          }
        }, 500);
      }
    } else if (!pv && running && paused && videoPauseActive) {
      videoPauseActive = false;
      clearVideoWatch();
      setPaused(false);
    }
  }

  /* ---------------- Vòng lặp cuộn ---------------- */

  function stopRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function ensureRaf() {
    if (!rafId && running && !paused && !atEnd) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  function ease(t) {
    if (S().stepEasing === 'linear') return t;
    // easeInOutQuad: vào/ra mượt
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function handleReached(t) {
    if (S().endBehavior === 'continue') {
      // feed hết chỗ → leo cấp lên cả trang NẾU cả trang còn chỗ (nhớ feed lại
      // để còn phát hiện feed lớn thêm); nếu cả trang cũng hết → chờ nội dung mới.
      if (t.isEl && windowHasRoom()) {
        level = 'window';
        lastFeedEl = t.el;
        cache = { el: null, at: 0 };
        return;
      }
      // vừa bấm "cuộn tiếp ngay" mà lập tức chạm đáy lại → không có gì để cuộn
      if (performance.now() < skipGuardUntil) {
        stop('Đã dừng: bấm "Cuộn tiếp" nhưng không còn chỗ cuộn');
        return;
      }
      enterContinueWait(t);
      return;
    }

    atEnd = true;
    if (S().endBehavior === 'loop') {
      stopRaf(); // tiết kiệm CPU: chỉ đánh thức lại bằng timer
      if (!resetTimer) {
        const tEnd = t;
        resetTimer = setTimeout(() => {
          resetTimer = null;
          if (running && !paused) {
            if (S().maxLoops > 0 && loopsDone >= S().maxLoops) {
              stop('Đã dừng: hết số vòng lặp cho phép');
              return;
            }
            loopsDone += 1;
            atEnd = false;
            tEnd.jump(S().direction === 'down' ? 0 : tEnd.getMax());
            if (tEnd.isEl && tEnd.el && document.contains(tEnd.el)) {
              cache = { el: tEnd.el, at: performance.now() }; // giữ đúng khung vừa loop
            }
            ensureRaf();
          }
        }, S().loopWaitMs);
      }
    } else {
      stop('Đã dừng: tới cuối trang');
    }
  }

  // Trang chưa đủ dài để cuộn: 'continue' → chờ nội dung mới, còn lại → dừng sau 1.5s
  function handleEmpty(now) {
    if (S().endBehavior === 'continue') {
      if (!waitState) enterContinueWait(windowTarget());
      return;
    }
    if (!emptySince) emptySince = now;
    else if (now - emptySince > EMPTY_MS) {
      stop('Trang không đủ dài để cuộn');
    }
  }

  // Watchdog: chống "vẫn báo chạy nhưng trang đứng yên".
  // Đứng yên > 2s → tự làm mới cache/khung cuộn; > 6s → dừng kèm lý do rõ ràng.
  function watchdog(now, t, moved) {
    if (S().stepMode) return; // step mode vốn đứng yên giữa các bước
    if (moved) { lastPos = null; stuckSince = 0; healAt = 0; return; }
    const pos = t.getPos();
    if (lastPos == null) { lastPos = pos; stuckSince = now; healAt = now + STUCK_HEAL_MS; return; }
    if (Math.abs(pos - lastPos) >= 1) { lastPos = pos; stuckSince = now; healAt = now + STUCK_HEAL_MS; return; }
    if (now >= healAt) {
      if (now - stuckSince >= STUCK_STOP_MS) {
        stop('Đã dừng: trang không cuộn được (đã thử tự phục hồi)');
        return;
      }
      cache = { el: null, at: 0 }; // thử chọn lại khung cuộn khác
      healAt = now + STUCK_HEAL_MS;
    }
  }

  function tick(now) {
    rafId = null;
    if (!running || paused) return;

    const dt = Math.min(Math.max((now - lastTime) / 1000, 0), 0.1);
    lastTime = now;

    // URL đổi (SPA) → tính lại profile theo trang
    if (currentHref() !== effHref) rebuildEff();

    // Hẹn giờ tự dừng
    if (S().durationMin > 0 && durationStart != null &&
        now - durationStart >= S().durationMin * 60000) {
      flushStats();
      stop('Đã dừng: hết thời gian tự dừng');
      return;
    }

    checkVideoPause(now);

    if (!atEnd) {
      let moved = false;
      try {
        const t = pickTarget();
        const max = t.getMax();
        if (max > 1) {
          emptySince = 0;
          tickErrors = 0;
          const dir = S().direction === 'up' ? -1 : 1;

          let delta = 0;
          if (S().stepMode) {
            stepAcc += dt * 1000;
            if (stepAnim) {
              // bước nhảy đang chạy mượt (giảm dần theo hàm mũ) hoặc nhảy tức thì với 'linear'
              const frac = S().stepEasing === 'smooth' ? Math.min(1, dt * 9) : 1;
              delta = stepAnim.remaining * frac;
              stepAnim.remaining -= delta;
              if (stepAnim.remaining < 0.5) { stepAnim.remaining = 0; stepAnim = null; }
            } else if (stepAcc >= S().stepIntervalMs) {
              stepAcc = 0;
              const jump = S().stepPx * speedFactor;
              if (S().stepEasing === 'linear') {
                delta = jump; // tức thì ngay trong frame kích hoạt
              } else {
                stepAnim = { remaining: jump };
              }
            }
          } else {
            delta = S().speed * speedFactor * dt;
          }

          if (delta > 0) {
            const pos = t.getPos();
            let next = pos + delta * dir;
            if (next > max) next = max;
            if (next < 0) next = 0;
            if (next !== pos) {
              t.step(next - pos);
              // xác nhận bằng vị trí THỰC sau khi step — trang bị chặn/fail âm thầm
              // thì moved=false để watchdog phát hiện và tự phục hồi
              const after = t.getPos();
              moved = Math.abs(after - pos) > 0.01;
              if (moved) {
                statsPx += Math.abs(after - pos);
                statsMs += dt * 1000;
              }
            }
            const reached = S().direction === 'down' ? next >= max - 0.5 : next <= 0.5;
            if (reached) handleReached(t);
          }
          if (!atEnd) watchdog(now, t, moved);
          if (S().statsEnabled && now >= statsFlushAt) {
            flushStats();
            statsFlushAt = now + 10000;
          }
        } else {
          handleEmpty(now);
        }
      } catch (err) {
        // DOM thay đổi đột ngột (element bị xoá...) → ném bỏ cache, thử lại;
        // lỗi liên tục quá thì dừng có lý do thay vì treo
        if (++tickErrors > 60) {
          stop('Đã dừng: lỗi lặp lại khi cuộn');
          return;
        }
        cache = { el: null, at: 0 };
      }
    }

    if (running && !atEnd && !paused) rafId = requestAnimationFrame(tick);
  }

  /* ---------------- Thống kê cục bộ ---------------- */

  function flushStats() {
    if (!S().statsEnabled || (statsPx === 0 && statsMs === 0)) return;
    const addPx = statsPx;
    const addMs = statsMs;
    statsPx = 0;
    statsMs = 0;
    try {
      chrome.storage.local.get(['stats'], (res) => {
        if (chrome.runtime.lastError) return;
        const prev = (res && res.stats && typeof res.stats === 'object') ? res.stats : { px: 0, ms: 0 };
        const merged = {
          px: Math.max(0, (Number(prev.px) || 0) + addPx),
          ms: Math.max(0, (Number(prev.ms) || 0) + addMs)
        };
        try {
          const p = chrome.storage.local.set({ stats: merged });
          if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      });
    } catch (e) {}
  }

  /* ---------------- Trạng thái ---------------- */

  function sendState(reason) {
    updateHud();
    try {
      const msg = {
        type: 'scroller.state',
        running,
        paused,
        starting,
        waiting: !!(running && atEnd && waitState),
        videoPaused: videoPauseActive,
        speed: S().speed
      };
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
    if (!running || !S().resumeAfterMs) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (running && paused) setPaused(false);
    }, S().resumeAfterMs);
  }

  function beginStart() {
    running = true;
    starting = false;
    paused = false;
    atEnd = false;
    level = 'auto';
    lastFeedEl = null;
    emptySince = 0;
    stepAcc = 0;
    stepAnim = null;
    tickErrors = 0;
    waitState = null;
    loopsDone = 0;
    lastPos = null;
    stuckSince = 0;
    healAt = 0;
    durationStart = S().durationMin > 0 ? performance.now() : null;
    clearResumeTimer();
    clearWaitTimer();
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    startFactorTimer();
    cache = { el: null, at: 0 };
    if (S().startPosition !== 'current') {
      const t = pickTarget();
      t.jump(S().startPosition === 'top' ? 0 : t.getMax());
    }
    try { sessionStorage.setItem(FLAG_KEY, '1'); } catch (e) {}
    ensureHud();
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
    sendState();
    return { ok: true };
  }

  function start() {
    if (running || startTimer) return { ok: true };
    if (!pageAllowed()) {
      const reason = 'Trang này không nằm trong danh sách URL cho phép';
      sendState(reason);
      return { ok: false, reason };
    }
    const maxDelay = S().startDelayMaxMs;
    if (maxDelay > 0) {
      const d = Math.floor(Math.random() * Math.min(maxDelay, 5000)) + 150;
      starting = true;
      sendState();
      startTimer = setTimeout(() => {
        startTimer = null;
        if (!running && pageAllowed()) beginStart();
      }, d);
      return { ok: true, starting: true, delayMs: d };
    }
    return beginStart();
  }

  function stop(reason) {
    const wasRunning = running || starting;
    flushStats();
    running = false;
    starting = false;
    paused = false;
    atEnd = false;
    level = 'auto';
    lastFeedEl = null;
    emptySince = 0;
    stepAcc = 0;
    stepAnim = null;
    tickErrors = 0;
    waitState = null;
    durationStart = null;
    videoPauseActive = false;
    clearVideoWatch();
    stopRaf();
    if (startTimer) { clearTimeout(startTimer); startTimer = null; }
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    clearResumeTimer();
    clearWaitTimer();
    stopFactorTimer();
    removeHud();
    try { sessionStorage.removeItem(FLAG_KEY); } catch (e) {}
    if (wasRunning) sendState(reason);
  }

  function setPaused(p) {
    if (!running) return;
    paused = !!p;
    clearResumeTimer();
    if (paused) {
      stopRaf();
      suspendWaitForPause(); // giữ nguyên thời gian chờ, resume rồi tính tiếp
    } else if (resumeWaitAfterPause()) {
      // đang trong trạng thái chờ nội dung mới → không cần rAF
    } else if (resetTimer) {
      // đang chờ loop (resetTimer) → để timer xử lý, không đánh thức rAF sớm
    } else {
      atEnd = false;
      ensureRaf();
    }
    sendState();
  }

  /* ---------------- Tự tạm dừng khi user thao tác (cấu hình từng loại) ---------------- */

  function editableTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      t.isContentEditable === true;
  }

  function onManual(kind, e) {
    if (!running || paused) return;
    if (S().manualPauseMode === 'off') return;
    const tr = S().pauseTriggers || DEFAULTS.pauseTriggers;
    if (!tr[kind]) return;
    // đang gõ/click vào ô nhập liệu (chỉnh sửa) thì không bao giờ pause
    if ((kind === 'click' || kind === 'keys') && e && editableTarget(e.target)) return;
    setPaused(true);
    if (S().manualPauseMode === 'pause-resume') scheduleResume();
  }

  document.addEventListener('wheel', (e) => onManual('wheel', e), { passive: true, capture: true });
  document.addEventListener('touchmove', (e) => onManual('touch', e), { passive: true, capture: true });
  document.addEventListener('mousedown', (e) => onManual('click', e), { passive: true, capture: true });
  document.addEventListener('keydown', (e) => {
    const key = e.key;
    if (key !== ' ' && key !== 'PageDown' && key !== 'PageUp' &&
        key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
    onManual('keys', e);
  }, true);

  document.addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
  }, { passive: true });

  /* ---------------- HUD trên trang (xem trạng thái ngay, không cần mở popup) --- */

  let hudHost = null;
  let hudEl = null;

  function ensureHud() {
    if (!S().hudShow || hudEl) return;
    try {
      if (typeof document.createElement !== 'function' ||
          !document.body || typeof document.body.appendChild !== 'function') return;
      hudHost = document.createElement('div');
      hudHost.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;';
      const root = typeof hudHost.attachShadow === 'function'
        ? hudHost.attachShadow({ mode: 'closed' })
        : hudHost;
      hudEl = document.createElement('div');
      hudEl.textContent = '▼ AuScroll';
      hudEl.style.cssText = [
        'font:600 12px/1.3 system-ui,sans-serif', 'color:#fff', 'background:#fb542b',
        'padding:6px 10px', 'border-radius:14px', 'box-shadow:0 2px 8px rgba(0,0,0,.35)',
        'cursor:pointer', 'user-select:none', 'opacity:.85'
      ].join(';');
      hudEl.addEventListener('click', (ev) => {
        try { ev.stopPropagation(); } catch (e) {}
        if (running) setPaused(!paused);
      });
      root.appendChild(hudEl);
      document.body.appendChild(hudHost);
    } catch (e) {
      hudHost = null; hudEl = null;
    }
  }

  function updateHud() {
    if (!hudEl) return;
    try {
      if (!running) { removeHud(); return; }
      if (paused) {
        hudEl.textContent = videoPauseActive ? '⏸ Video đang phát' : '‖ Tạm dừng';
        hudEl.style.background = '#b45309';
      } else if (atEnd && waitState) {
        hudEl.textContent = '⏳ Chờ nội dung mới…';
        hudEl.style.background = '#1d4ed8';
      } else {
        hudEl.textContent = '▼ ' + S().speed + ' px/s';
        hudEl.style.background = '#15803d';
      }
    } catch (e) {}
  }

  function removeHud() {
    try {
      if (hudHost && hudHost.parentNode) hudHost.parentNode.removeChild(hudHost);
    } catch (e) {}
    hudHost = null;
    hudEl = null;
  }

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

  // SPA navigation & layout thay đổi lớn → đánh giá lại khung cuộn + profile theo URL
  function invalidateCache() { cache = { el: null, at: 0 }; }
  function onNav() { invalidateCache(); rebuildEff(); }
  window.addEventListener('popstate', onNav);
  window.addEventListener('hashchange', onNav);
  try {
    const mo = new MutationObserver(invalidateCache);
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  /* ---------------- Tự bật / chạy lại sau khi tải lại trang ---------------- */

  function maybeAutoStart() {
    if (running || startTimer) return;
    let wasRunning = false;
    try {
      wasRunning = sessionStorage.getItem(FLAG_KEY) === '1';
      sessionStorage.removeItem(FLAG_KEY);
    } catch (e) {}
    if (!pageAllowed()) return;
    if (settings.autoStart || (settings.resumeAfterReload && wasRunning)) {
      setTimeout(() => {
        if (!running && !startTimer && pageAllowed()) start();
      }, 1200);
    }
  }
  setTimeout(maybeAutoStart, 1200);

  /* ---------------- Nhận lệnh ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'scroller.ping':
        sendResponse({ ok: true, v: 3 });
        break;
      case 'scroller.getState':
        sendResponse({
          ok: true,
          running,
          paused,
          starting,
          waiting: !!(running && atEnd && waitState),
          allowed: pageAllowed(),
          container: pickTarget().label,
          speed: S().speed
        });
        break;
      case 'scroller.speed': {
        const delta = Number(msg.delta) || 0;
        const target = (eff !== settings && effHref) ? profileWriteRef() : settings;
        target.speed = Math.min(1000, Math.max(10, (target.speed || settings.speed) + delta));
        persistSettings(settings);
        sendResponse({ ok: true, running, paused, speed: S().speed });
        sendState();
        break;
      }
      case 'scroller.command': {
        let extra = {};
        if (msg.command === 'start') {
          extra = start() || {};
        } else if (msg.command === 'stop') {
          stop();
        } else if (msg.command === 'pause') {
          setPaused(!paused);
        } else if (msg.command === 'toggle') {
          if (running || startTimer) stop();
          else extra = start() || {};
        } else if (msg.command === 'skipwait') {
          extra = { skipped: skipWait() };
        }
        sendResponse(Object.assign({ ok: true, running, paused, waiting: !!(running && atEnd && waitState) }, extra));
        break;
      }
    }
  });

  // Lưu settings (dùng khi engine tự đổi giá trị, VD speed hotkey có profile riêng)
  function profileWriteRef() {
    const M = window.AutoScrollMatch;
    const href = effHref;
    if (!M || !href) return settings;
    for (const k of Object.keys(settings.profiles || {})) {
      try { if (M.entryMatches(k, href)) return settings.profiles[k]; } catch (e) {}
    }
    return settings;
  }

  function persistSettings(s) {
    try {
      const p = chrome.storage.local.set({ settings: s });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
})();
