/* ==========================================================================
   MyLoom cut & stitch — split a recording into pieces, drop the ones you do
   not want, and reorder what is left.

   A video's playback is an ordered list of keep-segments. Cutting the middle
   out is just splitting one segment into two and deleting neither; deleting a
   piece removes it from the list. Nothing is re-encoded here, so every edit is
   instant and reversible — "Apply permanently" is what bakes it into the file.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;

  /** open({ video, onSaved }) */
  function open(options) {
    var video = options.video;
    var duration = Number(video.duration) || 0;
    var segments = (video.segments && video.segments.length
      ? video.segments
      : [{ start: Number(video.trim_start) || 0, end: Number(video.trim_end) || duration }])
      .map(function (s) { return { start: Number(s.start), end: Number(s.end) }; });

    var original = JSON.stringify(segments);
    var selected = 0;
    var player = null;
    var dirty = false;

    var stageWrap = el('div', { style: { position: 'relative' } });
    var stripNode = el('div.cut-strip');
    var listNode = el('div.col', { style: { gap: '4px' } });
    var summaryNode = el('p.hint');
    var timeLabel = el('span.tiny.muted');

    var dialog = ML.modal({
      title: 'Cut & stitch — ' + video.title,
      wide: true,
      dismissable: false,
      body: function () {
        return el('div.editor', {}, [
          el('p.hint', {}, 'Split the recording where you want, then delete the pieces you do not need. '
            + 'Playback skips straight over anything you remove.'),
          stageWrap,
          el('div.row.between.mt', {}, [timeLabel, summaryNode]),
          el('div.cut-tools', {}, [
            el('button.btn.sm.primary', {
              type: 'button', title: 'Split the piece under the playhead in two',
              onclick: splitAtPlayhead
            }, '✂ Split here'),
            el('button.btn.sm', {
              type: 'button', title: 'Delete the piece under the playhead',
              onclick: deleteAtPlayhead
            }, '🗑 Delete this piece'),
            el('button.btn.sm', {
              type: 'button', title: 'Keep only from the playhead onwards',
              onclick: function () { trimTo('start'); }
            }, '⇥ Trim start to here'),
            el('button.btn.sm', {
              type: 'button', title: 'Keep only up to the playhead',
              onclick: function () { trimTo('end'); }
            }, '⇤ Trim end to here'),
            el('button.btn.sm', {
              type: 'button', title: 'Find quiet stretches and drop them',
              onclick: removeSilences
            }, '🤫 Remove silences'),
            el('span.grow'),
            el('button.btn.sm.ghost', { type: 'button', onclick: resetAll }, '↺ Reset to full video')
          ]),
          stripNode,
          el('div.card.mt', {}, [
            el('div.card-head', {}, el('strong.small', {}, 'Pieces (in play order)')),
            el('div.card-body', { style: { maxHeight: '220px', overflowY: 'auto' } }, listNode)
          ])
        ]);
      }
    });

    dialog.root.classList.add('editor-modal');
    dialog.setFooter([
      el('span.grow.tiny.muted', { id: 'cut-count' }),
      el('button.btn', {
        type: 'button',
        onclick: function () {
          if (JSON.stringify(segments) === original) { close(); return; }
          ML.confirm({
            title: 'Discard these cuts?', message: 'The video goes back to how it was.',
            danger: true, confirmLabel: 'Discard'
          }).then(function (yes) { if (yes) { close(); } });
        }
      }, 'Cancel'),
      el('button.btn.primary', { type: 'button', onclick: save }, 'Save cuts')
    ]);

    function close() {
      if (player) { player.destroy(); }
      dialog.close();
    }

    player = ML.Player(stageWrap, {
      src: video.media_url,
      poster: video.thumbnail,
      fallbackDuration: duration,
      segments: segments,
      showCaptions: false,
      onProgress: function () {
        timeLabel.textContent = 'Playhead at ' + ML.timecode(player.absoluteTime(), true) +
          ' of the original';
        positionPlayhead();
      },
      onReady: render
    });

    /* --- Editing operations ------------------------------------------------ */

    /** Index of the piece containing a source time, or -1. */
    function pieceAt(time) {
      for (var i = 0; i < segments.length; i++) {
        if (time >= segments[i].start - 0.02 && time <= segments[i].end + 0.02) { return i; }
      }
      return -1;
    }

    function splitAtPlayhead() {
      var t = player.absoluteTime();
      var index = pieceAt(t);
      if (index === -1) {
        ML.toast('The playhead is inside a removed part — move it over a kept piece first.', 'error');
        return;
      }
      var piece = segments[index];
      if (t - piece.start < 0.2 || piece.end - t < 0.2) {
        ML.toast('Too close to the edge of this piece to split.', 'error');
        return;
      }
      segments.splice(index, 1,
        { start: piece.start, end: round(t) },
        { start: round(t), end: piece.end });
      selected = index + 1;
      changed();
    }

    function deleteAtPlayhead() {
      var index = pieceAt(player.absoluteTime());
      if (index === -1) { index = selected; }
      removePiece(index);
    }

    function removePiece(index) {
      if (segments.length <= 1) {
        ML.toast('A video needs at least one piece. Split it first, then delete.', 'error');
        return;
      }
      segments.splice(index, 1);
      selected = Math.min(selected, segments.length - 1);
      changed();
    }

    function trimTo(edge) {
      var t = player.absoluteTime();
      var index = pieceAt(t);
      if (index === -1) {
        ML.toast('Move the playhead over a kept piece first.', 'error');
        return;
      }
      if (edge === 'start') {
        segments = segments.slice(index);
        segments[0] = { start: round(t), end: segments[0].end };
      } else {
        segments = segments.slice(0, index + 1);
        segments[segments.length - 1] = { start: segments[segments.length - 1].start, end: round(t) };
      }
      segments = segments.filter(function (s) { return s.end - s.start > 0.08; });
      if (!segments.length) { segments = [{ start: 0, end: duration }]; }
      selected = 0;
      changed();
    }

    function resetAll() {
      segments = [{ start: 0, end: duration }];
      selected = 0;
      changed();
    }

    function move(index, delta) {
      var target = index + delta;
      if (target < 0 || target >= segments.length) { return; }
      var item = segments.splice(index, 1)[0];
      segments.splice(target, 0, item);
      selected = target;
      changed();
    }

    function changed() {
      dirty = true;
      player.setSegments(segments);
      render();
    }

    function round(value) { return Math.round(value * 100) / 100; }

    function playDuration() {
      return segments.reduce(function (sum, s) { return sum + Math.max(0, s.end - s.start); }, 0);
    }

    /* --- Silence removal --------------------------------------------------- */

    /**
     * Decode the audio track, find stretches quieter than a threshold for
     * longer than a minimum, and drop them. Decoding needs the whole file in
     * memory, so this is refused for very large recordings.
     */
    function removeSilences() {
      var minGap = 0.7;      // seconds of quiet before it counts
      var pad = 0.12;        // keep a little either side so speech is not clipped

      ML.modal({
        title: 'Remove silences',
        body: [
          el('p.small', {}, 'Finds quiet stretches longer than ' + minGap +
            's and removes them, keeping a moment either side so speech is not clipped.'),
          el('p.hint', {}, 'The audio is analysed in your browser, so nothing is uploaded. '
            + 'Large recordings may take a moment.')
        ],
        footer: function (api) {
          return [
            el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
            el('button.btn.primary', {
              type: 'button',
              onclick: function (event) {
                var button = event.target;
                button.disabled = true;
                button.textContent = 'Analysing…';
                detectSilences(video.media_url, minGap, pad)
                  .then(function (kept) {
                    api.close();
                    if (!kept.length) {
                      ML.toast('No silences long enough to remove.', 'error');
                      return;
                    }
                    var before = playDuration();
                    segments = kept;
                    selected = 0;
                    changed();
                    ML.toast('Removed ' + ML.timecode(Math.max(0, before - playDuration())) +
                      ' of silence across ' + kept.length + ' piece(s)', 'success');
                  })
                  .catch(function (error) {
                    button.disabled = false;
                    button.textContent = 'Find silences';
                    ML.toastError(error);
                  });
              }
            }, 'Find silences')
          ];
        }
      });
    }

    function detectSilences(url, minGap, pad) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) { return Promise.reject(new Error('This browser cannot analyse audio.')); }

      return fetch(url, { credentials: 'same-origin' }).then(function (response) {
        var length = Number(response.headers.get('content-length') || 0);
        if (length > 300 * 1024 * 1024) {
          throw new Error('This recording is too large to analyse in the browser (over 300 MB).');
        }
        return response.arrayBuffer();
      }).then(function (buffer) {
        var ctx = new AudioCtx();
        return ctx.decodeAudioData(buffer).then(function (audio) {
          ctx.close();
          return audio;
        }, function () {
          ctx.close();
          throw new Error('The audio track could not be decoded, so silences cannot be found.');
        });
      }).then(function (audio) {
        var data = audio.getChannelData(0);
        var rate = audio.sampleRate;
        var windowSize = Math.max(1, Math.floor(rate * 0.02));   // 20 ms windows
        var levels = [];
        var peak = 0;

        for (var i = 0; i < data.length; i += windowSize) {
          var sum = 0;
          var end = Math.min(data.length, i + windowSize);
          for (var j = i; j < end; j++) { sum += data[j] * data[j]; }
          var rms = Math.sqrt(sum / Math.max(1, end - i));
          levels.push(rms);
          if (rms > peak) { peak = rms; }
        }
        if (peak <= 0) { throw new Error('This recording has no audio to analyse.'); }

        // Relative threshold so quiet and loud recordings behave the same.
        var threshold = Math.max(peak * 0.06, 0.006);
        var windowSeconds = windowSize / rate;
        var loud = [];
        var runStart = null;

        for (var k = 0; k < levels.length; k++) {
          var isLoud = levels[k] >= threshold;
          if (isLoud && runStart === null) { runStart = k * windowSeconds; }
          if (!isLoud && runStart !== null) {
            loud.push({ start: runStart, end: k * windowSeconds });
            runStart = null;
          }
        }
        if (runStart !== null) { loud.push({ start: runStart, end: levels.length * windowSeconds }); }
        if (!loud.length) { return []; }

        // Pad, then merge anything separated by less than the minimum gap.
        var merged = [];
        loud.forEach(function (piece) {
          var start = Math.max(0, piece.start - pad);
          var end = Math.min(audio.duration, piece.end + pad);
          var last = merged[merged.length - 1];
          if (last && start - last.end < minGap) { last.end = end; }
          else { merged.push({ start: start, end: end }); }
        });

        return merged
          .filter(function (piece) { return piece.end - piece.start > 0.25; })
          .map(function (piece) { return { start: round(piece.start), end: round(piece.end) }; });
      });
    }

    /* --- Rendering ---------------------------------------------------------- */

    var playhead = null;

    function render() {
      renderStrip();
      renderList();
      var kept = playDuration();
      var removed = Math.max(0, duration - kept);
      summaryNode.textContent = segments.length + ' piece(s) · ' + ML.timecode(kept) +
        ' kept of ' + ML.timecode(duration) +
        (removed > 0.5 ? ' · ' + ML.timecode(removed) + ' removed' : '');
      var counter = dialog.root.querySelector('#cut-count');
      if (counter) { counter.textContent = ML.timecode(kept) + ' final length'; }
    }

    /**
     * The strip shows the ORIGINAL timeline: kept pieces solid, removed
     * stretches hatched. That is the view that makes a cut understandable —
     * you see what is gone, not just what is left.
     */
    function renderStrip() {
      clear(stripNode);
      if (duration <= 0) { return; }

      var sorted = segments.slice().sort(function (a, b) { return a.start - b.start; });
      var cursor = 0;
      var pieces = [];

      sorted.forEach(function (piece) {
        if (piece.start > cursor + 0.05) {
          pieces.push({ kind: 'gap', start: cursor, end: piece.start });
        }
        pieces.push({ kind: 'keep', start: piece.start, end: piece.end, ref: piece });
        cursor = Math.max(cursor, piece.end);
      });
      if (cursor < duration - 0.05) { pieces.push({ kind: 'gap', start: cursor, end: duration }); }

      pieces.forEach(function (piece) {
        var index = segments.indexOf(piece.ref);
        var node = el('div.cut-piece' + (piece.kind === 'gap' ? '.gap' : '') +
          (index === selected && piece.kind === 'keep' ? '.active' : ''), {
          style: { width: (((piece.end - piece.start) / duration) * 100) + '%' },
          title: piece.kind === 'gap'
            ? 'Removed ' + ML.timecode(piece.start) + '–' + ML.timecode(piece.end)
            : 'Piece ' + (index + 1) + ': ' + ML.timecode(piece.start) + '–' + ML.timecode(piece.end),
          onclick: function () {
            if (piece.kind === 'keep') { selected = index; }
            player.seekAbsolute(piece.start + 0.05);
            render();
          }
        }, piece.kind === 'keep' && (piece.end - piece.start) / duration > 0.08
          ? el('span.cut-piece-label', { text: ML.timecode(piece.end - piece.start) })
          : null);
        stripNode.appendChild(node);
      });

      playhead = el('div.tl-playhead');
      stripNode.appendChild(playhead);
      positionPlayhead();
    }

    function positionPlayhead() {
      if (!playhead || duration <= 0) { return; }
      playhead.style.left = Math.max(0, Math.min(100, (player.absoluteTime() / duration) * 100)) + '%';
    }

    function renderList() {
      clear(listNode);
      segments.forEach(function (piece, index) {
        listNode.appendChild(el('div.ov-row' + (index === selected ? '.active' : ''), {
          onclick: function () { selected = index; player.seekAbsolute(piece.start + 0.05); render(); }
        }, [
          el('span.tiny.muted', { text: '#' + (index + 1) }),
          el('span.grow', {
            text: ML.timecode(piece.start, true) + ' – ' + ML.timecode(piece.end, true) +
              '  (' + ML.timecode(piece.end - piece.start, true) + ')'
          }),
          el('button.btn.sm.ghost', {
            type: 'button', title: 'Move earlier', disabled: index === 0,
            onclick: function (event) { event.stopPropagation(); move(index, -1); }
          }, '↑'),
          el('button.btn.sm.ghost', {
            type: 'button', title: 'Move later', disabled: index === segments.length - 1,
            onclick: function (event) { event.stopPropagation(); move(index, 1); }
          }, '↓'),
          el('button.btn.sm.ghost', {
            type: 'button', title: 'Delete this piece',
            onclick: function (event) { event.stopPropagation(); removePiece(index); }
          }, '✕')
        ]));
      });
      if (!segments.length) {
        listNode.appendChild(el('p.small.muted', {}, 'No pieces left — reset to start again.'));
      }
    }

    /* --- Save --------------------------------------------------------------- */

    function save() {
      if (!segments.length) { ML.toast('Nothing left to play.', 'error'); return; }
      ML.post('videos/update', {
        uid: video.uid,
        segments: segments.map(function (s) { return { start: s.start, end: s.end }; })
      }).then(function () {
        ML.toast('Cuts saved', 'success');
        dirty = false;
        if (options.onSaved) { options.onSaved(segments); }
        close();
      }).catch(ML.toastError);
    }

    render();
    return dialog;
  }

  ML.CutEditor = { open: open };
})(window, document);
