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

## Using it

- Click the toolbar icon on any page, pick **Screen + cam**, **Screen** or
  **Camera**, and press **Start recording**.
- A bar appears at the bottom of the page with a timer, **Pause** and
  **Stop & save**. It follows you as you switch tabs.
- <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> starts and stops without opening
  the popup.
- When you stop, the share page opens with your link ready to copy.

Chunks upload while you record, so a long session will not exhaust memory, and
if the browser crashes at minute 40 the first 40 minutes are already on your
server.

## Notes and limits

- **HTTPS.** If your MyLoom runs on plain `http://`, recording still works from
  the extension but the site itself cannot record. Use HTTPS either way.
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
