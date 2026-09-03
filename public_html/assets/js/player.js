/* ==========================================================================
   MyLoom player — custom video controls with chapters, captions, trim
   boundaries, comment markers, speed, PiP and keyboard shortcuts.
   Usage: var p = ML.Player(container, { src, poster, ... })
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  function Player(container, options) {
    options = options || {};

    // Playback is defined by an ordered list of source ranges ("segments").
    // One segment is the old trim; several let the middle be cut out or pieces
    // reordered. Everything the controls show is in *virtual* time — the
    // timeline the viewer sees — which maps onto source time through the list.
    var segments = normaliseSegments(options.segments);
    var trimStart = Number(options.trimStart) || 0;
    var trimEnd = options.trimEnd ? Number(options.trimEnd) : null;
    var activeIndex = 0;

    function normaliseSegments(list) {
      if (!Array.isArray(list) || !list.length) { return null; }
      var out = [];
      list.forEach(function (item) {
        var start = Math.max(0, Number(item.start) || 0);
        var end = Number(item.end) || 0;
        if (end - start > 0.05) { out.push({ start: start, end: end }); }
      });
      return out.length ? out : null;
    }

    /** The effective list, falling back to the trim range or the whole file. */
    function segmentList() {
      if (segments) { return segments; }
      var natural = naturalDuration();
      var end = trimEnd && trimEnd > trimStart ? Math.min(trimEnd, natural || trimEnd) : natural;
      if (!(end > trimStart)) { return [{ start: 0, end: natural || 0 }]; }
      return [{ start: trimStart, end: end }];
    }

    /** Virtual position (what the scrub bar shows) for a source time. */
    function toVirtual(sourceTime) {
      var list = segmentList();
      var acc = 0;
      for (var i = 0; i < list.length; i++) {
        var seg = list[i];
        if (sourceTime < seg.start) { return acc; }
        if (sourceTime <= seg.end) { return acc + (sourceTime - seg.start); }
        acc += seg.end - seg.start;
      }
      return acc;
    }

    /** Source time for a virtual position, plus which segment it lands in. */
    function toSource(virtualTime) {
      var list = segmentList();
      var remaining = Math.max(0, virtualTime);
      for (var i = 0; i < list.length; i++) {
        var span = list[i].end - list[i].start;
        if (remaining <= span || i === list.length - 1) {
          return { time: list[i].start + Math.min(remaining, span), index: i };
        }
        remaining -= span;
      }
      return { time: list[0].start, index: 0 };
    }

    function segmentIndexAt(sourceTime) {
      var list = segmentList();
      for (var i = 0; i < list.length; i++) {
        if (sourceTime >= list[i].start - 0.05 && sourceTime <= list[i].end + 0.05) { return i; }
      }
      return -1;
    }
    var captions = [];      // [{start, end, text}]
    var chapters = options.chapters || [];
    var markers = [];       // [{time, emoji|label}]
    var captionsOn = ML.storage('captionsOn') === true;
    var speedMenu = null;
    var hideTimer = null;

    /* --- DOM ------------------------------------------------------------- */
    var video = el('video', {
      playsinline: true,
      preload: options.preload || 'metadata',
      poster: options.poster || null,
      crossOrigin: null
    });
    video.setAttribute('playsinline', '');
    if (options.src) { video.src = options.src; }

    var bigPlay = el('div.big-play');
    var centerLayer = el('div.player-center', { onclick: togglePlay }, bigPlay);

    var buffer = el('div.scrub-buffer');
    var fill = el('div.scrub-fill');
    var knob = el('div.scrub-knob');
    var markerLayer = el('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
    var track = el('div.scrub-track', {}, [buffer, fill, markerLayer, knob]);
    var tooltip = el('div.scrub-tooltip', { style: { display: 'none' } });
    var scrub = el('div.scrub', { role: 'slider', tabindex: '0', 'aria-label': 'Seek' }, [track, tooltip]);

    var playBtn = el('button.pbtn', { type: 'button', title: 'Play (k)', 'aria-label': 'Play' }, '▶');
    var backBtn = el('button.pbtn', { type: 'button', title: 'Back 10s (j)' }, '⟲');
    var fwdBtn = el('button.pbtn', { type: 'button', title: 'Forward 10s (l)' }, '⟳');
    var muteBtn = el('button.pbtn', { type: 'button', title: 'Mute (m)' }, '🔊');
    var volume = el('input', { type: 'range', min: '0', max: '1', step: '.05', value: '1', 'aria-label': 'Volume' });
    var timeLabel = el('span.time-label', { text: '0:00 / 0:00' });
    var ccBtn = el('button.pbtn', { type: 'button', title: 'Captions (c)' }, 'CC');
    var speedBtn = el('button.pbtn', { type: 'button', title: 'Playback speed' }, '1×');
    var pipBtn = el('button.pbtn', { type: 'button', title: 'Picture in picture' }, '⧉');
    var fsBtn = el('button.pbtn', { type: 'button', title: 'Fullscreen (f)' }, '⛶');

    var buttons = el('div.player-buttons', {}, [
      playBtn, backBtn, fwdBtn,
      el('div.volume-wrap', {}, [muteBtn, volume]),
      timeLabel,
      el('span.grow'),
      options.showCaptions === false ? null : ccBtn,
      speedBtn,
      ML.capabilities().pip ? pipBtn : null,
      fsBtn
    ]);

    var controls = el('div.player-controls', {}, [scrub, buttons]);
    var captionBox = el('div.cc-box', { style: { display: 'none' } });
    var chapterFlag = el('div.chapter-flag', { style: { display: 'none' } });

    var root = el('div.player.paused', { tabindex: '0' }, [
      video, centerLayer, captionBox, chapterFlag, controls
    ]);
    clear(container).appendChild(root);

    /* --- Playback -------------------------------------------------------- */

    /**
     * WebM files produced by MediaRecorder carry no duration header, so
     * video.duration reports Infinity until the browser has scanned the file.
     * We fall back to the duration the recorder measured and stored server-side.
     */
    function naturalDuration() {
      var natural = video.duration;
      if (!isFinite(natural) || natural <= 0) { natural = Number(options.fallbackDuration) || 0; }
      return natural;
    }

    function firstStart() { return segmentList()[0].start; }

    function effectiveDuration() {
      var list = segmentList();
      var total = 0;
      for (var i = 0; i < list.length; i++) { total += Math.max(0, list[i].end - list[i].start); }
      return total;
    }

    function relTime() {
      return Math.max(0, Math.min(effectiveDuration(), toVirtual(video.currentTime)));
    }

    function togglePlay() { video.paused ? play() : video.pause(); }

    function play() {
      // Restart from the top when parked outside every kept segment, or at the end.
      if (segmentIndexAt(video.currentTime) === -1 || relTime() >= effectiveDuration() - 0.05) {
        video.currentTime = firstStart();
        activeIndex = 0;
      }
      var promise = video.play();
      if (promise && promise.catch) {
        promise.catch(function (error) {
          if (error && error.name === 'NotAllowedError') {
            ML.toast('Your browser blocked autoplay — press play to start.');
          }
        });
      }
    }

    function seek(relSeconds) {
      var mapped = toSource(Math.max(0, Math.min(effectiveDuration(), relSeconds)));
      activeIndex = mapped.index;
      video.currentTime = mapped.time;
      render();
    }

    function skip(delta) { seek(relTime() + delta); }

    /* --- Rendering ------------------------------------------------------- */

    function render() {
      var total = effectiveDuration();
      var current = relTime();
      var percent = total > 0 ? (current / total) * 100 : 0;
      fill.style.width = percent + '%';
      knob.style.left = percent + '%';
      scrub.setAttribute('aria-valuenow', Math.round(current));
      scrub.setAttribute('aria-valuetext', ML.duration(current) + ' of ' + ML.duration(total));
      timeLabel.textContent = ML.duration(current) + ' / ' + ML.duration(total);

      if (video.buffered && video.buffered.length && total > 0) {
        var bufferedEnd = toVirtual(video.buffered.end(video.buffered.length - 1));
        buffer.style.width = Math.min(100, Math.max(0, (bufferedEnd / total) * 100)) + '%';
      }
      renderCaption(video.currentTime);
      renderChapter(video.currentTime);
    }

    function renderCaption(absolute) {
      if (!captionsOn || !captions.length) {
        captionBox.style.display = 'none';
        return;
      }
      var line = null;
      for (var i = 0; i < captions.length; i++) {
        if (absolute >= captions[i].start && absolute <= captions[i].end) { line = captions[i]; break; }
      }
      captionBox.textContent = line ? line.text : '';
      captionBox.style.display = line ? 'block' : 'none';
    }

    function renderChapter(absolute) {
      if (!chapters.length) { return; }
      var current = null;
      chapters.forEach(function (chapter) {
        if (absolute >= Number(chapter.start_time)) { current = chapter; }
      });
      if (current && root.classList.contains('paused')) {
        chapterFlag.textContent = current.title;
        chapterFlag.style.display = 'block';
      } else {
        chapterFlag.style.display = 'none';
      }
    }

    function renderMarkers() {
      clear(markerLayer);
      var total = effectiveDuration();
      if (total <= 0) { return; }
      chapters.forEach(function (chapter) {
        if (segmentIndexAt(Number(chapter.start_time)) === -1) { return; }
        var at = toVirtual(Number(chapter.start_time)) / total;
        if (at < 0 || at > 1) { return; }
        markerLayer.appendChild(el('i.scrub-marker.chapter', {
          style: { left: (at * 100) + '%' }, title: chapter.title
        }));
      });
      markers.forEach(function (marker) {
        if (segmentIndexAt(Number(marker.time)) === -1) { return; }
        var at = toVirtual(Number(marker.time)) / total;
        if (at < 0 || at > 1) { return; }
        markerLayer.appendChild(el('i.scrub-marker', {
          style: { left: (at * 100) + '%' }, title: marker.label || ''
        }));
      });
    }

    /* --- Scrubbing ------------------------------------------------------- */

    function positionFromEvent(event) {
      var rect = track.getBoundingClientRect();
      var clientX = event.touches && event.touches[0] ? event.touches[0].clientX : event.clientX;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    var scrubbing = false;
    scrub.addEventListener('pointerdown', function (event) {
      scrubbing = true;
      root.classList.add('controls-locked');
      scrub.setPointerCapture(event.pointerId);
      seek(positionFromEvent(event) * effectiveDuration());
    });
    scrub.addEventListener('pointermove', function (event) {
      var ratio = positionFromEvent(event);
      tooltip.style.display = 'block';
      tooltip.style.left = (ratio * 100) + '%';
      tooltip.textContent = ML.duration(ratio * effectiveDuration());
      if (scrubbing) { seek(ratio * effectiveDuration()); }
    });
    scrub.addEventListener('pointerleave', function () { tooltip.style.display = 'none'; });
    scrub.addEventListener('pointerup', function (event) {
      scrubbing = false;
      root.classList.remove('controls-locked');
      try { scrub.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    });
    scrub.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight') { skip(5); event.preventDefault(); }
      if (event.key === 'ArrowLeft') { skip(-5); event.preventDefault(); }
    });

    /* --- Control wiring -------------------------------------------------- */

    playBtn.onclick = togglePlay;
    backBtn.onclick = function () { skip(-10); };
    fwdBtn.onclick = function () { skip(10); };

    muteBtn.onclick = function () {
      video.muted = !video.muted;
      updateVolumeUi();
    };
    volume.oninput = function () {
      video.volume = Number(volume.value);
      video.muted = video.volume === 0;
      ML.storage('volume', video.volume);
      updateVolumeUi();
    };
    function updateVolumeUi() {
      muteBtn.textContent = video.muted || video.volume === 0 ? '🔇' : (video.volume < 0.5 ? '🔉' : '🔊');
      volume.value = video.muted ? 0 : video.volume;
    }

    ccBtn.onclick = function () {
      if (!captions.length) { ML.toast('No captions available for this video.'); return; }
      captionsOn = !captionsOn;
      ML.storage('captionsOn', captionsOn);
      ccBtn.classList.toggle('active', captionsOn);
      render();
    };

    speedBtn.onclick = function () {
      if (speedMenu) { speedMenu.remove(); speedMenu = null; return; }
      speedMenu = el('div.speed-menu', {}, SPEEDS.map(function (rate) {
        return el('button' + (video.playbackRate === rate ? '.active' : ''), {
          type: 'button',
          onclick: function () {
            video.playbackRate = rate;
            speedBtn.textContent = rate + '×';
            ML.storage('speed', rate);
            speedMenu.remove();
            speedMenu = null;
          }
        }, rate === 1 ? 'Normal' : rate + '×');
      }));
      root.appendChild(speedMenu);
    };

    pipBtn.onclick = function () {
      if (document.pictureInPictureElement) { document.exitPictureInPicture(); }
      else if (video.requestPictureInPicture) { video.requestPictureInPicture().catch(function () {
        ML.toast('Picture-in-picture is not available here.');
      }); }
    };

    fsBtn.onclick = function () {
      if (document.fullscreenElement) { document.exitFullscreen(); }
      else if (root.requestFullscreen) { root.requestFullscreen().catch(function () {}); }
      else if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); }
    };

    /* --- Video events ---------------------------------------------------- */

    // Coax Chrome into indexing a header-less WebM so seeking works.
    var durationFixed = false;
    function fixInfiniteDuration() {
      if (durationFixed || options.fixDuration === false) { return; }
      if (isFinite(video.duration) && video.duration > 0) { return; }
      durationFixed = true;
      var restore = function () {
        video.removeEventListener('timeupdate', restore);
        video.currentTime = firstStart();
        renderMarkers();
        render();
      };
      video.addEventListener('timeupdate', restore);
      try { video.currentTime = 1e101; } catch (e) { durationFixed = false; }
    }

    video.addEventListener('loadedmetadata', function () {
      fixInfiniteDuration();
      renderMarkers();
      render();
      if (options.onReady) { options.onReady(api); }
    });
    video.addEventListener('durationchange', function () { renderMarkers(); render(); });
    video.addEventListener('timeupdate', function () {
      advanceSegment();
      render();
      if (options.onProgress) { options.onProgress(relTime(), effectiveDuration()); }
    });

    /**
     * Jump across a cut. When playback runs past the end of the current
     * segment it continues at the start of the next one, so removed material
     * is never seen. After the last segment, playback stops.
     */
    function advanceSegment() {
      var list = segmentList();
      if (activeIndex >= list.length) { activeIndex = list.length - 1; }
      var current = list[activeIndex];
      if (!current) { return; }

      // A seek may have landed in a different segment; follow it.
      if (video.currentTime < current.start - 0.3 || video.currentTime > current.end + 0.3) {
        var found = segmentIndexAt(video.currentTime);
        if (found !== -1) { activeIndex = found; return; }
      }

      if (video.currentTime < current.end - 0.04) { return; }

      if (activeIndex < list.length - 1) {
        activeIndex++;
        video.currentTime = list[activeIndex].start;
      } else {
        video.pause();
        video.currentTime = current.end;
        if (options.onEnded) { options.onEnded(); }
      }
    }
    video.addEventListener('progress', render);
    video.addEventListener('play', function () {
      root.classList.add('playing');
      root.classList.remove('paused');
      playBtn.textContent = '⏸';
      playBtn.setAttribute('aria-label', 'Pause');
      if (options.onPlay) { options.onPlay(); }
    });
    video.addEventListener('pause', function () {
      root.classList.remove('playing');
      root.classList.add('paused');
      playBtn.textContent = '▶';
      playBtn.setAttribute('aria-label', 'Play');
      if (options.onPause) { options.onPause(relTime()); }
    });
    video.addEventListener('ended', function () {
      root.classList.add('paused');
      root.classList.remove('playing');
      playBtn.textContent = '↻';
      if (options.onEnded) { options.onEnded(); }
    });
    video.addEventListener('error', function () {
      if (options.onError) { options.onError(video.error); }
    });
    video.addEventListener('volumechange', updateVolumeUi);

    document.addEventListener('fullscreenchange', function () {
      root.classList.toggle('fullscreen', document.fullscreenElement === root);
    });

    // Auto-hide the cursor and controls while playing.
    root.addEventListener('pointermove', function () {
      root.classList.add('controls-locked');
      root.style.cursor = '';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        if (!video.paused) {
          root.classList.remove('controls-locked');
          root.style.cursor = 'none';
        }
      }, 2400);
    });
    root.addEventListener('pointerleave', function () {
      root.classList.remove('controls-locked');
      root.style.cursor = '';
    });

    /* --- Keyboard shortcuts ---------------------------------------------- */

    function onKeyDown(event) {
      var tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || event.target.isContentEditable) { return; }
      if (options.keyboardScope !== 'document' && !root.contains(event.target) && event.target !== document.body) { return; }

      switch (event.key) {
        case ' ': case 'k': togglePlay(); event.preventDefault(); break;
        case 'j': skip(-10); event.preventDefault(); break;
        case 'l': skip(10); event.preventDefault(); break;
        case 'ArrowLeft': skip(-5); event.preventDefault(); break;
        case 'ArrowRight': skip(5); event.preventDefault(); break;
        case 'ArrowUp': video.volume = Math.min(1, video.volume + 0.1); event.preventDefault(); break;
        case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.1); event.preventDefault(); break;
        case 'm': video.muted = !video.muted; updateVolumeUi(); break;
        case 'f': fsBtn.onclick(); break;
        case 'c': ccBtn.onclick(); break;
        case '>': video.playbackRate = Math.min(2, video.playbackRate + 0.25); speedBtn.textContent = video.playbackRate + '×'; break;
        case '<': video.playbackRate = Math.max(0.5, video.playbackRate - 0.25); speedBtn.textContent = video.playbackRate + '×'; break;
        default:
          if (/^[0-9]$/.test(event.key)) {
            seek(effectiveDuration() * (Number(event.key) / 10));
            event.preventDefault();
          }
      }
    }
    document.addEventListener('keydown', onKeyDown);

    // Restore stored preferences.
    var savedVolume = ML.storage('volume');
    if (typeof savedVolume === 'number') { video.volume = savedVolume; }
    var savedSpeed = ML.storage('speed');
    if (typeof savedSpeed === 'number') { video.playbackRate = savedSpeed; speedBtn.textContent = savedSpeed + '×'; }
    ccBtn.classList.toggle('active', captionsOn);
    updateVolumeUi();

    /* --- Public API ------------------------------------------------------ */

    var api = {
      root: root,
      video: video,
      play: play,
      pause: function () { video.pause(); },
      toggle: togglePlay,
      seek: seek,
      seekAbsolute: function (absolute) { video.currentTime = absolute; render(); },
      currentTime: relTime,
      absoluteTime: function () { return video.currentTime; },
      duration: effectiveDuration,
      setTrim: function (start, end) {
        trimStart = Number(start) || 0;
        trimEnd = end ? Number(end) : null;
        segments = null;
        activeIndex = 0;
        renderMarkers();
        render();
      },
      setSegments: function (list) {
        segments = normaliseSegments(list);
        activeIndex = 0;
        renderMarkers();
        render();
      },
      segments: function () { return segmentList().slice(); },
      toVirtual: toVirtual,
      toSource: function (v) { return toSource(v).time; },
      setCaptions: function (list) {
        captions = (list || []).map(function (item) {
          return { start: Number(item.start), end: Number(item.end), text: String(item.text) };
        });
        if (captions.length && ML.storage('captionsOn') === true) { captionsOn = true; }
        ccBtn.classList.toggle('active', captionsOn);
        render();
      },
      setChapters: function (list) { chapters = list || []; renderMarkers(); render(); },
      setMarkers: function (list) { markers = list || []; renderMarkers(); },
      /** Float an emoji up from the player, used by live reactions. */
      floatEmoji: function (emoji) {
        var node = el('div.reaction-float', {
          text: emoji,
          style: { left: (12 + Math.random() * 66) + '%' }
        });
        root.appendChild(node);
        setTimeout(function () { node.remove(); }, 1750);
      },
      destroy: function () {
        document.removeEventListener('keydown', onKeyDown);
        clearTimeout(hideTimer);
        video.pause();
        video.removeAttribute('src');
        video.load();
        root.remove();
      }
    };

    if (options.captions) { api.setCaptions(options.captions); }
    if (options.autoplay) { setTimeout(play, 60); }
    return api;
  }

  ML.Player = Player;
})(window, document);
