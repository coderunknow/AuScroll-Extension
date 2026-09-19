# AuScroll

![AuScroll icon](icons/icon128.png)

**AuScroll** is a Manifest V3 extension for **Brave** and any Chromium-based browser (Chrome, Edge, Arc, …) that auto-scrolls pages — fully configurable: speed, direction, end-of-page behavior, smart feed detection, URL whitelist, human-like speed jitter, and keyboard shortcuts. No accounts, no network, no data collection.

> Tiếng Việt: extension cuộn trang tự động cho Brave/Chromium. Mọi thứ cấu hình được trong popup: tốc độ, hướng, hành vi khi tới cuối trang (quay đầu / dừng / **tiếp tục cuộn sang cả trang**), tự nhận khung feed, chỉ cuộn ở các URL bạn chọn, tốc độ ngẫu nhiên kiểu người thật, phím tắt. Không thu thập dữ liệu. Chi tiết: [PRIVACY.md](PRIVACY.md)

## Features

- **Speed**: 10–1000 px/s, applied live (no reload).
- **Direction**: down / up.
- **End-of-page behavior** (3 options):
  - *Loop* — wait (configurable 0.3–10 s) then scroll back to the top of the same container/page.
  - *Stop* — stop when the end is reached.
  - ***Continue*** — when a **feed** (inner scroll container) runs out, seamlessly continue scrolling the **whole page**; stop when the page itself ends.
- **Smart container detection** — scrolls the right element on feed sites (Facebook, X, Reddit, …):
  container under the mouse → largest container in viewport center → whole page.
  A container is only used while it **still has ≥150 px of room** in the current direction, so AuScroll never "dies" inside a small box that's already at its end.
- **URL whitelist** — scroll only on the pages you choose:
  - `youtube.com` → whole domain (incl. subdomains)
  - `facebook.com/videos` → only paths starting with `/videos`
  - `https://x.com/watch?v=123` → domain + path + query must match
  - Empty list = every page. The popup shows ✓/✗ for the current page; if the current page drops out of the list while running, AuScroll stops.
- **Manual-interaction handling** — when you scroll/click/type scroll keys: *never pause* / *pause until resumed* / *pause, then auto-resume after N s (1–60, default 5)*.
- **Human-like mode** — speed jitters ±5–60% (re-rolled every 0.7 s) so scrolling looks natural.
- **Start position** — when you toggle on: current position / top of page / bottom of page.
- **Shortcuts** — `Alt+S` toggle, `Alt+P` pause/resume (rebindable in `brave://extensions/shortcuts`).
- **Status badge** — ▶ running, ‖ paused.
- **Works on tabs opened before install** — first toggle auto-injects into that tab.

## Install (load unpacked)

1. Clone this repo (or download the release zip) and unzip if needed.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the `auscroll` folder.

To update: **Remove** the old one, then **Load unpacked** again.

## Configuration reference

| Setting | Values / range | Notes |
|---|---|---|
| Speed | 10–1000 px/s | Live |
| Direction | down / up | |
| End of page | loop / stop / **continue** | see Features |
| URL whitelist | list of domain/path/URL | empty = all pages |
| On manual scroll | none / pause / pause+auto-resume | default: pause+auto-resume |
| Auto-resume after | 1–60 s | pause+auto-resume mode only |
| Pause at end before looping | 0.3–10 s | loop mode only |
| Human-like speed | ±5–60% | re-rolled every 0.7 s |
| Start position | current / top / bottom | applied on toggle-on |
| Auto container detection | on / off | off = always whole page |

Settings are stored locally (`chrome.storage.local`).

## Security & privacy

AuScroll makes **zero network requests**, collects **zero data**, and has **no analytics**. It reads nothing except the scroll position of the page it scrolls, and stores only your settings locally on your machine. See [PRIVACY.md](PRIVACY.md) for the full statement and [SECURITY](#security-notes) notes.

**Permissions requested** (all are the minimum needed):

| Permission | Why |
|---|---|
| `storage` | Remember your settings; badge state across service-worker restarts |
| `scripting` + `activeTab` | Inject the content script into a tab on demand (e.g. tabs opened before install). Scoped to the tab you act on, triggered only by your click/shortcut |

No `host_permissions` are requested beyond the declared content script, and no remote code is ever loaded (the extension respects its own CSP; all assets are local files).

## Performance notes

- The scroll loop runs on `requestAnimationFrame` with delta-time, so speed is identical at 60 Hz and 144 Hz.
- The loop **cancels its rAF** while paused, while waiting to loop, and while the tab is hidden — no CPU work when idle.
- The DOM scan for feed containers runs **at most once per second** (TTL cache) and is budget-capped (max 15k elements, 3k `getComputedStyle` calls per scan).
- Page/SPA navigation (hash, popstate, big DOM mutations) invalidates the container cache; the next scan picks up the new layout.
- Pages too short to scroll stop themselves after ~1.5 s with a reason shown in the popup.

## Shortcuts

| Key | Action |
|---|---|
| `Alt+S` | Toggle auto scroll |
| `Alt+P` | Pause / resume |

Rebind in `brave://extensions/shortcuts` (or `chrome://extensions/shortcuts`).

## Development

```bash
npm test          # runs the DOM-simulated engine test suite (node test/engine.test.js)
```

The test suite (`test/engine.test.js`) runs the real `content.js` inside a Node `vm` sandbox with a simulated DOM + `chrome` API — 18 scenarios covering speed accuracy, loop/stop/continue, feed-container edge cases, whitelist matching, auto-resume, humanize bounds, start position, and the "pause on manual interaction" modes.

Regenerate icons:

```bash
python3 tools/make_icons.py   # writes icons/icon{16,32,48,128,512}.png
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, message protocol, and a guide for extending AuScroll.

## Roadmap / known limitations

- The status badge reflects the most recently reported tab (multiple windows each with their own popup is supported; a single global badge is a Chromium design choice).
- `brave://`/`chrome://` pages, the Web Store, and the built-in PDF viewer cannot run content scripts — a platform limitation of every Chromium extension.
- Iframe-internal scrolling (e.g. embedded players) is not targeted; AuScroll scrolls the main frame.

## License

MIT — see [LICENSE](LICENSE).

---

## Tiếng Việt — Tóm tắt

- **Cài đặt**: `brave://extensions` → bật *Chế độ nhà phát triển* → *Nạp extension chưa đóng gói* → chọn thư mục `auscroll`.
- **Phím tắt**: `Alt+S` bật/tắt · `Alt+P` tạm dừng/tiếp tục.
- **Khi tới cuối trang**: *Quay lại đầu* / *Dừng lại* / ***Tiếp tục cuộn*** (feed hết chỗ → tự chuyển sang cuộn cả trang).
- **Chỉ cuộn trang bạn chọn**: nhập domain (`youtube.com`), đường dẫn (`facebook.com/videos`) hoặc link đầy đủ.
- **Tốc độ ngẫu nhiên**: ±5–60%, đổi mỗi 0.7 giây — cuộn như người thật.
- **Khi bạn cuộn tay/bấm chuột**: *Không* / *Tạm dừng* / *Dừng rồi tự chạy lại* (mặc định, 1–60 giây).
- **Bảo mật**: không mạng, không thu thập dữ liệu, chỉ lưu cài đặt cục bộ. Chi tiết trong [PRIVACY.md](PRIVACY.md).
