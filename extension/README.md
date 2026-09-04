# MyLoom Recorder — browser extension

Record from any tab with one click and send it straight to your own MyLoom.
Chrome and Edge (and other Chromium browsers) version 116 or newer.

There is nothing to buy and nothing to publish — you load the folder directly.

## Install

1. Download this repository and find the `extension` folder.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** — top right.
4. Click **Load unpacked** and choose the `extension` folder.
5. The options page opens by itself. Leave it open for the next step.

## Connect it to your MyLoom

1. In MyLoom, go to **Settings → Profile → API tokens** and click **+ New token**.
2. Copy the token — it is only shown once.
3. Back on the extension's options page, paste:
   - **Your MyLoom address** — e.g. `https://videos.yourdomain.com`
   - **API token** — the `mlt_…` value you just copied
4. Click **Save & test connection**. It should say *Connected as …*.

The token is stored only in your browser, and it is the only credential the
extension holds — it never sees your password. Revoke it any time from the same
Settings page and the extension stops working immediately.

## Allow the camera and microphone — once

The first time you press **Start recording** a tab opens asking for your camera
and microphone. Click **Allow**, close the tab, and record. It is asked once and
remembered.

This is not a formality. The recorder runs in an offscreen document, and Chrome
will not show a permission prompt there — `getUserMedia()` returns
*NotAllowedError: Permission dismissed* immediately. A recording made without
the grant comes out with **no voice and no camera bubble**, which is why the
prompt has a page of its own. You can reopen it any time from **Camera & mic
access** at the bottom of the popup.

## Using it

- Click the toolbar icon on any page, pick a mode, and press **Start recording**.
  - **Screen** — a display, a window or any tab, chosen in Chrome's picker.
  - **Tab** — the tab you opened the popup over, with its audio and no picker.
  - **Camera** — a talking-head video with no screen.
  - **Camera bubble (screen + camera)** overlays your webcam in the corner, and
    works with either of the screen modes. There is no separate "screen +
    camera" mode: tick the box on **Screen** or **Tab**.
- A bar appears at the bottom of the page with a timer, **Pause** and
  **Stop & save**. It follows you as you switch tabs.
- <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> starts and stops without opening
  the popup.
- When you stop, the share page opens with your link ready to copy.

Chunks upload while you record, so a long session will not exhaust memory, and
if the browser crashes at minute 40 the first 40 minutes are already on your
server.

## If a recording will not start

The popup shows the last error, with a **Copy** button. **Options → Run
diagnostics** prints a fuller report (browser, permissions, server reachability,
offscreen state, last error) that is worth reading before anything else.

The usual causes:

| What you see | Why | Fix |
|---|---|---|
| *Error starting tab capture* | An old build fell back to the desktop picker | Reload the extension at `chrome://extensions` |
| *…has not been invoked…* | Chrome has not granted tab capture yet | Click the toolbar icon on that tab and start from the popup |
| *Invalid state* | The desktopCapture fallback ran | Nothing to do — retry; the normal path is `getDisplayMedia` |
| Picker opens then closes, nothing saved | Sharing was cancelled or denied | Choose a source and click **Share** |
| *Not connected* | No site address or token saved | Options → paste the address and an `mlt_…` token, then **Save & test connection** |
| Recording runs but the library stays empty | The server rejected the upload | Diagnostics will show the API error; check the token has not been revoked |
| The saved video is a still picture with sound | Fixed in this version | Reload the extension at `chrome://extensions` |
| No voice on the recording, no camera bubble | Camera/mic never allowed | Popup → **Camera & mic access** → Allow |
| *Recording without your microphone* notice | Same, or another program holds the device | As above; diagnostics prints both permission states |

## Notes and limits

- **HTTPS.** If your MyLoom runs on plain `http://`, recording still works from
  the extension but the site itself cannot record. Use HTTPS either way.
- **Screen capture uses `getDisplayMedia()`** from the offscreen document, which
  needs no user gesture there — measured, not assumed. `chrome.desktopCapture`
  is only a fallback, because Chrome ties the id its picker returns to the frame
  the picker was opened for, and an offscreen document is not that frame:
  opening one fails with *Invalid state*, or *Error starting tab capture* when a
  tab was chosen.
- **Tab mode needs the extension invoked on that tab.** Chrome grants tab
  capture only after you click the toolbar icon on the tab in question, so start
  it from the popup — the keyboard shortcut alone is not enough the first time.
- **The two screen modes overlap on purpose.** Chrome's picker lists tabs too,
  so **Screen** can record a tab; **Tab** skips the picker and always takes the
  tab you are on.
- **The control bar needs a normal web page.** On `chrome://` pages, the Web
  Store, or a blank new tab there is nothing to inject into — the toolbar badge
  still shows the timer, and the popup still has Stop.
- **Tab audio** is captured when you tick "Share tab audio" in Chrome's picker.
  On macOS, whole-screen audio is not available to browsers.
- **MP4 vs WebM** is chosen automatically: H.264/MP4 where your browser can
  encode it (so iPhones can play it back), otherwise WebM.
- **Firefox and Safari** are not supported — they implement extension capture
  differently. Use the web recorder there.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Manifest V3 declaration |
| `background.js` | Service worker: state, badge, offscreen lifecycle, control bar |
| `offscreen.js` | Capture, canvas compositing, MediaRecorder, chunked upload |
| `popup.js` | Toolbar popup: mode picker, start/stop |
| `options.js` | Stores and verifies the site address and API token |
| `content-bar.js` | The floating recording bar injected into the page |
| `config.js` | Shared API helpers |

The service worker cannot touch media APIs, so all capture happens in an
offscreen document and reports back by message. `chrome.storage` is not
available to offscreen documents either, which is why the worker reads the
settings and passes them in when starting.

An offscreen document is never rendered, and two ordinary things follow from
that. `requestAnimationFrame` never fires there — measured, 0 calls in three
seconds against 91 from `setInterval` — so the compositing runs on a timer. And
a `<video>` element nothing displays stops being fed, so the frames come from
`MediaStreamTrackProcessor` reading each track directly. Each frame is copied to
a scratch canvas and released at once: hold one back and the capturer runs out
of buffers within seconds.
