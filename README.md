# AuScroll

![AuScroll icon](icons/icon128.png)

**AuScroll** (v1.1.0) is a Manifest V3 extension for **Brave** and any Chromium-based browser (Chrome, Edge, Arc, …) that auto-scrolls pages — fully configurable: speed, direction, end-of-page behavior, smart feed detection, URL whitelist, human-like speed jitter, step mode, timers, and keyboard shortcuts. No accounts, no network, no data collection.

> Tiếng Việt: extension cuộn trang tự động cho Brave/Chromium. Mọi thứ cấu hình được trong popup: tốc độ, hướng, hành vi khi tới cuối trang (quay đầu / dừng / **tiếp tục cuộn — chờ nội dung mới kiểu trang AI đang trả lời**), tự nhận khung feed, chỉ cuộn ở các URL bạn chọn, tốc độ ngẫu nhiên kiểu người thật, cuộn từng bước, hẹn giờ, phím tắt. Không thu thập dữ liệu. Chi tiết: [PRIVACY.md](PRIVACY.md)

## Features

- **Speed**: 10–1000 px/s, applied live (no reload) — also via `speed-up`/`speed-down` shortcut commands.
- **Direction**: down / up.
- **End-of-page behavior** (3 options):
  - *Loop* — wait (configurable 0.3–10 s) then scroll back to the top of the same container/page.
  - *Stop* — stop when the end is reached.
  - ***Continue*** — built for **AI pages that stream answers and infinite feeds**:
    feed ends → continue on the whole page; page ends → **wait for new content**
    (polls page growth for a configurable 5–120 s per stage, two stages, or wait
    indefinitely) → new content appears → keeps scrolling instantly; only a truly
    dead end stops it.
- **Smart container detection** — scrolls the right element on feed sites (Facebook, X, Reddit, …):
  container under the mouse → largest container in viewport center → whole page.
  A container is only used while it **still has ≥150 px of room** in the current direction, so AuScroll never "dies" inside a small box that's already at its end.
- **Manual-interaction handling, per trigger** — choose *which* interactions pause:
  mouse wheel / touch / **click (off by default — clicking around never stops it)** /
  scroll keys. Text fields (typing, editing) never pause it in any mode.
  Modes: *never pause* / *pause until resumed* / *pause, then auto-resume after 1–60 s (default 5)*.
- **Step mode** — scroll in discrete jumps (50–1000 px) with a rest interval
  (0.5–10 s) between steps; great for reading feeds one screen at a time.
- **Auto-stop timer** — stop after 5–120 minutes.
- **Auto-start** — begin scrolling automatically when a whitelisted page opens.
- **Resume after reload** — a page that was scrolling and got refreshed (F5) starts again.
- **URL whitelist** — scroll only on the pages you choose:
  - `youtube.com` → whole domain (incl. subdomains)
  - `facebook.com/videos` → only paths starting with `/videos`
  - `https://x.com/watch?v=123` → domain + path + query must match
  - Empty list = every page. The popup shows ✓/✗ for the current page; if the current page drops out of the list while running, AuScroll stops.
- **Human-like mode** — speed jitters ±5–60% (re-rolled every 0.7 s) so scrolling looks natural.
- **Start position** — when you toggle on: current position / top of page / bottom of page.
- **Settings backup** — export/import your configuration as a JSON file; reset to defaults with a two-step confirm.
- **Shortcuts** — `Alt+S` toggle, `Alt+P` pause/resume (rebindable), plus
  `speed-up` / `speed-down` commands you can bind in `brave://extensions/shortcuts`.
- **Status badge** — ▶ running, ‖ paused; popup also shows the "⏳ waiting for new content" state.
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
| Speed | 10–1000 px/s | Live; hotkey-adjustable |
| Direction | down / up | |
| End of page | loop / stop / **continue** | see Features |
| Continue: wait for new content | 5–120 s per stage (+ optional wait-forever) | For AI/streaming/infinite pages |
| URL whitelist | list of domain/path/URL | empty = all pages |
| Pause triggers | wheel / touch / click / keys | click off by default; edit fields always immune |
| On manual scroll | none / pause / pause+auto-resume | default: pause+auto-resume |
| Auto-resume after | 1–60 s | pause+auto-resume mode only |
| Pause at end before looping | 0.3–10 s | loop mode only |
| Step mode | on/off, 50–1000 px, 0.5–10 s | discrete jumps |
| Auto-stop after | off / 5–120 min | |
| Auto-start | on/off | whitelisted pages only |
| Resume after reload | on/off | F5-friendly |
| Human-like speed | ±5–60% | re-rolled every 0.7 s |
| Start position | current / top / bottom | applied on toggle-on |
| Auto container detection | on / off | off = always whole page |

Settings are stored locally (`chrome.storage.local`) and can be exported/imported
as a JSON file from the popup.

## Security & privacy

AuScroll makes **zero network requests**, collects **zero data**, and has **no analytics**. It reads nothing except the scroll position of the page it scrolls, and stores only your settings locally on your machine. See [PRIVACY.md](PRIVACY.md) for the full statement and security notes.

**Permissions requested** (all are the minimum needed):

| Permission | Why |
|---|---|
| `storage` | Remember your settings; badge state across service-worker restarts |
| `scripting` + `activeTab` | Inject the content script into a tab on demand (e.g. tabs opened before install). Scoped to the tab you act on, triggered only by your click/shortcut |

No `host_permissions` are requested beyond the declared content script, and no remote code is ever loaded.

## Performance notes

- The scroll loop runs on `requestAnimationFrame` with delta-time, so speed is identical at 60 Hz and 144 Hz.
- The loop **cancels its rAF** while paused, while waiting to loop, **while waiting for new content** (only a cheap 0.4–1 s poll remains), and while the tab is hidden — no CPU work when idle.
- The DOM scan for feed containers runs **at most once per second** (TTL cache) and is budget-capped (max 15k elements, 3k `getComputedStyle` calls per scan).
- Page/SPA navigation (hash, popstate, big DOM mutations) invalidates the container cache; the next scan picks up the new layout.
- Pages too short to scroll stop themselves after ~1.5 s with a reason shown in the popup (in continue mode they wait for content instead).
- Repeated internal errors while scrolling stop the engine with a reason instead of looping forever.

## Shortcuts

| Key | Action |
|---|---|
| `Alt+S` | Toggle auto scroll |
| `Alt+P` | Pause / resume |
| *(optional)* | `speed-up` / `speed-down` commands — bind manually |

Rebind/add keys in `brave://extensions/shortcuts` (or `chrome://extensions/shortcuts`).

## Development

```bash
npm test          # 27 DOM-simulated engine scenarios (node test/engine.test.js)
npm run icons     # regenerate icons (python3 tools/make_icons.py)
```

The test suite (`test/engine.test.js`) runs the real `content.js` inside a Node `vm` sandbox with a simulated DOM + `chrome` API — including an AI-streaming simulation (page height grows in bursts) covering the continue-wait state machine, the pause-trigger matrix, step-mode cadence, timers, and whitelist matching.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, message protocol, and a guide for extending AuScroll.

## Roadmap / known limitations

- Per-site setting profiles are on the roadmap.
- `brave://`/`chrome://` pages, the Web Store, and the built-in PDF viewer cannot run content scripts — a platform limitation of every Chromium extension.
- Iframe-internal scrolling (e.g. embedded players) is not targeted; AuScroll scrolls the main frame.

## License

MIT — see [LICENSE](LICENSE).

---

## Tiếng Việt — Tóm tắt

- **Cài đặt**: `brave://extensions` → bật *Chế độ nhà phát triển* → *Nạp extension chưa đóng gói* → chọn thư mục `auscroll`.
- **Phím tắt**: `Alt+S` bật/tắt · `Alt+P` tạm dừng/tiếp tục · gán thêm phím tăng/giảm tốc trong `brave://extensions/shortcuts`.
- **Khi tới cuối trang**: *Quay lại đầu* / *Dừng lại* / ***Tiếp tục cuộn*** — feed hết → cuộn cả trang; hết nội dung → **chờ nội dung mới** (trang AI đang trả lời, feed vô hạn) → có là cuộn tiếp luôn; cấu hình thời gian chờ 5–120s hoặc chờ vô hạn.
- **Khi bạn thao tác**: chọn chính xác thao tác nào gây tạm dừng (lăn chuột/cảm ứng/bấm chuột/phím cuộn) — mặc định **bấm chuột không dừng**, đang gõ trong ô nhập liệu không bao giờ dừng.
- **Mới**: cuộn từng bước, hẹn giờ tự dừng, tự bật theo URL, chạy lại sau F5, xuất/nhập file cấu hình.
- **Bảo mật**: không mạng, không thu thập dữ liệu, chỉ lưu cục bộ. Chi tiết trong [PRIVACY.md](PRIVACY.md).
