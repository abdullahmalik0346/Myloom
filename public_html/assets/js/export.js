/* ==========================================================================
   MyLoom export — download a video as WebM or MP4, optionally with the trim
   and overlays baked in.

   Shared cPanel hosting has no ffmpeg, so conversion happens in the browser:
   the source plays into a canvas, annotations are drawn on each frame, and
   MediaRecorder re-encodes the result. That runs in real time, so a 5-minute
   video takes about 5 minutes — the dialog says so up front.

   When the requested format already matches the stored file and nothing needs
   baking in, we skip all of that and download the original bytes untouched.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el;

  var MP4_TYPES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
    'video/mp4;codecs=h264,aac'
  ];
  var WEBM_TYPES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  function firstSupported(list) {
    if (!window.MediaRecorder) { return ''; }
    for (var i = 0; i < list.length; i++) {
      if (MediaRecorder.isTypeSupported(list[i])) { return list[i]; }
    }
    return '';
  }

  function canRecord(format) {
    return !!firstSupported(format === 'mp4' ? MP4_TYPES : WEBM_TYPES);
  }

  /** Format of the stored file, from its MIME type. */
  function sourceFormat(video) {
    return String(video.mime || '').indexOf('mp4') !== -1 ? 'mp4' : 'webm';
  }

  /* --- Dialog ------------------------------------------------------------- */

  /** open({ video, annotations }) */
  function open(options) {
    var video = options.video;
    var annotations = options.annotations || video.annotations || [];
    var native = sourceFormat(video);
    var hasTrim = Number(video.trim_start) > 0 ||
      (video.trim_end && Number(video.trim_end) > 0 && Number(video.trim_end) < Number(video.duration));
    var hasOverlays = annotations.length > 0;

    var format = native;
    var burn = false;
    var quality = 'source';

    var formatRow = el('div.btn-group');
    var note = el('p.hint');
    var progressWrap = el('div', { style: { display: 'none' } });
    var progressBar = el('div.upload-progress', {}, el('i', { style: { width: '0%' } }));
    var progressText = el('p.hint');
    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressText);

    var burnToggle = el('input', {
      type: 'checkbox', checked: false,
      onchange: function (e) { burn = e.target.checked; refresh(); }
    });
    var qualitySelect = el('select', {
      onchange: function (e) { quality = e.target.value; refresh(); }
    }, [
      el('option', { value: 'source' }, 'Original resolution'),
      el('option', { value: '1080' }, 'Up to 1080p'),
      el('option', { value: '720' }, 'Up to 720p (smaller file)')
    ]);

    ['webm', 'mp4'].forEach(function (candidate) {
      var supported = candidate === native || canRecord(candidate);
      formatRow.appendChild(el('button.btn' + (format === candidate ? '.active' : ''), {
        type: 'button',
        disabled: !supported,
        title: supported
          ? candidate.toUpperCase()
          : 'This browser cannot encode ' + candidate.toUpperCase() + '. Try Chrome, Edge or Safari.',
        onclick: function () {
          format = candidate;
          ML.$$('.btn', formatRow).forEach(function (b) { b.classList.remove('active'); });
          this.classList.add('active');
          refresh();
        }
      }, candidate === 'mp4' ? 'MP4 (H.264)' : 'WebM (VP8/VP9)'));
    });

    var startButton = el('button.btn.primary', { type: 'button', onclick: run }, 'Download');

    function needsReencode() {
      return burn || format !== native || quality !== 'source' || hasTrim;
    }

    function refresh() {
      var lines = [];
      if (!needsReencode()) {
        lines.push('Downloads the original file instantly, with no quality loss.');
      } else {
        var reasons = [];
        if (format !== native) { reasons.push('converting ' + native.toUpperCase() + ' → ' + format.toUpperCase()); }
        if (burn) { reasons.push('baking in overlays'); }
        if (hasTrim) { reasons.push('applying the trim'); }
        if (quality !== 'source') { reasons.push('resizing to ' + quality + 'p'); }
        lines.push('Re-encodes in your browser (' + reasons.join(', ') + ').');
        lines.push('This runs in real time — roughly ' + ML.duration(effectiveDuration()) +
          '. Keep this tab open and in the foreground.');
      }
      if (format === 'mp4' && native === 'webm' && !canRecord('mp4')) {
        lines.push('This browser cannot encode MP4.');
      }
      note.innerHTML = lines.map(function (l) { return ML.escapeHtml(l); }).join('<br>');
      startButton.textContent = needsReencode() ? 'Convert & download' : 'Download original';
    }

    function effectiveDuration() {
      var start = Number(video.trim_start) || 0;
      var end = video.trim_end && Number(video.trim_end) > 0 ? Number(video.trim_end) : Number(video.duration) || 0;
      return Math.max(0, end - start);
    }

    var dialog = ML.modal({
      title: 'Download video',
      body: [
        el('label.field', {}, [el('span', {}, 'Format'), formatRow]),
        el('label.field', {}, [el('span', {}, 'Resolution'), qualitySelect]),
        hasOverlays
          ? el('label.check', {}, [burnToggle, el('span', {}, ['Burn overlays into the video',
              el('span.check-sub', {}, annotations.length + ' overlay(s) — otherwise they only show on the share page')])])
          : el('p.hint', {}, 'This video has no overlays to bake in.'),
        note,
        progressWrap
      ],
      footer: function (api) {
        return [
          el('button.btn', { type: 'button', onclick: function () { cancelled = true; api.close(); } }, 'Cancel'),
          startButton
        ];
      }
    });

    var cancelled = false;
    refresh();

    function run() {
      if (!needsReencode()) {
        // Straight through to the server's own download endpoint.
        window.location.href = video.download_url ||
          (video.media_url + (video.media_url.indexOf('?') === -1 ? '?' : '&') + 'dl=1');
        dialog.close();
        return;
      }

      startButton.disabled = true;
      qualitySelect.disabled = true;
      burnToggle.disabled = true;
      progressWrap.style.display = '';

      transcode({
        src: video.media_url,
        title: video.title,
        format: format,
        quality: quality,
        annotations: burn ? annotations : [],
        trimStart: Number(video.trim_start) || 0,
        trimEnd: video.trim_end && Number(video.trim_end) > 0 ? Number(video.trim_end) : null,
        isCancelled: function () { return cancelled; },
        onProgress: function (done, total) {
          var pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
          progressBar.firstChild.style.width = pct.toFixed(1) + '%';
          progressText.textContent = 'Encoding ' + ML.duration(done) + ' / ' + ML.duration(total) +
            ' (' + Math.round(pct) + '%)';
        }
      }).then(function (result) {
        progressText.textContent = 'Done — ' + ML.bytes(result.blob.size) + '. Saving…';
        saveBlob(result.blob, filenameFor(video.title, result.extension));
        ML.toast('Download ready', 'success');
        setTimeout(function () { dialog.close(); }, 900);
      }).catch(function (error) {
        startButton.disabled = false;
        qualitySelect.disabled = false;
        burnToggle.disabled = false;
        progressText.textContent = error.message;
        progressText.style.color = 'var(--danger)';
      });
    }

    return dialog;
  }

  function filenameFor(title, extension) {
    var base = String(title || 'video').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 80).trim() || 'video';
    return base + '.' + extension;
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = el('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      link.remove();
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /* --- Transcoder --------------------------------------------------------- */

  /**
   * Play the source into a canvas, draw annotations per frame, and record.
   * Resolves with { blob, extension }.
   */
  function transcode(options) {
    return new Promise(function (resolve, reject) {
      var source = document.createElement('video');
      source.src = options.src;
      source.crossOrigin = 'anonymous';
      source.preload = 'auto';
      source.playsInline = true;
      source.muted = false;
      source.volume = 1;

      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var recorder = null;
      var chunks = [];
      var audioContext = null;
      var rafId = null;
      var finished = false;
      var trimStart = options.trimStart || 0;
      var trimEnd = null;
      var total = 0;

      var fail = function (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      function cleanup() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        try { source.pause(); } catch (e) { /* ignore */ }
        source.removeAttribute('src');
        try { source.load(); } catch (e) { /* ignore */ }
        if (audioContext) {
          try { audioContext.close(); } catch (e) { /* ignore */ }
          audioContext = null;
        }
      }

      source.onerror = function () {
        fail(new Error('The source video could not be loaded for conversion.'));
      };

      source.onloadedmetadata = function () {
        var vw = source.videoWidth || 1280;
        var vh = source.videoHeight || 720;
        var cap = options.quality === '1080' ? 1080 : (options.quality === '720' ? 720 : 0);
        var scale = cap ? Math.min(1, cap / vh) : 1;
        // Even dimensions keep H.264 encoders happy.
        canvas.width = Math.max(2, Math.round((vw * scale) / 2) * 2);
        canvas.height = Math.max(2, Math.round((vh * scale) / 2) * 2);

        var duration = isFinite(source.duration) && source.duration > 0 ? source.duration : 0;
        trimEnd = options.trimEnd || duration || 0;
        total = Math.max(0.1, (trimEnd || duration) - trimStart);

        var mimeType = firstSupported(options.format === 'mp4' ? MP4_TYPES : WEBM_TYPES);
        if (!mimeType) {
          fail(new Error('This browser cannot encode ' + options.format.toUpperCase() + '.'));
          return;
        }

        var stream = canvas.captureStream(30);

        // Route the source's audio into the recording without playing it aloud.
        try {
          var AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) {
            audioContext = new AudioCtx();
            var node = audioContext.createMediaElementSource(source);
            var destination = audioContext.createMediaStreamDestination();
            node.connect(destination);
            destination.stream.getAudioTracks().forEach(function (track) {
              stream.addTrack(track);
            });
          }
        } catch (e) {
          // No audio graph available: export video only rather than failing.
        }

        try {
          recorder = new MediaRecorder(stream, {
            mimeType: mimeType,
            videoBitsPerSecond: Math.round(canvas.width * canvas.height * 0.12) + 600000,
            audioBitsPerSecond: 128000
          });
        } catch (e) {
          fail(new Error('Could not start the encoder: ' + e.message));
          return;
        }

        recorder.ondataavailable = function (event) {
          if (event.data && event.data.size) { chunks.push(event.data); }
        };
        recorder.onerror = function () { fail(new Error('The encoder failed part-way through.')); };
        recorder.onstop = function () {
          cleanup();
          var blob = new Blob(chunks, { type: options.format === 'mp4' ? 'video/mp4' : 'video/webm' });
          if (!blob.size) {
            reject(new Error('Conversion produced an empty file.'));
            return;
          }
          resolve({ blob: blob, extension: options.format });
        };

        var begin = function () {
          recorder.start(2000);
          source.play().then(loop).catch(function (error) {
            fail(new Error('Playback for conversion was blocked: ' + error.message));
          });
        };

        // Seek to the trim point before recording anything.
        if (trimStart > 0.05) {
          source.onseeked = function () { source.onseeked = null; begin(); };
          source.currentTime = trimStart;
        } else {
          begin();
        }
      };

      function loop() {
        if (finished) { return; }
        if (options.isCancelled && options.isCancelled()) {
          finished = true;
          try { recorder.stop(); } catch (e) { /* ignore */ }
          return;
        }
        rafId = requestAnimationFrame(loop);

        var t = source.currentTime;
        drawFrame(ctx, canvas, source, options.annotations, t);
        if (options.onProgress) {
          options.onProgress(Math.max(0, Math.min(total, t - trimStart)), total);
        }

        var atEnd = (trimEnd && t >= trimEnd - 0.03) || source.ended;
        if (atEnd) {
          finished = true;
          cancelAnimationFrame(rafId);
          rafId = null;
          // Let the last frames flush before closing the file.
          setTimeout(function () {
            try { recorder.stop(); } catch (e) { fail(e); }
          }, 260);
        }
      }
    });
  }

  /* --- Canvas rendering of annotations ------------------------------------ */

  function drawFrame(ctx, canvas, source, annotations, t) {
    var w = canvas.width, h = canvas.height;
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.drawImage(source, 0, 0, w, h);

    if (!annotations || !annotations.length) { return; }
    annotations
      .filter(function (a) { return ML.Overlays.isActive(a, t); })
      .sort(function (a, b) { return (a.z_index || 0) - (b.z_index || 0); })
      .forEach(function (a) { drawAnnotation(ctx, canvas, source, a); });
  }

  function drawAnnotation(ctx, canvas, source, a) {
    var w = canvas.width, h = canvas.height;
    var x = a.x * w, y = a.y * h, bw = Math.max(2, a.w * w), bh = Math.max(2, a.h * h);

    ctx.save();
    switch (a.type) {
      case 'blur':
        drawBlur(ctx, canvas, source, x, y, bw, bh, a.intensity);
        break;

      case 'rect':
      case 'ellipse':
        ctx.lineWidth = Math.max(1, a.stroke_width * h);
        ctx.strokeStyle = a.color;
        if (a.background) {
          ctx.fillStyle = ML.Overlays.hexToRgba(a.background, 0.28);
        }
        if (a.type === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(x + bw / 2, y + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
          if (a.background) { ctx.fill(); }
          ctx.stroke();
        } else {
          if (a.background) { ctx.fillRect(x, y, bw, bh); }
          ctx.strokeRect(x, y, bw, bh);
        }
        break;

      case 'arrow':
        drawArrow(ctx, x, y, bw, bh, a.color, Math.max(2, a.stroke_width * h));
        break;

      case 'text':
      case 'link':
      default:
        drawText(ctx, a, x, y, bw, bh, h);
    }
    ctx.restore();
  }

  /**
   * Blur a region. ctx.filter is used where available; otherwise the region is
   * downscaled and drawn back magnified, which pixelates it. Either way the
   * covered content is unreadable, which is the point of the tool.
   */
  function drawBlur(ctx, canvas, source, x, y, bw, bh, intensity) {
    var sx = canvas.width / (source.videoWidth || canvas.width);
    var sy = canvas.height / (source.videoHeight || canvas.height);

    var scratch = drawBlur.scratch || (drawBlur.scratch = document.createElement('canvas'));
    var sctx = scratch.getContext('2d');
    // Downscale hard: the region is rebuilt from this many samples across, so a
    // higher intensity means fewer samples and genuinely destroyed detail.
    var small = Math.max(2, Math.round(Math.max(bw, bh) / Math.max(3, intensity)));
    var ratio = bh / bw;
    scratch.width = small;
    scratch.height = Math.max(2, Math.round(small * ratio));

    // Pull the region straight from the source frame at native resolution.
    sctx.filter = 'none';
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    sctx.drawImage(
      source,
      x / sx, y / sy, bw / sx, bh / sy,
      0, 0, scratch.width, scratch.height
    );

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, x, y, bw, bh, Math.min(8, bw / 8));
    ctx.clip();
    if (typeof ctx.filter === 'string') {
      ctx.filter = 'blur(' + Math.max(3, intensity / 1.6) + 'px)';
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, x, y, bw, bh);
    ctx.filter = 'none';
    ctx.restore();
  }

  function drawArrow(ctx, x, y, bw, bh, color, stroke) {
    var x1 = x + stroke, y1 = y + stroke;
    var x2 = x + bw - stroke, y2 = y + bh - stroke;
    var head = Math.max(6, stroke * 3.2);
    var angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = stroke;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 - Math.cos(angle) * head * 0.8, y2 - Math.sin(angle) * head * 0.8);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(angle - 0.42) * head, y2 - Math.sin(angle - 0.42) * head);
    ctx.lineTo(x2 - Math.cos(angle + 0.42) * head, y2 - Math.sin(angle + 0.42) * head);
    ctx.closePath();
    ctx.fill();
  }

  function drawText(ctx, a, x, y, bw, bh, frameHeight) {
    var fontPx = Math.max(8, a.font_size * frameHeight);
    var pad = fontPx * 0.4;
    ctx.font = '600 ' + Math.round(fontPx) + 'px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
    ctx.textBaseline = 'top';

    var lines = wrapText(ctx, a.body || '', bw - pad * 2);
    var lineHeight = fontPx * 1.26;
    var textHeight = lines.length * lineHeight;
    var boxHeight = Math.max(bh, textHeight + pad * 2);

    if (a.background) {
      ctx.fillStyle = ML.Overlays.hexToRgba(a.background, 0.82);
      ctx.beginPath();
      roundRect(ctx, x, y, bw, boxHeight, Math.min(fontPx * 0.3, 14));
      ctx.fill();
    } else {
      ctx.shadowColor = 'rgba(0,0,0,.7)';
      ctx.shadowBlur = Math.max(2, fontPx * 0.18);
      ctx.shadowOffsetY = 1;
    }

    ctx.fillStyle = a.color || '#ffffff';
    var centred = a.type === 'link';
    ctx.textAlign = centred ? 'center' : 'left';
    var textX = centred ? x + bw / 2 : x + pad;
    var textY = y + (boxHeight - textHeight) / 2;
    lines.forEach(function (line, i) {
      ctx.fillText(line, textX, textY + i * lineHeight);
    });
  }

  function wrapText(ctx, text, maxWidth) {
    var words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) { return []; }
    var lines = [];
    var line = words[0];
    for (var i = 1; i < words.length; i++) {
      var candidate = line + ' ' + words[i];
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = candidate;
      }
    }
    lines.push(line);
    return lines.slice(0, 8);
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* --- Apply permanently -------------------------------------------------- */

  /**
   * Re-encode with overlays and trim baked in, then replace the stored file.
   * This is the only way to truly redact something: a blur drawn by the player
   * is cosmetic, and the original pixels stay in the file until they are
   * re-encoded away.
   */
  function applyPermanently(options) {
    var video = options.video;
    var annotations = options.annotations || video.annotations || [];

    var progressBar = el('div.upload-progress', {}, el('i', { style: { width: '0%' } }));
    var status = el('p.hint', { text: 'This rewrites the stored video. The original cannot be recovered.' });
    var formatRow = el('div.btn-group');
    var format = sourceFormat(video);

    ['webm', 'mp4'].forEach(function (candidate) {
      var supported = canRecord(candidate);
      formatRow.appendChild(el('button.btn' + (format === candidate ? '.active' : ''), {
        type: 'button', disabled: !supported,
        title: supported ? '' : 'This browser cannot encode ' + candidate.toUpperCase(),
        onclick: function () {
          format = candidate;
          ML.$$('.btn', formatRow).forEach(function (b) { b.classList.remove('active'); });
          this.classList.add('active');
        }
      }, candidate === 'mp4' ? 'MP4 (H.264)' : 'WebM'));
    });

    var goButton = el('button.btn.danger', { type: 'button', onclick: start }, 'Re-encode & replace');
    var cancelled = false;

    var dialog = ML.modal({
      title: 'Apply overlays permanently',
      body: [
        el('p.small', {}, 'Bakes the ' + annotations.length + ' overlay(s) and the trim into the video ' +
          'itself, then replaces the stored file.'),
        el('div.card.pad', { style: { borderColor: 'var(--warn)', marginBottom: '14px' } }, [
          el('p.small', {}, [
            el('strong', {}, 'Use this for blurring anything sensitive. '),
            'Until you do, a blur only hides content in the player — the original pixels are ' +
            'still in the file, and a determined viewer could recover them.'
          ])
        ]),
        el('label.field', {}, [el('span', {}, 'Output format'), formatRow]),
        el('p.hint', {}, 'Re-encodes in your browser in real time — about ' +
          ML.duration(video.duration || 0) + '. Keep this tab in the foreground.'),
        progressBar,
        status
      ],
      footer: function (api) {
        return [
          el('button.btn', { type: 'button', onclick: function () { cancelled = true; api.close(); } }, 'Cancel'),
          goButton
        ];
      }
    });

    function start() {
      goButton.disabled = true;
      ML.$$('.btn', formatRow).forEach(function (b) { b.disabled = true; });
      status.textContent = 'Re-encoding…';
      var uploadKey = null;

      transcode({
        src: video.media_url,
        format: format,
        quality: 'source',
        annotations: annotations,
        trimStart: Number(video.trim_start) || 0,
        trimEnd: video.trim_end && Number(video.trim_end) > 0 ? Number(video.trim_end) : null,
        isCancelled: function () { return cancelled; },
        onProgress: function (done, total) {
          var pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
          progressBar.firstChild.style.width = (pct * 0.7).toFixed(1) + '%';
          status.textContent = 'Re-encoding ' + ML.duration(done) + ' / ' + ML.duration(total);
        }
      }).then(function (result) {
        status.textContent = 'Uploading ' + ML.bytes(result.blob.size) + '…';
        return ML.post('upload/replace-start', {
          uid: video.uid,
          mime: format === 'mp4' ? 'video/mp4' : 'video/webm'
        }).then(function (response) {
          uploadKey = response.upload_key;
          return uploadBlob(result.blob, uploadKey, function (sent, total) {
            var pct = 70 + (total > 0 ? (sent / total) * 28 : 0);
            progressBar.firstChild.style.width = pct.toFixed(1) + '%';
            status.textContent = 'Uploading ' + ML.bytes(sent) + ' / ' + ML.bytes(total);
          });
        }).then(function () {
          return ML.post('upload/replace-finish', {
            key: uploadKey,
            mime: format === 'mp4' ? 'video/mp4' : 'video/webm',
            duration: video.trim_end && Number(video.trim_end) > 0
              ? Number(video.trim_end) - (Number(video.trim_start) || 0)
              : Number(video.duration) || 0,
            clear_annotations: true
          });
        });
      }).then(function () {
        progressBar.firstChild.style.width = '100%';
        status.textContent = 'Done.';
        ML.toast('Overlays baked into the video', 'success');
        setTimeout(function () {
          dialog.close();
          if (options.onDone) { options.onDone(); }
        }, 800);
      }).catch(function (error) {
        goButton.disabled = false;
        ML.$$('.btn', formatRow).forEach(function (b) { b.disabled = false; });
        status.textContent = error.message;
        status.style.color = 'var(--danger)';
        if (uploadKey) { ML.post('upload/replace-abort', { key: uploadKey }).catch(function () {}); }
      });
    }

    return dialog;
  }

  /** Send a Blob through the chunked upload endpoints. */
  function uploadBlob(blob, uploadKey, onProgress) {
    var CHUNK = 2 * 1024 * 1024;
    var offset = 0;
    var index = 0;

    function next() {
      if (offset >= blob.size) { return Promise.resolve(); }
      var slice = blob.slice(offset, Math.min(blob.size, offset + CHUNK));
      var attempt = 0;

      var send = function () {
        return ML.postRaw('upload/chunk', { key: uploadKey, index: index }, slice)
          .catch(function (error) {
            attempt++;
            if (attempt >= 4) { throw error; }
            return new Promise(function (resolve) {
              setTimeout(resolve, 500 * Math.pow(2, attempt));
            }).then(send);
          });
      };

      return send().then(function () {
        offset += slice.size;
        index++;
        if (onProgress) { onProgress(offset, blob.size); }
        return next();
      });
    }
    return next();
  }

  ML.Export = {
    open: open,
    applyPermanently: applyPermanently,
    canRecord: canRecord,
    sourceFormat: sourceFormat,
    transcode: transcode,
    uploadBlob: uploadBlob
  };
})(window, document);
