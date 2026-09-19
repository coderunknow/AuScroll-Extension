/* Auto Scroll — hàm khớp URL thuần (không dùng API của extension).
 * Được nạp vào content script (isolated world) VÀ popup.
 *
 * Quy tắc khớp một entry:
 *  - "youtube.com"                → mọi trang của youtube.com (kể cả subdomain)
 *  - "facebook.com/videos"        → chỉ các đường dẫn bắt đầu bằng /videos
 *  - "https://x.com/watch?v=123"  → cả domain + đường dẫn + query phải khớp tiền tố
 */
(function (root) {
  'use strict';

  function entryMatches(entry, href) {
    const e = String(entry || '').trim();
    if (!e || !href) return false;
    const withScheme = /^https?:\/\//i.test(e) ? e : 'https://' + e;
    let parsed;
    let cur;
    try {
      parsed = new URL(withScheme);
      cur = new URL(href);
    } catch (err) {
      return false;
    }
    const host = (parsed.hostname || '').toLowerCase();
    const cHost = (cur.hostname || '').toLowerCase();
    if (!host) return false;
    if (cHost !== host && !cHost.endsWith('.' + host)) return false;
    const target = (parsed.pathname || '').replace(/\/+$/, '') + (parsed.search || '');
    if (!target) return true; // chỉ nhập domain → khớp mọi trang của domain đó
    const cPath = (cur.pathname || '') + (cur.search || '');
    return cPath.startsWith(target);
  }

  function urlAllowed(list, href) {
    if (!Array.isArray(list) || list.length === 0) return true;
    for (let i = 0; i < list.length; i++) {
      if (entryMatches(list[i], href)) return true;
    }
    return false;
  }

  function labelForEntry(entry) {
    let e = String(entry || '').trim();
    e = e.replace(/^https?:\/\//i, '');
    e = e.replace(/\/+$/, '');
    return e || String(entry);
  }

  const api = { entryMatches: entryMatches, urlAllowed: urlAllowed, labelForEntry: labelForEntry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AutoScrollMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
