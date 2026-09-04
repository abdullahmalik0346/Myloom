/* ==========================================================================
   MyLoom record view — the capture studio.
   Wires ML.Recorder to a preview stage with a draggable camera bubble,
   a drawing palette, live timer and upload indicator.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var Views = ML.Views = ML.Views || {};

  Views.record = function (root) {
    var caps = ML.capabilities();
    var recorder = null;
    var stageCanvasHolder = el('div', { style: { position: 'absolute', inset: '0' } });
    var placeholder = el('div.placeholder', {}, [
      el('div', { style: { fontSize: '34px' } }, '🖥'),
      el('p.small', {}, 'Choose a mode, then click “Set up sources”.')
    ]);
    var statusPill = el('div.rec-status', { style: { display: 'none' } });
    var uploadNote = el('p.hint');
    var progressBar = el('div.upload-progress', { style: { display: 'none' } }, el('i', { style: { width: '0%' } }));

    var settings = ML.storage('recordSettings') || {};
    // 'screen_camera' was one mode before the camera became its own switch.
    var mode = settings.mode === 'screen_camera' ? 'screen' : (settings.mode || 'screen');
    var camBubble = settings.mode === 'screen_camera' ? true : settings.camBubble !== false;
    var micEnabled = settings.mic !== false;
    var systemAudio = settings.systemAudio !== false;
    var transcript = settings.transcript !== false;
    var countdownOn = settings.countdown !== false;

    /* --- Mode picker ------------------------------------------------------- */

    // The same three modes the browser extension offers, so the two match.
    var modes = [
      { key: 'screen', icon: '🖥️', title: 'Screen', desc: 'A whole display or one window' },
      { key: 'tab', icon: '🗔', title: 'Tab', desc: 'One browser tab, with its audio' },
      { key: 'camera', icon: '🎥', title: 'Camera', desc: 'A talking-head video' }
    ];
    var modeGrid = el('div.mode-grid', {}, modes.map(function (item) {
      return el('div.mode' + (mode === item.key ? '.active' : ''), {
        role: 'button', tabindex: '0',
        onclick: function () { chooseMode(item.key); },
        onkeydown: function (event) { if (event.key === 'Enter' || event.key === ' ') { chooseMode(item.key); event.preventDefault(); } }
      }, [
        el('div.ico', { text: item.icon }),
        el('div.t', { text: item.title }),
        el('div.d', { text: item.desc })
      ]);
    }));

    function chooseMode(key) {
      if (recorder && recorder.isRecording()) { return; }
      mode = key;
      ML.$$('.mode', modeGrid).forEach(function (node, index) {
        node.classList.toggle('active', modes[index].key === key);
      });
      persist();
      if (recorder && recorder.state === 'preview') { setup(); }
    }

    function persist() {
      ML.storage('recordSettings', {
        mode: mode, camBubble: camBubble, mic: micEnabled, systemAudio: systemAudio,
        transcript: transcript, countdown: countdownOn
      });
    }

    /* --- Options ----------------------------------------------------------- */

    function toggle(label, checked, sub, onChange) {
      var input = el('input', { type: 'checkbox', checked: checked, onchange: function (event) { onChange(event.target.checked); } });
      return el('label.check', {}, [input, el('span', {}, [label, sub ? el('span.check-sub', { text: sub }) : null])]);
    }

    var optionsCard = el('div.card.pad', {}, [
      el('h3', {}, 'Capture options'),
      toggle('Camera bubble', camBubble, 'Show your webcam in a corner of the screen recording',
        function (value) {
          camBubble = value;
          persist();
          syncRecorder();
          if (recorder && recorder.state === 'preview') { setup(); }
        }),
      toggle('Microphone', micEnabled, 'Record your voice', function (value) { micEnabled = value; persist(); syncRecorder(); }),
      toggle('System audio', systemAudio, 'Include sound from the shared tab or screen (Chrome/Edge)', function (value) { systemAudio = value; persist(); syncRecorder(); }),
      toggle('Capture transcript', transcript, caps.speech
        ? 'Generates captions from your speech while recording'
        : 'Not supported in this browser — use Chrome or Edge', function (value) { transcript = value; persist(); syncRecorder(); }),
      toggle('3-second countdown', countdownOn, null, function (value) { countdownOn = value; persist(); })
    ]);

    function syncRecorder() {
      if (!recorder) { return; }
      recorder.micEnabled = micEnabled;
      recorder.setCamBubble(camBubble);
      recorder.systemAudio = systemAudio;
      recorder.captureTranscript = transcript && caps.speech;
    }

    /* --- Drawing palette --------------------------------------------------- */

    var penToggle = el('button.btn.sm', {
      type: 'button', title: 'Draw on the recording',
      onclick: function () {
        if (!recorder) { return; }
        recorder.penEnabled = !recorder.penEnabled;
        penToggle.classList.toggle('active', recorder.penEnabled);
        penToggle.classList.toggle('primary', recorder.penEnabled);
        palette.style.display = recorder.penEnabled ? '' : 'none';
        stage.style.cursor = recorder.penEnabled ? 'crosshair' : '';
      }
    }, '✏️ Draw');

    var palette = el('div.draw-palette', { style: { display: 'none' } },
      ML.Recorder.PEN_COLORS.map(function (color, index) {
        return el('i.swatch' + (index === 0 ? '.active' : ''), {
          style: { background: color }, title: color,
          onclick: function () {
            if (recorder) { recorder.penColor = color; }
            ML.$$('.swatch', palette).forEach(function (node) { node.classList.remove('active'); });
            this.classList.add('active');
          }
        });
      }).concat([
        el('button.btn.sm.ghost', {
          type: 'button', onclick: function () { if (recorder) { recorder.clearDrawing(); } }
        }, 'Clear')
      ]));

    /* --- Stage (preview + pointer interactions) ---------------------------- */

    var stage = el('div.preview-stage', {}, [stageCanvasHolder, placeholder, statusPill]);
    var draggingBubble = false;

    function stageCoords(event) {
      var rect = stage.getBoundingClientRect();
      var canvas = recorder && recorder.previewCanvas;
      if (!canvas) { return { x: 0, y: 0 }; }
      // The canvas is letterboxed inside the stage; map back to canvas space.
      var stageRatio = rect.width / rect.height;
      var canvasRatio = canvas.width / canvas.height;
      var drawnW = stageRatio > canvasRatio ? rect.height * canvasRatio : rect.width;
      var drawnH = stageRatio > canvasRatio ? rect.height : rect.width / canvasRatio;
      var offsetX = (rect.width - drawnW) / 2;
      var offsetY = (rect.height - drawnH) / 2;
      return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left - offsetX) / drawnW)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top - offsetY) / drawnH))
      };
    }

    function overBubble(point) {
      if (!recorder || !recorder.wantsBubble()) { return false; }
      var bubble = recorder.getBubble();
      var canvas = recorder.previewCanvas;
      var w = (bubble.size * canvas.height) / canvas.width;
      return point.x >= bubble.x && point.x <= bubble.x + w &&
             point.y >= bubble.y && point.y <= bubble.y + bubble.size;
    }

    stage.addEventListener('pointerdown', function (event) {
      if (!recorder) { return; }
      var point = stageCoords(event);
      if (overBubble(point) && !recorder.penEnabled) {
        draggingBubble = true;
        stage.setPointerCapture(event.pointerId);
      } else if (recorder.penEnabled) {
        recorder.penStart(point.x, point.y);
        stage.setPointerCapture(event.pointerId);
      }
    });
    stage.addEventListener('pointermove', function (event) {
      if (!recorder) { return; }
      var point = stageCoords(event);
      if (draggingBubble) {
        var bubble = recorder.getBubble();
        recorder.moveBubble(point.x - (bubble.size * recorder.previewCanvas.height / recorder.previewCanvas.width) / 2,
          point.y - bubble.size / 2);
      } else if (recorder.penEnabled) {
        recorder.penMove(point.x, point.y);
      } else {
        stage.style.cursor = overBubble(point) ? 'grab' : '';
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
      stage.addEventListener(name, function () {
        draggingBubble = false;
        if (recorder) { recorder.penEnd(); }
      });
    });

    var bubbleSize = el('input', {
      type: 'range', min: '10', max: '45', value: '24', style: { width: '110px' },
      oninput: function (event) { if (recorder) { recorder.setBubbleSize(Number(event.target.value) / 100); } }
    });

    // Drop the camera out of the recording without ending it — for the stretch
    // where the screen is the point and a face in the corner is in the way.
    var cameraBtn = el('button.btn.sm', {
      type: 'button', title: 'Turn the camera bubble off or on',
      onclick: function () {
        if (!recorder) { return; }
        var on = recorder.setCameraOn(!recorder.cameraOn);
        cameraBtn.textContent = on ? '🎥' : '🚫';
        cameraBtn.classList.toggle('off', !on);
      }
    }, '🎥');

    // Dragging works on the preview, but only while you are looking at it. The
    // corner buttons put the bubble somewhere definite, mid-recording included.
    var corners = [
      { key: 'tl', glyph: '◤', title: 'Bubble top left' },
      { key: 'tr', glyph: '◥', title: 'Bubble top right' },
      { key: 'bl', glyph: '◣', title: 'Bubble bottom left' },
      { key: 'br', glyph: '◢', title: 'Bubble bottom right' }
    ];
    var cornerRow = el('div.corner-row', {}, corners.map(function (item) {
      return el('button.btn.sm' + (item.key === 'bl' ? '.active' : ''), {
        type: 'button', title: item.title,
        onclick: function () {
          if (!recorder) { return; }
          recorder.setBubbleCorner(item.key);
          ML.$$('button', cornerRow).forEach(function (node, index) {
            node.classList.toggle('active', corners[index].key === item.key);
          });
        }
      }, item.glyph);
    }));

    /* --- Controls ---------------------------------------------------------- */

    var setupBtn = el('button.btn.primary', { type: 'button', onclick: function () { setup(); } }, 'Set up sources');
    var startBtn = el('button.btn.primary', { type: 'button', style: { display: 'none' }, onclick: start }, '⏺ Start recording');
    var pauseBtn = el('button.btn', { type: 'button', style: { display: 'none' }, onclick: function () { recorder.togglePause(); } }, '⏸ Pause');
    var stopBtn = el('button.btn.danger', { type: 'button', style: { display: 'none' }, onclick: stop }, '⏹ Stop & save');
    var cancelBtn = el('button.btn.ghost', { type: 'button', style: { display: 'none' }, onclick: cancel }, 'Discard');
    var timerLabel = el('span.small.muted');

    var toolbar = el('div.rec-toolbar', {}, [
      setupBtn, startBtn, pauseBtn, stopBtn, cancelBtn,
      el('span.grow'),
      penToggle, palette,
      el('label.tiny.muted.row', { style: { gap: '6px' } }, ['Bubble', bubbleSize]),
      cameraBtn, cornerRow,
      timerLabel
    ]);

    /* --- Recorder lifecycle ------------------------------------------------ */

    function ensureRecorder() {
      if (recorder) { return recorder; }
      recorder = ML.Recorder({
        countdown: countdownOn ? 3 : 0,
        onState: onState,
        onTick: function (seconds) { statusPill.lastChild.textContent = ML.duration(seconds); },
        onUpload: function (sent, pending) {
          uploadNote.textContent = 'Uploaded ' + ML.bytes(sent) + (pending ? ' · ' + pending + ' chunk(s) queued' : ' · in sync');
        },
        onError: function (error) { ML.toastError(error); }
      });
      syncRecorder();
      recorder.setMode(mode);
      return recorder;
    }

    function setup() {
      var instance = ensureRecorder();
      instance.setMode(mode);
      instance.countdown = countdownOn ? 3 : 0;
      syncRecorder();
      setupBtn.disabled = true;
      setupBtn.textContent = 'Requesting access…';

      instance.prepare().then(function () {
        placeholder.style.display = 'none';
        clear(stageCanvasHolder);
        var canvas = instance.previewCanvas;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'contain';
        stageCanvasHolder.appendChild(canvas);
        setupBtn.style.display = 'none';
        startBtn.style.display = '';
        cancelBtn.style.display = '';
        cancelBtn.textContent = 'Reset';
      }).catch(function (error) {
        setupBtn.disabled = false;
        setupBtn.textContent = 'Set up sources';
        if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
          ML.toast('Screen sharing was cancelled.', 'error');
        } else {
          ML.toastError(error);
        }
      });
    }

    function start() {
      recorder.countdown = countdownOn ? 3 : 0;
      startBtn.disabled = true;
      recorder.start({
        title: 'Recording ' + new Date().toLocaleString(),
        spaceId: App.state.currentSpace || 0,
        visibility: 'link'
      }).then(function () {
        startBtn.disabled = false;
      }).catch(function (error) {
        startBtn.disabled = false;
        ML.toastError(error);
      });
    }

    function stop() {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Saving…';
      recorder.stop().then(function (result) {
        ML.toast('Recording saved', 'success');
        // Refresh so the sidebar storage figure reflects the new file.
        return App.refreshMe().catch(function () {}).then(function () {
          App.go('/video/' + result.uid + '?new=1');
        });
      }).catch(function (error) {
        stopBtn.disabled = false;
        stopBtn.textContent = '⏹ Stop & save';
        ML.toastError(error);
      });
    }

    function cancel() {
      var wasRecording = recorder && recorder.isRecording();
      var run = function () {
        recorder.cancel().then(function () {
          recorder = null;
          clear(stageCanvasHolder);
          placeholder.style.display = '';
          setupBtn.style.display = '';
          setupBtn.disabled = false;
          setupBtn.textContent = 'Set up sources';
          uploadNote.textContent = '';
          progressBar.style.display = 'none';
        });
      };
      if (!wasRecording) { run(); return; }
      ML.confirm({
        title: 'Discard this recording?',
        message: 'Everything captured so far will be deleted.', danger: true, confirmLabel: 'Discard'
      }).then(function (yes) { if (yes) { run(); } });
    }

    function onState(state) {
      var recording = state === 'recording' || state === 'paused';
      startBtn.style.display = state === 'preview' ? '' : 'none';
      pauseBtn.style.display = recording ? '' : 'none';
      stopBtn.style.display = recording ? '' : 'none';
      cancelBtn.style.display = (state === 'preview' || recording) ? '' : 'none';
      cancelBtn.textContent = recording ? 'Discard' : 'Reset';
      pauseBtn.textContent = state === 'paused' ? '▶ Resume' : '⏸ Pause';
      progressBar.style.display = recording || state === 'finishing' ? '' : 'none';

      clear(statusPill);
      if (recording) {
        statusPill.style.display = '';
        ML.append(statusPill, [
          el('i.rec-dot', { style: state === 'paused' ? { animation: 'none', opacity: '.4' } : null }),
          el('span', { text: state === 'paused' ? 'Paused' : 'Recording' }),
          el('span', { text: '0:00' })
        ]);
      } else {
        statusPill.style.display = 'none';
      }
      window.onbeforeunload = recording ? function () { return 'A recording is in progress.'; } : null;
    }

    /* --- Warnings ---------------------------------------------------------- */

    var warnings = [];
    if (!caps.secure) {
      warnings.push('This page is not on HTTPS, so browsers will block screen and camera access. Enable AutoSSL in cPanel, then reload over https://.');
    }
    if (!caps.displayCapture) {
      warnings.push('This browser cannot capture the screen. Chrome, Edge, Firefox or Safari 17+ on desktop can.');
    }
    if (!caps.speech && transcript) {
      warnings.push('Automatic transcripts need Chrome or Edge. Recording still works — you can add a transcript later.');
    }

    /* --- Layout ------------------------------------------------------------ */

    clear(root).appendChild(el('div.recorder', {}, [
      el('div.page-head', {}, [
        el('div', {}, [
          el('h1', {}, 'New recording'),
          el('p.muted.small', {}, 'Nothing leaves your browser until you press record — then it streams straight to your server.')
        ]),
        el('button.btn.ghost', { type: 'button', onclick: function () { App.go('/'); } }, 'Back to library')
      ]),
      warnings.length
        ? el('div.card.pad.mb', { style: { borderColor: 'var(--warn)' } },
            warnings.map(function (text) { return el('p.small', { text: '⚠️ ' + text }); }))
        : null,
      modeGrid,
      stage,
      toolbar,
      progressBar,
      uploadNote,
      el('div.mt-lg', {}, optionsCard),
      el('div.card.pad.mt', {}, [
        el('h3', {}, 'Tips'),
        el('ul.small.muted', { style: { paddingLeft: '18px', margin: '0' } }, [
          el('li', {}, 'Chrome and Edge can share tab audio — tick “Share tab audio” in the picker.'),
          el('li', {}, 'Drag the camera bubble anywhere on the stage; the slider resizes it.'),
          el('li', {}, 'Turn on Draw to annotate live — strokes are burned into the recording.'),
          el('li', {}, 'Chunks upload while you record, so long sessions will not exhaust memory.')
        ])
      ])
    ]));

    // Clean up if the user navigates away mid-session.
    return function cleanup() {
      window.onbeforeunload = null;
      if (recorder) {
        if (recorder.isRecording()) { recorder.stop().catch(function () {}); }
        else { recorder.destroy(); }
      }
    };
  };
})(window, document);
