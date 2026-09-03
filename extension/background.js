/* ==========================================================================
   MyLoom extension — service worker.

   Owns the recording state, the offscreen document that does the actual
   capture, the toolbar badge, and the floating control bar injected into the
   page. The worker itself cannot touch media APIs, so everything media-related
   is delegated to offscreen.js and reported back by message.
   ========================================================================== */

import { loadSettings } from './config.js';

const OFFSCREEN_PATH = 'offscreen.html';

let state = { status: 'idle', startedAt: 0, uid: null, tabId: null };

/* --- Offscreen document --------------------------------------------------- */

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) { return; }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DISPLAY_MEDIA', 'USER_MEDIA'],
    justification: 'Capture the screen, camera and microphone, and upload the recording.'
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

/**
 * Message the offscreen document, retrying briefly.
 * createDocument() resolves before the module script has finished loading, so
 * the very first message can arrive before the listener exists.
 */
async function askOffscreen(message, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
      if (result !== undefined) { return result; }
    } catch (error) {
      const missing = /Receiving end does not exist|Could not establish connection/i.test(error.message || '');
      if (!missing || i === attempts - 1) { throw error; }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('The capture window did not respond.');
}

/* --- Badge ---------------------------------------------------------------- */

function setBadge(text, colour) {
  chrome.action.setBadgeText({ text: text || '' });
  if (colour) { chrome.action.setBadgeBackgroundColor({ color: colour }); }
}

let tickTimer = null;

function startTicking() {
  stopTicking();
  tickTimer = setInterval(() => {
    if (state.status !== 'recording') { return; }
    const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
    const label = seconds < 60
      ? seconds + 's'
      : Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    setBadge(label, '#e5484d');
    broadcastToBar({ type: 'tick', seconds });
  }, 1000);
}

function stopTicking() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

/* --- Control bar in the page ---------------------------------------------- */

/** The tab to show the control bar in: the active page, if it can be scripted. */
async function pickBarTab() {
  const scriptable = (url) => !!url && /^https?:/i.test(url);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && scriptable(active.url)) { return active.id; }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (fallback && scriptable(fallback.url)) { return fallback.id; }
  const others = await chrome.tabs.query({ currentWindow: true });
  const usable = others.find((tab) => scriptable(tab.url));
  return usable ? usable.id : null;
}

async function injectBar(tabId) {
  if (!tabId) { return; }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-bar.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content-bar.css'] });
  } catch (e) {
    // Restricted pages (chrome://, the Web Store) cannot be scripted. The
    // badge and popup still work, so this is not fatal.
  }
}

function broadcastToBar(message) {
  if (!state.tabId) { return; }
  chrome.tabs.sendMessage(state.tabId, message).catch(() => {});
}

async function removeBar() {
  broadcastToBar({ type: 'teardown' });
}

/* --- Recording lifecycle --------------------------------------------------- */

/**
 * Remember the last failure and tell the user about it.
 * A capture error almost always arrives after the popup has closed, so without
 * this the whole thing looks like nothing happened at all.
 */
async function reportFailure(message) {
  await chrome.storage.local.set({ lastError: { message: String(message), at: Date.now() } });
  if (chrome.notifications && chrome.notifications.create) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'MyLoom — recording did not start',
      message: String(message).slice(0, 240),
      priority: 2
    });
  }
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
}

async function clearLastError() {
  await chrome.storage.local.remove('lastError');
  chrome.action.setBadgeText({ text: '' });
}

async function startRecording(options) {
  if (state.status !== 'idle') { throw new Error('A recording is already running.'); }
  await clearLastError();

  // Offscreen documents only get chrome.runtime — not chrome.storage — so the
  // worker reads the connection settings and hands them over in the message.
  const settings = await loadSettings();
  if (!settings.siteUrl || !settings.token) {
    chrome.runtime.openOptionsPage();
    throw new Error('Connect the extension to your MyLoom first.');
  }

  state.tabId = await pickBarTab();

  await ensureOffscreen();
  let result;
  try {
    result = await askOffscreen({
      type: 'start',
      options: { ...settings.prefs, ...(options || {}), siteUrl: settings.siteUrl, token: settings.token }
    });
  } catch (error) {
    await closeOffscreen();
    state = { status: 'idle', startedAt: 0, uid: null, tabId: null };
    await reportFailure(error.message);
    throw error;
  }
  if (!result || !result.ok) {
    await closeOffscreen();
    state = { status: 'idle', startedAt: 0, uid: null, tabId: null };
    const message = (result && result.error) || 'Could not start recording.';
    // Closing the picker is a choice, not a fault worth shouting about.
    if (!/cancelled/i.test(message)) { await reportFailure(message); }
    throw new Error(message);
  }

  state.status = 'recording';
  state.startedAt = Date.now();
  state.uid = result.uid;
  setBadge('REC', '#e5484d');
  startTicking();
  await injectBar(state.tabId);
  broadcastToBar({ type: 'state', status: 'recording' });
  return result;
}

async function stopRecording() {
  if (state.status === 'idle') { return { ok: true }; }
  state.status = 'finishing';
  setBadge('…', '#625df5');
  broadcastToBar({ type: 'state', status: 'finishing' });

  const result = await askOffscreen({ type: 'stop' }, 4)
    .catch((e) => ({ ok: false, error: e.message }));

  stopTicking();
  setBadge('');
  await removeBar();
  await closeOffscreen();

  const finished = state;
  state = { status: 'idle', startedAt: 0, uid: null, tabId: null };

  if (result && result.ok && result.shareUrl) {
    await clearLastError();
    chrome.tabs.create({ url: result.shareUrl });
  } else if (result && !result.ok) {
    await reportFailure(result.error || 'The recording could not be saved.');
  }
  return result || { ok: false, uid: finished.uid };
}

async function togglePause() {
  if (state.status === 'recording') {
    await askOffscreen({ type: 'pause' }, 3);
    state.status = 'paused';
    setBadge('❚❚', '#c2860a');
    broadcastToBar({ type: 'state', status: 'paused' });
  } else if (state.status === 'paused') {
    await askOffscreen({ type: 'resume' }, 3);
    state.status = 'recording';
    setBadge('REC', '#e5484d');
    broadcastToBar({ type: 'state', status: 'recording' });
  }
  return { ok: true, status: state.status };
}

async function cancelRecording() {
  if (state.status === 'idle') { return { ok: true }; }
  await askOffscreen({ type: 'cancel' }, 3).catch(() => {});
  stopTicking();
  setBadge('');
  await removeBar();
  await closeOffscreen();
  state = { status: 'idle', startedAt: 0, uid: null, tabId: null };
  return { ok: true };
}

/* --- Messages -------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') { return false; }

  const handlers = {
    getState: async () => ({
      ok: true,
      status: state.status,
      seconds: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0
    }),
    start: async () => startRecording(message.options),
    stop: async () => stopRecording(),
    pause: async () => togglePause(),
    cancel: async () => cancelRecording(),
    // Relayed by the offscreen document when the user stops sharing from
    // Chrome's own bar, so the extension does not sit there thinking it is live.
    sourceEnded: async () => stopRecording(),
    uploadProgress: async () => {
      broadcastToBar({ type: 'upload', sent: message.sent, pending: message.pending });
      return { ok: true };
    },
    // Fallback picker for Chrome builds that refuse getDisplayMedia from an
    // offscreen document. Returns a stream id the offscreen doc can open.
    pickDesktopSource: async () => new Promise((resolve) => {
      if (!chrome.desktopCapture || !chrome.desktopCapture.chooseDesktopMedia) {
        resolve({ ok: false, streamId: null, reason: 'desktopCapture unavailable' });
        return;
      }
      // If the picker never comes back, give up rather than wedging the
      // extension with no way out. Generous, so a real choice is never cut off.
      let settled = false;
      const finish = (value) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(guard);
        resolve(value);
      };
      const guard = setTimeout(() => {
        finish({ ok: false, streamId: null, reason: 'The screen picker did not respond.' });
      }, 180000);

      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        try {
          chrome.desktopCapture.chooseDesktopMedia(
            ['screen', 'window', 'tab', 'audio'],
            tab,
            // The second argument tells us whether the chosen source can give
            // an audio track. Asking for audio when it cannot fails the capture.
            (streamId, opts) => {
              if (!streamId) {
                // An empty id means the user closed the picker.
                finish({ ok: false, streamId: null, cancelled: true });
                return;
              }
              finish({
                ok: true,
                streamId,
                canAudio: !!(opts && opts.canRequestAudioTrack)
              });
            }
          );
        } catch (error) {
          finish({ ok: false, streamId: null, reason: error.message });
        }
      }).catch((error) => finish({ ok: false, streamId: null, reason: error.message }));
    }),
    failed: async () => {
      stopTicking();
      setBadge('');
      await removeBar();
      await closeOffscreen();
      state = { status: 'idle', startedAt: 0, uid: null, tabId: null };
      await reportFailure(message.error || 'The recording stopped unexpectedly.');
      return { ok: true };
    },
    clearError: async () => { await clearLastError(); return { ok: true }; },
    diagnose: async () => ({ ok: true, report: await diagnose() })
  };

  const handler = handlers[message.type];
  if (!handler) { return false; }

  handler()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;   // keep the channel open for the async reply
});

/** Collect everything worth knowing when a recording will not start. */
async function diagnose() {
  const lines = [];
  const manifest = chrome.runtime.getManifest();
  const ua = navigator.userAgent.match(/Chrom(e|ium)\/([\d.]+)/);
  lines.push('extension: ' + manifest.name + ' ' + manifest.version);
  lines.push('browser: ' + (ua ? ua[0] : navigator.userAgent));
  lines.push('platform: ' + (navigator.userAgentData?.platform || navigator.platform || 'unknown'));
  lines.push('desktopCapture API: ' + (chrome.desktopCapture?.chooseDesktopMedia ? 'available' : 'MISSING'));
  lines.push('offscreen API: ' + (chrome.offscreen ? 'available' : 'MISSING'));
  lines.push('notifications API: ' + (chrome.notifications ? 'available' : 'MISSING'));

  const settings = await loadSettings();
  lines.push('site: ' + (settings.siteUrl || '(not set)'));
  lines.push('token: ' + (settings.token ? settings.token.slice(0, 8) + '… (' + settings.token.length + ' chars)' : '(not set)'));

  if (settings.siteUrl && settings.token) {
    try {
      const response = await fetch(
        settings.siteUrl.replace(/\/+$/, '') + '/api.php?r=tokens/whoami',
        { headers: { Authorization: 'Bearer ' + settings.token } }
      );
      const data = await response.json().catch(() => null);
      lines.push('api check: HTTP ' + response.status + ' ' +
        (data && data.ok ? 'ok, user ' + data.user.name : (data && data.error) || 'unreadable'));
    } catch (error) {
      lines.push('api check: FAILED — ' + error.message);
    }
  }

  try {
    await ensureOffscreen();
    const pong = await askOffscreen({ type: 'ping' }, 8);
    lines.push('offscreen document: ' + (pong && pong.ok ? 'responds' : 'created but silent'));
    await closeOffscreen();
  } catch (error) {
    lines.push('offscreen document: FAILED — ' + error.message);
  }

  const stored = await chrome.storage.local.get('lastError');
  if (stored.lastError) {
    lines.push('last error: ' + stored.lastError.message +
      ' (' + new Date(stored.lastError.at).toLocaleString() + ')');
  }
  return lines.join('\n');
}

chrome.commands?.onCommand?.addListener(async (command) => {
  if (command !== 'toggle-recording') { return; }
  if (state.status === 'idle') {
    await startRecording({}).catch(() => chrome.action.openPopup?.());
  } else {
    await stopRecording();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') { chrome.runtime.openOptionsPage(); }
});
