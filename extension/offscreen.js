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
  rafId: null,
  screenVideo: null,
  camVideo: null,
  bubble: { x: 0.04, y: 0.72, size: 0.24 },
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

/**
 * Acquire the screen.
 *
 * chrome.desktopCapture is the primary path: an offscreen document has no
 * transient user activation, and getDisplayMedia() requires one, so calling it
 * here throws NotAllowedError before the user ever sees a picker. The worker
 * can open Chrome's own source picker instead and hand back a stream id.
 * getDisplayMedia stays as a fallback for builds without desktopCapture.
 */
async function getScreen(options) {
  const picked = await chrome.runtime
    .sendMessage({ type: 'pickDesktopSource' })
    .catch(() => null);

  if (picked && picked.cancelled) { throw cancelled(); }

  if (picked && picked.streamId) {
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
      if (!wantAudio) { throw error; }
      // Some sources advertise audio then refuse it; keep the video.
      return navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
  }

  // No stream id: fall back to the standard API and let it report why.
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: options.systemAudio !== false
  });
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

function sizeCanvas(mode) {
  let width = 1280, height = 720;
  const source = mode === 'camera' ? state.camVideo : state.screenVideo;   // tab shares screenVideo
  if (source && source.videoWidth) {
    width = source.videoWidth;
    height = source.videoHeight;
  }
  const scale = Math.min(1, 1920 / width, 1080 / height);
  state.canvas.width = Math.round((width * scale) / 2) * 2;
  state.canvas.height = Math.round((height * scale) / 2) * 2;
}

function drawLoop(mode, showBubble) {
  const { ctx, canvas } = state;
  const render = () => {
    state.rafId = requestAnimationFrame(render);
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const base = mode === 'camera' ? state.camVideo : state.screenVideo;
    if (base && base.videoWidth) {
      const ratio = Math.min(w / base.videoWidth, h / base.videoHeight);
      const dw = base.videoWidth * ratio, dh = base.videoHeight * ratio;
      ctx.drawImage(base, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }

    if (showBubble && state.camVideo && state.camVideo.videoWidth) {
      const size = state.bubble.size * h;
      const cx = state.bubble.x * w + size / 2;
      const cy = state.bubble.y * h + size / 2;
      const radius = size / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const vw = state.camVideo.videoWidth, vh = state.camVideo.videoHeight;
      const scale = Math.max(size / vw, size / vh);
      ctx.drawImage(state.camVideo, cx - (vw * scale) / 2, cy - (vh * scale) / 2, vw * scale, vh * scale);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, radius * 0.045);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.stroke();
    }
  };
  render();
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
  let screenStream = null, camStream = null, micStream = null;

  if (mode !== 'camera') {
    screenStream = mode === 'tab' ? await getTab(options) : await getScreen(options);
    state.streams.push(screenStream);
    state.screenVideo = document.createElement('video');
    state.screenVideo.muted = true;
    state.screenVideo.srcObject = screenStream;
    await state.screenVideo.play();
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
      state.camVideo = document.createElement('video');
      state.camVideo.muted = true;
      state.camVideo.srcObject = camStream;
      await state.camVideo.play();
    } catch (error) {
      // No camera is only fatal when the camera *is* the recording.
      if (mode === 'camera') { throw error; }
    }
  }

  if (options.mic !== false) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      state.streams.push(micStream);
    } catch (e) { /* carry on without a microphone */ }
  }

  state.canvas = document.createElement('canvas');
  state.ctx = state.canvas.getContext('2d');
  sizeCanvas(mode);
  drawLoop(mode, showBubble && !!state.camVideo);

  const videoTrack = state.canvas.captureStream(30).getVideoTracks()[0];
  const audioTrack = mixAudio(micStream, screenStream);
  const mixed = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);

  const mimeType = pickType();
  const created = await api(state.settings.siteUrl, state.settings.token, 'videos/create', {
    // Map onto the source values the server stores.
    source: mode === 'camera' ? 'camera' : (showBubble && state.camVideo ? 'screen_camera' : 'screen'),
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
  return { ok: true, uid: created.uid, shareUrl: created.share_url };
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
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
  state.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  state.streams = [];
  if (state.audioContext) { state.audioContext.close().catch(() => {}); state.audioContext = null; }
  if (state.monitor) { state.monitor.close().catch(() => {}); state.monitor = null; }
  if (state.screenVideo) { state.screenVideo.srcObject = null; }
  if (state.camVideo) { state.camVideo.srcObject = null; }
}

/* --- Messages ---------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') { return false; }

  const run = async () => {
    switch (message.type) {
      case 'ping': return { ok: true };
      case 'start': return start(message.options || {});
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
