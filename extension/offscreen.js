/* ==========================================================================
   MyLoom extension — offscreen capture host.

   Acquires the screen/camera/microphone, composites them onto a canvas when a
   camera bubble is wanted, records with MediaRecorder, and streams the chunks
   to the user's own MyLoom while recording — the same approach the web app
   uses, so length is bounded by their disk rather than memory.
   ========================================================================== */

import { api, uploadChunk } from './config.js';

const state = {
  recorder: null,
  streams: [],
  audioContext: null,
  monitor: null,
  canvas: null,
  ctx: null,
  frameTimer: null,
  screenSrc: null,
  camSrc: null,
  bubble: { corner: 'bl', size: 0.24 },
  upload: { key: null, uid: null, index: 0, sent: 0, queue: [], busy: false, failures: 0, done: false },
  settings: null,
  startedAt: 0,
  pausedTotal: 0,
  pausedAt: 0,
  shareUrl: null
};

const MP4_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
  'video/mp4;codecs=h264,aac'
];
const WEBM_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

function pickType() {
  for (const type of [...MP4_TYPES, ...WEBM_TYPES]) {
    if (MediaRecorder.isTypeSupported(type)) { return type; }
  }
  return '';
}

/* --- Capture --------------------------------------------------------------- */

function cancelled() {
  const error = new Error('Screen sharing was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Acquire the screen: a display, a window, or a tab from Chrome's picker. */
async function getScreen(options) {
  // getDisplayMedia works from an offscreen document and does NOT need a user
  // gesture here — measured, not assumed. Its picker also lists tabs, so
  // choosing a tab from it works, unlike the desktopCapture picker below.
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: options.systemAudio !== false
    });
  } catch (error) {
    // Closing the picker is a choice, not a fault.
    if (error && (error.name === 'NotAllowedError' || /permission denied/i.test(error.message || ''))) {
      throw cancelled();
    }
    return pickerFallback(options, error);
  }
}

/**
 * Last resort for a Chrome build that refuses getDisplayMedia here.
 *
 * Chrome binds a desktopCapture stream id to the frame the picker was opened
 * for, and an offscreen document is not that frame — opening the id then fails
 * with "Invalid state", or "Error starting tab capture" when a tab was chosen.
 * So this is a fallback only, and it says what went wrong either way.
 */
async function pickerFallback(options, firstError) {
  const picked = await chrome.runtime
    .sendMessage({ type: 'pickDesktopSource' })
    .catch(() => null);

  if (picked && picked.cancelled) { throw cancelled(); }
  if (!picked || !picked.streamId) {
    throw new Error('Screen capture was refused: ' + (firstError && firstError.message
      ? firstError.message
      : 'no source was chosen') + '.');
  }

  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: picked.streamId,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 30
    }
  };
  // Only ask for the audio track when the picker said it is available:
  // requesting it otherwise fails the whole getUserMedia call.
  const wantAudio = options.systemAudio !== false && picked.canAudio === true;
  try {
    return await navigator.mediaDevices.getUserMedia({
      video,
      audio: wantAudio
        ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: picked.streamId } }
        : false
    });
  } catch (error) {
    if (wantAudio) {
      // Some sources advertise audio then refuse it; keep the video.
      try { return await navigator.mediaDevices.getUserMedia({ video, audio: false }); } catch (ignored) { /* fall through */ }
    }
    throw new Error('Chrome would not share that source (' + error.message + '). '
      + 'Try "Tab" mode if you want to record a single tab.');
  }
}

/**
 * Capture the tab the user is on.
 *
 * Tab capture silences the tab for the person recording, so the audio is also
 * routed to the speakers — otherwise a video they are narrating goes quiet and
 * it looks broken.
 */
async function getTab(options) {
  const picked = await chrome.runtime.sendMessage({ type: 'getTabStreamId' }).catch(() => null);
  if (!picked || !picked.ok || !picked.streamId) {
    throw new Error((picked && picked.reason) || 'Could not capture this tab.');
  }

  const constraints = {
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: picked.streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    },
    audio: options.systemAudio !== false
      ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: picked.streamId } }
      : false
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if (constraints.audio === false) { throw error; }
    // Keep the video if the tab will not give up its audio.
    constraints.audio = false;
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  }

  if (stream.getAudioTracks().length) {
    try {
      state.monitor = new AudioContext();
      state.monitor.createMediaStreamSource(stream).connect(state.monitor.destination);
    } catch (e) {
      // Monitoring is a nicety; a failure here must not stop the recording.
    }
  }
  return stream;
}

/**
 * A live picture from a track, readable while the document is never rendered.
 *
 * A <video> element is the obvious way to hold a MediaStream, and it is the
 * wrong one here: nothing displays it, so Chrome stops pulling frames from the
 * screen capturer and the element sits on whichever frame it had first — sound
 * and a still. MediaStreamTrackProcessor reads the track itself, with no
 * rendering in the middle. The element stays as a fallback.
 */
async function frameSource(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) { return null; }

  if (typeof MediaStreamTrackProcessor === 'function' && typeof OffscreenCanvas === 'function') {
    // Copy each frame on arrival and release it immediately. Holding even one
    // frame back keeps a buffer out of the capturer's small pool, and screen
    // capture stops delivering within a few seconds — a picture that moves,
    // briefly, then stops.
    const scratch = new OffscreenCanvas(2, 2);
    const scratchCtx = scratch.getContext('2d');
    const source = { latest: null, width: 0, height: 0, frames: 0, stop: null };
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let stopped = false;

    (async () => {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) { break; }
        try {
          if (scratch.width !== value.displayWidth || scratch.height !== value.displayHeight) {
            scratch.width = value.displayWidth;
            scratch.height = value.displayHeight;
          }
          scratchCtx.drawImage(value, 0, 0, scratch.width, scratch.height);
          source.width = scratch.width;
          source.height = scratch.height;
          source.latest = scratch;
          source.frames++;
        } finally {
          value.close();
        }
      }
    })().catch(() => { /* the track ended; the recording is stopping anyway */ });

    source.stop = () => {
      stopped = true;
      reader.cancel().catch(() => {});
      source.latest = null;
    };

    // Wait for the first frame so the canvas can be sized to it.
    const deadline = Date.now() + 4000;
    while (!source.latest && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    if (source.latest) { return source; }
    source.stop();
  }

  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  return {
    get latest() { return video.videoWidth ? video : null; },
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    stop() { video.srcObject = null; }
  };
}

function sizeCanvas(mode) {
  let width = 1280, height = 720;
  const source = mode === 'camera' ? state.camSrc : state.screenSrc;   // tab shares screenSrc
  if (source && source.width) {
    width = source.width;
    height = source.height;
  }
  const scale = Math.min(1, 1920 / width, 1080 / height);
  state.canvas.width = Math.round((width * scale) / 2) * 2;
  state.canvas.height = Math.round((height * scale) / 2) * 2;
}

const FPS = 30;
const BUBBLE_SIZES = { s: 0.18, m: 0.24, l: 0.32 };
const BUBBLE_MARGIN = 0.04;

/** Where the camera bubble sits, from the chosen corner. Read every frame, so
 *  moving it mid-recording takes effect on the next one. */
function bubbleRect(w, h) {
  const size = state.bubble.size * h;
  const corner = state.bubble.corner || 'bl';
  const x = corner.indexOf('l') >= 0 ? BUBBLE_MARGIN * w : w - BUBBLE_MARGIN * w - size;
  const y = corner.indexOf('t') >= 0 ? BUBBLE_MARGIN * h : h - BUBBLE_MARGIN * h - size;
  return { size, cx: x + size / 2, cy: y + size / 2, radius: size / 2 };
}

/**
 * Composite the sources onto the canvas, over and over.
 *
 * On a timer, not requestAnimationFrame. An offscreen document is never
 * rendered, so it is never animated either: measured over three seconds in one,
 * requestAnimationFrame fired 0 times and requestVideoFrameCallback 0 times,
 * while setInterval fired 91. With rAF the canvas held its first frame for the
 * whole recording — sound, and a still picture.
 */
function drawLoop(mode, showBubble) {
  const { ctx, canvas } = state;
  const render = () => {
    try { paint(); } catch (error) { /* skip this frame, keep the recording */ }
  };
  const paint = () => {
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const base = mode === 'camera' ? state.camSrc : state.screenSrc;
    if (base && base.latest && base.width) {
      const ratio = Math.min(w / base.width, h / base.height);
      const dw = base.width * ratio, dh = base.height * ratio;
      ctx.drawImage(base.latest, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }

    if (showBubble && state.camSrc && state.camSrc.latest && state.camSrc.width) {
      const { size, cx, cy, radius } = bubbleRect(w, h);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const vw = state.camSrc.width, vh = state.camSrc.height;
      const scale = Math.max(size / vw, size / vh);
      ctx.drawImage(state.camSrc.latest, cx - (vw * scale) / 2, cy - (vh * scale) / 2, vw * scale, vh * scale);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, radius * 0.045);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.stroke();
    }
  };
  render();
  state.frameTimer = setInterval(render, Math.round(1000 / FPS));
}

function mixAudio(micStream, screenStream) {
  const sources = [];
  if (micStream && micStream.getAudioTracks().length) { sources.push(micStream); }
  if (screenStream && screenStream.getAudioTracks().length) { sources.push(screenStream); }
  if (!sources.length) { return null; }
  if (sources.length === 1) { return sources[0].getAudioTracks()[0]; }

  state.audioContext = new AudioContext();
  const destination = state.audioContext.createMediaStreamDestination();
  sources.forEach((stream) => {
    state.audioContext.createMediaStreamSource(stream).connect(destination);
  });
  return destination.stream.getAudioTracks()[0];
}

/* --- Upload ---------------------------------------------------------------- */

async function pump() {
  const { upload, settings } = state;
  if (upload.busy || !upload.queue.length || !upload.key) { return; }
  upload.busy = true;
  const blob = upload.queue[0];

  try {
    const response = await uploadChunk(settings.siteUrl, settings.token, upload.key, upload.index, blob);
    upload.queue.shift();
    upload.index++;
    upload.sent = response.received || upload.sent + blob.size;
    upload.failures = 0;
    upload.busy = false;
    chrome.runtime.sendMessage({
      type: 'uploadProgress', sent: upload.sent, pending: upload.queue.length
    }).catch(() => {});
    await pump();
  } catch (error) {
    upload.busy = false;
    upload.failures++;
    if (upload.failures >= 5) {
      fail('Upload failed after several retries: ' + error.message);
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(8000, 600 * 2 ** upload.failures)));
    await pump();
  }
}

async function drain() {
  await pump();
  while (state.upload.queue.length || state.upload.busy) {
    await new Promise((r) => setTimeout(r, 250));
    await pump();
  }
}

function fail(message) {
  cleanup();
  chrome.runtime.sendMessage({ type: 'failed', error: message }).catch(() => {});
}

/* --- Lifecycle -------------------------------------------------------------- */

async function start(options) {
  // The service worker supplies these: chrome.storage is not available here.
  state.settings = { siteUrl: options.siteUrl, token: options.token };
  if (!state.settings.siteUrl || !state.settings.token) {
    throw new Error('Set your MyLoom address and API token in the extension options first.');
  }

  // 'screen' (a display or window), 'tab' (this tab) or 'camera'.
  // The camera bubble is independent, so it can sit over a screen or a tab.
  const mode = options.mode === 'tab' || options.mode === 'camera' ? options.mode : 'screen';
  const showBubble = mode !== 'camera' && options.camBubble !== false;
  state.bubble = {
    corner: ['tl', 'tr', 'bl', 'br'].includes(options.bubbleCorner) ? options.bubbleCorner : 'bl',
    size: BUBBLE_SIZES[options.bubbleSize] || BUBBLE_SIZES.m
  };
  let screenStream = null, camStream = null, micStream = null;
  // Anything asked for and not granted, so the recording does not end up
  // silently missing a voice or a face with nobody told.
  const missing = [];

  if (mode !== 'camera') {
    screenStream = mode === 'tab' ? await getTab(options) : await getScreen(options);
    state.streams.push(screenStream);
    state.screenSrc = await frameSource(screenStream);
    // Chrome's own "Stop sharing" bar ends the track; treat that as Stop.
    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      chrome.runtime.sendMessage({ type: 'sourceEnded' }).catch(() => {});
    });
  }

  if (mode === 'camera' || showBubble) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false
      });
      state.streams.push(camStream);
      state.camSrc = await frameSource(camStream);
    } catch (error) {
      // No camera is only fatal when the camera *is* the recording.
      if (mode === 'camera') { throw error; }
      missing.push(error.name === 'NotAllowedError' ? 'camera (not allowed)' : 'camera');
    }
  }

  if (options.mic !== false) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      state.streams.push(micStream);
    } catch (error) {
      // Carry on — a silent recording beats no recording — but say so.
      missing.push(error.name === 'NotAllowedError' ? 'microphone (not allowed)' : 'microphone');
    }
  }

  state.canvas = document.createElement('canvas');
  state.ctx = state.canvas.getContext('2d');
  sizeCanvas(mode);
  drawLoop(mode, showBubble && !!state.camSrc);

  const videoTrack = state.canvas.captureStream(FPS).getVideoTracks()[0];
  const audioTrack = mixAudio(micStream, screenStream);
  const mixed = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);

  const mimeType = pickType();
  const created = await api(state.settings.siteUrl, state.settings.token, 'videos/create', {
    // Map onto the source values the server stores.
    source: mode === 'camera' ? 'camera' : (showBubble && state.camSrc ? 'screen_camera' : 'screen'),
    mime: (mimeType.split(';')[0]) || 'video/webm',
    title: options.title || ('Recording ' + new Date().toLocaleString()),
    visibility: 'link'
  });

  state.upload = {
    key: created.upload_key, uid: created.uid, index: 0, sent: 0,
    queue: [], busy: false, failures: 0, done: false
  };
  state.shareUrl = created.share_url;

  state.recorder = new MediaRecorder(mixed, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 2500000,
    audioBitsPerSecond: 128000
  });
  state.recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) { state.upload.queue.push(event.data); pump(); }
  };
  state.recorder.onerror = () => fail('The recorder stopped unexpectedly.');
  state.recorder.start(3000);

  state.startedAt = performance.now();
  state.pausedTotal = 0;
  return {
    ok: true,
    uid: created.uid,
    shareUrl: created.share_url,
    missing,
    // Lets the page bar show a corner button only when there is a bubble to move.
    bubble: showBubble && state.camSrc ? state.bubble.corner : null
  };
}

function elapsed() {
  if (!state.startedAt) { return 0; }
  const now = state.recorder && state.recorder.state === 'paused' ? state.pausedAt : performance.now();
  return Math.max(0, (now - state.startedAt - state.pausedTotal) / 1000);
}

function thumbnail() {
  try {
    const thumb = document.createElement('canvas');
    const scale = Math.min(1, 640 / state.canvas.width);
    thumb.width = Math.round(state.canvas.width * scale);
    thumb.height = Math.round(state.canvas.height * scale);
    thumb.getContext('2d').drawImage(state.canvas, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL('image/jpeg', 0.72);
  } catch (e) { return ''; }
}

async function stop() {
  if (!state.recorder || state.upload.done) { return { ok: true, shareUrl: state.shareUrl }; }
  const seconds = elapsed();
  const poster = thumbnail();

  await new Promise((resolve) => {
    state.recorder.onstop = resolve;
    try { state.recorder.stop(); } catch (e) { resolve(); }
  });

  await drain();
  const finished = await api(state.settings.siteUrl, state.settings.token, 'upload/finish', {
    key: state.upload.key,
    duration: Number(seconds.toFixed(2)),
    width: state.canvas.width,
    height: state.canvas.height,
    thumbnail_data: poster
  });
  state.upload.done = true;
  cleanup();
  return { ok: true, uid: state.upload.uid, shareUrl: finished.share_url || state.shareUrl };
}

async function cancel() {
  const key = state.upload.key;
  const settings = state.settings;
  state.upload.done = true;
  state.upload.queue = [];
  if (state.recorder && state.recorder.state !== 'inactive') {
    try { state.recorder.stop(); } catch (e) { /* ignore */ }
  }
  cleanup();
  if (key && settings) {
    await api(settings.siteUrl, settings.token, 'upload/abort', { key }).catch(() => {});
  }
  return { ok: true };
}

function cleanup() {
  if (state.frameTimer) { clearInterval(state.frameTimer); state.frameTimer = null; }
  state.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  state.streams = [];
  if (state.audioContext) { state.audioContext.close().catch(() => {}); state.audioContext = null; }
  if (state.monitor) { state.monitor.close().catch(() => {}); state.monitor = null; }
  if (state.screenSrc) { state.screenSrc.stop(); state.screenSrc = null; }
  if (state.camSrc) { state.camSrc.stop(); state.camSrc = null; }
}

/* --- Messages ---------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') { return false; }

  const run = async () => {
    switch (message.type) {
      case 'ping': return { ok: true };
      case 'start': return start(message.options || {});
      // Moving the bubble while recording: the draw loop reads this each frame.
      case 'setBubble': {
        if (['tl', 'tr', 'bl', 'br'].includes(message.corner)) { state.bubble.corner = message.corner; }
        if (BUBBLE_SIZES[message.size]) { state.bubble.size = BUBBLE_SIZES[message.size]; }
        return { ok: true, corner: state.bubble.corner };
      }
      case 'stop': return stop();
      case 'cancel': return cancel();
      case 'pause':
        if (state.recorder && state.recorder.state === 'recording') {
          state.recorder.pause();
          state.pausedAt = performance.now();
        }
        return { ok: true };
      case 'resume':
        if (state.recorder && state.recorder.state === 'paused') {
          state.pausedTotal += performance.now() - state.pausedAt;
          state.recorder.resume();
        }
        return { ok: true };
      default: return { ok: false, error: 'Unknown command' };
    }
  };

  run()
    .then((result) => sendResponse(result))
    .catch((error) => {
      cleanup();
      sendResponse({ ok: false, error: error.name === 'NotAllowedError'
        ? 'Screen sharing was cancelled.'
        : (error.message || String(error)) });
    });
  return true;
});
