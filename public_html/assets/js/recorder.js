/* ==========================================================================
   MyLoom recorder — screen / camera / screen+camera capture.

   Screen modes are composited onto a canvas so the camera bubble and the
   drawing layer are burned into a single track. Audio (mic + system) is mixed
   through a WebAudio graph. MediaRecorder blobs are uploaded while recording,
   so length is bounded by disk space, not browser memory.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el;

  var PEN_COLORS = ['#ff3b3b', '#ffd23f', '#3ddc84', '#4da3ff', '#ffffff'];

  /**
   * Choose a container. MP4/H.264 is preferred because Safari and iOS cannot
   * play VP8/VP9 WebM, so a WebM recording would be unwatchable for those
   * viewers. Only explicit H.264 codec strings count — a bare "video/mp4"
   * probe returns true on builds that then fail to encode.
   */
  var MP4_TYPES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
    'video/mp4;codecs=h264,aac'
  ];
  var WEBM_TYPES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm'
  ];

  function pickMimeType(prefer) {
    if (!window.MediaRecorder) { return ''; }
    var order = prefer === 'webm' ? WEBM_TYPES.concat(MP4_TYPES) : MP4_TYPES.concat(WEBM_TYPES);
    for (var i = 0; i < order.length; i++) {
      if (MediaRecorder.isTypeSupported(order[i])) { return order[i]; }
    }
    return '';
  }

  /** Build a MediaRecorder, falling back through the candidate list on failure. */
  function buildRecorder(stream, prefer, options) {
    var order = (prefer === 'webm' ? WEBM_TYPES.concat(MP4_TYPES) : MP4_TYPES.concat(WEBM_TYPES))
      .filter(function (type) { return MediaRecorder.isTypeSupported(type); });
    order.push('');
    var lastError = null;
    for (var i = 0; i < order.length; i++) {
      try {
        var settings = {
          videoBitsPerSecond: options.videoBitrate || 2500000,
          audioBitsPerSecond: 128000
        };
        if (order[i]) { settings.mimeType = order[i]; }
        return new MediaRecorder(stream, settings);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('This browser could not start a recorder.');
  }

  /**
   * Recorder(options)
   *   options.onState(state)      'idle'|'preview'|'countdown'|'recording'|'paused'|'finishing'|'done'
   *   options.onTick(seconds)
   *   options.onUpload(sentBytes, pending)
   *   options.onError(error)
   */
  function Recorder(options) {
    options = options || {};

    var self = {
      mode: 'screen_camera',
      state: 'idle',
      micEnabled: true,
      systemAudio: true,
      captureTranscript: true,
      penEnabled: false,
      penColor: PEN_COLORS[0]
    };

    var screenStream = null;
    var camStream = null;
    var micStream = null;
    var mixedStream = null;
    var recorder = null;
    var audioContext = null;

    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var drawCanvas = document.createElement('canvas');
    var drawCtx = drawCanvas.getContext('2d');

    var screenVideo = document.createElement('video');
    var camVideo = document.createElement('video');
    [screenVideo, camVideo].forEach(function (node) {
      node.muted = true;
      node.playsInline = true;
      node.setAttribute('playsinline', '');
    });

    var rafId = null;
    var startedAt = 0;
    var pausedTotal = 0;
    var pausedAt = 0;
    var tickTimer = null;

    // Camera bubble geometry, normalised 0-1 against the canvas.
    var bubble = { x: 0.04, y: 0.72, size: 0.24 };

    // Upload state
    var upload = { key: null, uid: null, index: 0, sent: 0, queue: [], busy: false, failed: 0, done: false };

    // Transcript capture
    var recognition = null;
    var segments = [];

    /* --- Capability guard -------------------------------------------------- */

    function assertSupported() {
      var caps = ML.capabilities();
      if (!caps.secure) {
        throw new Error('Screen recording needs a secure connection. Open this site over HTTPS (enable AutoSSL in cPanel).');
      }
      if (!caps.recorder) {
        throw new Error('This browser does not support MediaRecorder. Try the latest Chrome, Edge or Firefox.');
      }
      if (self.mode !== 'camera' && !caps.displayCapture) {
        throw new Error('Screen capture is not available in this browser. Chrome, Edge and Firefox on desktop support it.');
      }
      if (self.mode !== 'screen' && !caps.userMedia) {
        throw new Error('Camera access is not available in this browser.');
      }
    }

    function setState(state) {
      self.state = state;
      if (options.onState) { options.onState(state); }
    }

    /* --- Source acquisition ------------------------------------------------ */

    function getScreen() {
      return navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: options.fps || 30, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          cursor: 'always'
        },
        audio: self.systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false
      });
    }

    function getCamera() {
      return navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 }, height: { ideal: 720 },
          facingMode: 'user',
          deviceId: options.cameraId ? { exact: options.cameraId } : undefined
        },
        audio: false
      });
    }

    function getMic() {
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
          deviceId: options.micId ? { exact: options.micId } : undefined
        },
        video: false
      });
    }

    /** Acquire every source the current mode needs and show a live preview. */
    self.prepare = function () {
      assertSupported();
      return stopSources().then(function () {
        var jobs = [];
        if (self.mode !== 'camera') {
          jobs.push(getScreen().then(function (stream) {
            screenStream = stream;
            screenVideo.srcObject = stream;
            // The user can stop sharing from the browser's own bar.
            stream.getVideoTracks()[0].addEventListener('ended', function () {
              if (self.state === 'recording' || self.state === 'paused') { self.stop(); }
              else { self.cancel(); }
            });
            return screenVideo.play();
          }));
        }
        if (self.mode !== 'screen') {
          jobs.push(getCamera().then(function (stream) {
            camStream = stream;
            camVideo.srcObject = stream;
            return camVideo.play();
          }));
        }
        if (self.micEnabled) {
          jobs.push(getMic().then(function (stream) { micStream = stream; })
            .catch(function () {
              self.micEnabled = false;
              ML.toast('Microphone unavailable — recording without voice.', 'error');
            }));
        }
        return Promise.all(jobs);
      }).then(function () {
        sizeCanvas();
        startRenderLoop();
        setState('preview');
        return true;
      });
    };

    function sizeCanvas() {
      var width = 1280, height = 720;
      if (self.mode === 'camera' && camStream) {
        var camSettings = camStream.getVideoTracks()[0].getSettings();
        width = camSettings.width || 1280;
        height = camSettings.height || 720;
      } else if (screenStream) {
        var settings = screenStream.getVideoTracks()[0].getSettings();
        width = settings.width || 1920;
        height = settings.height || 1080;
      }
      // Cap at 1080p so file sizes stay reasonable on shared hosting.
      var scale = Math.min(1, 1920 / width, 1080 / height);
      canvas.width = Math.round(width * scale / 2) * 2;
      canvas.height = Math.round(height * scale / 2) * 2;
      drawCanvas.width = canvas.width;
      drawCanvas.height = canvas.height;
    }

    /* --- Compositing ------------------------------------------------------- */

    function startRenderLoop() {
      if (rafId) { return; }
      var loop = function () {
        rafId = requestAnimationFrame(loop);
        drawFrame();
      };
      rafId = requestAnimationFrame(loop);
    }

    function stopRenderLoop() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function drawFrame() {
      var w = canvas.width, h = canvas.height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);

      var base = self.mode === 'camera' ? camVideo : screenVideo;
      if (base && base.videoWidth) {
        var ratio = Math.min(w / base.videoWidth, h / base.videoHeight);
        var dw = base.videoWidth * ratio, dh = base.videoHeight * ratio;
        ctx.drawImage(base, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }

      if (self.mode === 'screen_camera' && camVideo.videoWidth) {
        drawBubble(w, h);
      }
      ctx.drawImage(drawCanvas, 0, 0);
    }

    function drawBubble(w, h) {
      var size = bubble.size * h;
      var cx = bubble.x * w + size / 2;
      var cy = bubble.y * h + size / 2;
      var radius = size / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.shadowColor = 'rgba(0,0,0,.45)';
      ctx.shadowBlur = radius * 0.22;
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.clip();

      // Cover-fit the camera frame inside the circle.
      var vw = camVideo.videoWidth, vh = camVideo.videoHeight;
      var scale = Math.max(size / vw, size / vh);
      var dw = vw * scale, dh = vh * scale;
      ctx.drawImage(camVideo, cx - dw / 2, cy - dh / 2, dw, dh);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, radius * 0.045);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.stroke();
    }

    /* --- Drawing layer ----------------------------------------------------- */

    var drawing = false;
    var lastPoint = null;

    self.penStart = function (nx, ny) {
      if (!self.penEnabled) { return; }
      drawing = true;
      lastPoint = { x: nx * drawCanvas.width, y: ny * drawCanvas.height };
    };
    self.penMove = function (nx, ny) {
      if (!drawing || !self.penEnabled) { return; }
      var point = { x: nx * drawCanvas.width, y: ny * drawCanvas.height };
      drawCtx.strokeStyle = self.penColor;
      drawCtx.lineWidth = Math.max(3, drawCanvas.height * 0.005);
      drawCtx.lineCap = 'round';
      drawCtx.lineJoin = 'round';
      drawCtx.beginPath();
      drawCtx.moveTo(lastPoint.x, lastPoint.y);
      drawCtx.lineTo(point.x, point.y);
      drawCtx.stroke();
      lastPoint = point;
    };
    self.penEnd = function () { drawing = false; lastPoint = null; };
    self.clearDrawing = function () { drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height); };

    /** Move the camera bubble; coordinates are 0-1 relative to the stage. */
    self.moveBubble = function (nx, ny) {
      bubble.x = Math.max(0, Math.min(1 - bubble.size * (canvas.height / canvas.width), nx));
      bubble.y = Math.max(0, Math.min(1 - bubble.size, ny));
    };
    self.setBubbleSize = function (size) {
      bubble.size = Math.max(0.1, Math.min(0.45, size));
    };
    self.getBubble = function () { return bubble; };
    self.previewCanvas = canvas;

    /* --- Audio mixing ------------------------------------------------------ */

    function buildAudioTrack() {
      var sources = [];
      if (micStream && micStream.getAudioTracks().length) { sources.push(micStream); }
      if (screenStream && screenStream.getAudioTracks().length) { sources.push(screenStream); }
      if (!sources.length) { return null; }
      if (sources.length === 1) { return sources[0].getAudioTracks()[0]; }

      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioCtx();
      var destination = audioContext.createMediaStreamDestination();
      sources.forEach(function (stream) {
        var node = audioContext.createMediaStreamSource(stream);
        var gain = audioContext.createGain();
        gain.gain.value = 1;
        node.connect(gain).connect(destination);
      });
      return destination.stream.getAudioTracks()[0];
    }

    /* --- Recording --------------------------------------------------------- */

    self.start = function (meta) {
      meta = meta || {};
      if (self.state !== 'preview') {
        return Promise.reject(new Error('Set up your sources before recording.'));
      }
      setState('countdown');

      return countdown(options.countdown === 0 ? 0 : (options.countdown || 3))
        .then(function () {
          var videoTrack = canvas.captureStream(options.fps || 30).getVideoTracks()[0];
          var audioTrack = buildAudioTrack();
          mixedStream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);

          recorder = buildRecorder(mixedStream, options.container, options);
          var mimeType = recorder.mimeType || pickMimeType(options.container) || 'video/webm';

          return ML.post('videos/create', {
            source: self.mode,
            mime: mimeType.split(';')[0] || 'video/webm',
            title: meta.title || 'Untitled recording',
            space_id: meta.spaceId || 0,
            visibility: meta.visibility || 'link'
          }).then(function (response) {
            upload.key = response.upload_key;
            upload.uid = response.uid;
            upload.index = 0;
            upload.sent = 0;
            upload.done = false;

            recorder.ondataavailable = function (event) {
              if (event.data && event.data.size > 0) {
                upload.queue.push(event.data);
                pumpQueue();
              }
            };
            recorder.onerror = function (event) {
              fail(new Error('Recording stopped unexpectedly: ' + (event.error && event.error.name)));
            };
            recorder.start(options.chunkMs || 3000);

            startedAt = performance.now();
            pausedTotal = 0;
            startTicking();
            if (self.captureTranscript) { startRecognition(); }
            setState('recording');
            return { uid: upload.uid };
          });
        });
    };

    function countdown(seconds) {
      if (!seconds) { return Promise.resolve(); }
      return new Promise(function (resolve) {
        var overlay = el('div.countdown-overlay');
        var num = el('div.countdown-num', { text: String(seconds) });
        overlay.appendChild(num);
        document.body.appendChild(overlay);
        var remaining = seconds;
        var timer = setInterval(function () {
          remaining--;
          if (remaining <= 0) {
            clearInterval(timer);
            overlay.remove();
            resolve();
            return;
          }
          num.textContent = String(remaining);
          num.style.animation = 'none';
          void num.offsetWidth;
          num.style.animation = '';
        }, 1000);
      });
    }

    function startTicking() {
      clearInterval(tickTimer);
      tickTimer = setInterval(function () {
        if (options.onTick) { options.onTick(self.elapsed()); }
        if (options.maxSeconds && self.elapsed() >= options.maxSeconds) {
          ML.toast('Reached the maximum recording length.', 'error');
          self.stop();
        }
      }, 250);
    }

    self.elapsed = function () {
      if (!startedAt) { return 0; }
      var now = self.state === 'paused' ? pausedAt : performance.now();
      return Math.max(0, (now - startedAt - pausedTotal) / 1000);
    };

    self.pause = function () {
      if (!recorder || recorder.state !== 'recording') { return; }
      recorder.pause();
      pausedAt = performance.now();
      stopRecognition();
      setState('paused');
    };

    self.resume = function () {
      if (!recorder || recorder.state !== 'paused') { return; }
      pausedTotal += performance.now() - pausedAt;
      recorder.resume();
      if (self.captureTranscript) { startRecognition(); }
      setState('recording');
    };

    self.togglePause = function () {
      if (self.state === 'recording') { self.pause(); } else if (self.state === 'paused') { self.resume(); }
    };

    /** Stop, flush the upload queue and finalise the video record. */
    self.stop = function () {
      if (!recorder || upload.done) { return Promise.resolve(null); }
      setState('finishing');
      clearInterval(tickTimer);
      stopRecognition();

      var seconds = self.elapsed();
      var thumbnail = captureThumbnail();

      return new Promise(function (resolve, reject) {
        recorder.onstop = function () {
          drainQueue()
            .then(function () {
              return ML.post('upload/finish', {
                key: upload.key,
                duration: Number(seconds.toFixed(2)),
                width: canvas.width,
                height: canvas.height,
                thumbnail_data: thumbnail
              });
            })
            .then(function (response) {
              upload.done = true;
              if (segments.length) {
                return ML.post('transcript/save', { uid: upload.uid, segments: segments, source: 'browser' })
                  .catch(function () { /* transcripts are best-effort */ })
                  .then(function () { return response; });
              }
              return response;
            })
            .then(function (response) {
              stopSources();
              setState('done');
              resolve({ uid: upload.uid, shareUrl: response.share_url, duration: seconds });
            })
            .catch(function (error) {
              setState('preview');
              reject(error);
            });
        };
        try { recorder.stop(); } catch (e) { reject(e); }
      });
    };

    /** Abandon the recording and delete the partial file. */
    self.cancel = function () {
      clearInterval(tickTimer);
      stopRecognition();
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch (e) { /* ignore */ }
      }
      var key = upload.key;
      upload.queue = [];
      upload.done = true;
      stopSources();
      setState('idle');
      if (key) {
        return ML.post('upload/abort', { key: key }).catch(function () {});
      }
      return Promise.resolve();
    };

    function captureThumbnail() {
      try {
        var thumb = document.createElement('canvas');
        var scale = Math.min(1, 640 / canvas.width);
        thumb.width = Math.round(canvas.width * scale);
        thumb.height = Math.round(canvas.height * scale);
        thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
        return thumb.toDataURL('image/jpeg', 0.72);
      } catch (e) {
        return '';
      }
    }

    /* --- Chunk upload pipeline --------------------------------------------- */

    function pumpQueue() {
      if (upload.busy || !upload.queue.length || !upload.key) { return Promise.resolve(); }
      upload.busy = true;
      var blob = upload.queue[0];
      var index = upload.index;

      return ML.postRaw('upload/chunk', { key: upload.key, index: index }, blob)
        .then(function (response) {
          upload.queue.shift();
          upload.index++;
          upload.sent = response.received || (upload.sent + blob.size);
          upload.failed = 0;
          upload.busy = false;
          if (options.onUpload) { options.onUpload(upload.sent, upload.queue.length); }
          return pumpQueue();
        })
        .catch(function (error) {
          upload.busy = false;
          upload.failed++;
          if (upload.failed >= 5) {
            fail(new Error('Upload failed after several retries: ' + error.message));
            return null;
          }
          // Back off, then retry the same chunk.
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(pumpQueue()); }, Math.min(8000, 600 * Math.pow(2, upload.failed)));
          });
        });
    }

    /** Wait until every queued chunk has been accepted. */
    function drainQueue() {
      return pumpQueue().then(function () {
        if (!upload.queue.length && !upload.busy) { return true; }
        return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(drainQueue);
      });
    }

    function fail(error) {
      if (options.onError) { options.onError(error); }
      else { ML.toastError(error); }
    }

    /* --- Live transcript --------------------------------------------------- */

    function startRecognition() {
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition || recognition) { return; }
      try {
        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = options.lang || (navigator.language || 'en-US');
        recognition.onresult = function (event) {
          for (var i = event.resultIndex; i < event.results.length; i++) {
            if (!event.results[i].isFinal) { continue; }
            var text = String(event.results[i][0].transcript || '').trim();
            if (!text) { continue; }
            var end = self.elapsed();
            // The API gives no timings, so estimate from speaking rate (~2.6 words/s).
            var estimated = Math.min(end, Math.max(1.2, text.split(/\s+/).length / 2.6));
            segments.push({ start: Math.max(0, end - estimated), end: end, text: text });
          }
        };
        recognition.onerror = function () { /* transcripts are best-effort */ };
        recognition.onend = function () {
          // Chrome ends the session periodically; restart while still recording.
          if (self.state === 'recording' && recognition) {
            try { recognition.start(); } catch (e) { /* already starting */ }
          }
        };
        recognition.start();
      } catch (e) {
        recognition = null;
      }
    }

    function stopRecognition() {
      if (!recognition) { return; }
      var current = recognition;
      recognition = null;
      try { current.onend = null; current.stop(); } catch (e) { /* ignore */ }
    }

    self.getSegments = function () { return segments; };

    /* --- Teardown ---------------------------------------------------------- */

    function stopSources() {
      stopRenderLoop();
      [screenStream, camStream, micStream].forEach(function (stream) {
        if (stream) { stream.getTracks().forEach(function (track) { track.stop(); }); }
      });
      screenStream = camStream = micStream = null;
      if (audioContext) {
        try { audioContext.close(); } catch (e) { /* ignore */ }
        audioContext = null;
      }
      screenVideo.srcObject = null;
      camVideo.srcObject = null;
      return Promise.resolve();
    }

    self.destroy = function () {
      clearInterval(tickTimer);
      stopRecognition();
      stopSources();
    };

    self.setMode = function (mode) { self.mode = mode; };
    self.isRecording = function () { return self.state === 'recording' || self.state === 'paused'; };
    self.uploadStats = function () { return { sent: upload.sent, pending: upload.queue.length }; };

    return self;
  }

  Recorder.PEN_COLORS = PEN_COLORS;
  Recorder.pickMimeType = pickMimeType;
  Recorder.MP4_TYPES = MP4_TYPES;
  ML.Recorder = Recorder;
})(window, document);
