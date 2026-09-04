/* ==========================================================================
   MyLoom screenshots — take one, mark it up, share it.

   A screenshot is stored exactly like a recording: same table, same upload,
   same share page, so it gets comments, permissions and view counts for free.
   Only the file and the viewer differ.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var Shot = ML.Shot = {};

  var COLORS = ['#e5484d', '#f5a524', '#12a150', '#1f7ae0', '#8b5cf6', '#ffffff', '#111318'];

  /* --- Capture --------------------------------------------------------------- */

  /** One frame of a shared screen, window or tab, as a canvas. */
  Shot.capture = function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error('This browser cannot capture the screen. Chrome, Edge and Firefox on desktop can.'));
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 5 } },
      audio: false
    }).then(function (stream) {
      var video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      var done = function (canvas) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return canvas;
      };
      return video.play().then(function () {
        // The first frame after play() can still be blank; give it a moment.
        return new Promise(function (resolve) { setTimeout(resolve, 220); });
      }).then(function () {
        if (!video.videoWidth) { throw new Error('Nothing was captured — the share was cancelled or empty.'); }
        var canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        return done(canvas);
      }).catch(function (error) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        throw error;
      });
    });
  };

  /** Load an already-saved screenshot back into a canvas so it can be edited. */
  Shot.load = function (url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.crossOrigin = 'use-credentials';
      image.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        resolve(canvas);
      };
      image.onerror = function () { reject(new Error('That image could not be loaded.')); };
      image.src = url;
    });
  };

  /* --- Editor ---------------------------------------------------------------- */

  /**
   * Mark up a canvas. Shapes are kept as a list and the whole picture is
   * redrawn from the original on every change, so undo is just a pop and
   * nothing is ever baked in until it is saved.
   *
   * options.onSave(blob, canvas) — called with the finished PNG.
   * options.saveLabel            — wording for the primary button.
   */
  Shot.editor = function (base, options) {
    options = options || {};
    var shapes = [];
    var tool = 'arrow';
    var color = COLORS[0];
    var pending = null;                 // the shape being dragged out
    var textInput = null;

    var view = document.createElement('canvas');
    var vctx = view.getContext('2d');
    var stage = el('div.shot-stage', {}, view);

    /* -- drawing ---------------------------------------------------------- */

    function scale() {
      return view.width / base.width;
    }

    function fit() {
      var maxW = Math.max(320, stage.clientWidth || 900);
      var maxH = Math.max(240, (window.innerHeight || 800) - 230);
      var ratio = Math.min(1, maxW / base.width, maxH / base.height);
      view.width = Math.round(base.width * ratio);
      view.height = Math.round(base.height * ratio);
      render();
    }

    function render() {
      vctx.clearRect(0, 0, view.width, view.height);
      vctx.drawImage(base, 0, 0, view.width, view.height);
      shapes.concat(pending ? [pending] : []).forEach(function (shape) { paint(shape); });
    }

    function paint(shape) {
      var k = scale();
      var x1 = shape.x1 * k, y1 = shape.y1 * k, x2 = shape.x2 * k, y2 = shape.y2 * k;
      var line = Math.max(2, Math.round(view.width / 260));

      vctx.save();
      vctx.strokeStyle = shape.color;
      vctx.fillStyle = shape.color;
      vctx.lineWidth = line;
      vctx.lineCap = 'round';
      vctx.lineJoin = 'round';

      if (shape.type === 'box') {
        vctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      } else if (shape.type === 'arrow') {
        var angle = Math.atan2(y2 - y1, x2 - x1);
        var head = Math.max(10, line * 4);
        vctx.beginPath();
        vctx.moveTo(x1, y1);
        vctx.lineTo(x2, y2);
        vctx.stroke();
        vctx.beginPath();
        vctx.moveTo(x2, y2);
        vctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
        vctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
        vctx.closePath();
        vctx.fill();
      } else if (shape.type === 'pen') {
        vctx.beginPath();
        (shape.points || []).forEach(function (point, index) {
          var px = point.x * k, py = point.y * k;
          if (index === 0) { vctx.moveTo(px, py); } else { vctx.lineTo(px, py); }
        });
        vctx.stroke();
      } else if (shape.type === 'blur') {
        blur(shape, k);
      } else if (shape.type === 'text') {
        var size = Math.max(14, Math.round(shape.size * k));
        vctx.font = '700 ' + size + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        vctx.textBaseline = 'top';
        vctx.lineWidth = Math.max(3, size / 6);
        vctx.strokeStyle = 'rgba(0,0,0,.55)';
        vctx.strokeText(shape.text, x1, y1);
        vctx.fillStyle = shape.color;
        vctx.fillText(shape.text, x1, y1);
      }
      vctx.restore();
    }

    /** Pixellate a region by round-tripping it through a tiny canvas. */
    function blur(shape, k) {
      var x = Math.min(shape.x1, shape.x2), y = Math.min(shape.y1, shape.y2);
      var w = Math.abs(shape.x2 - shape.x1), h = Math.abs(shape.y2 - shape.y1);
      if (w < 4 || h < 4) { return; }

      var small = document.createElement('canvas');
      small.width = Math.max(2, Math.round(w / 22));
      small.height = Math.max(2, Math.round(h / 22));
      var sctx = small.getContext('2d');
      sctx.drawImage(base, x, y, w, h, 0, 0, small.width, small.height);

      vctx.save();
      vctx.imageSmoothingEnabled = false;
      vctx.drawImage(small, 0, 0, small.width, small.height, x * k, y * k, w * k, h * k);
      vctx.restore();
    }

    /* -- pointer ---------------------------------------------------------- */

    function at(event) {
      var box = view.getBoundingClientRect();
      var k = base.width / box.width;
      return {
        x: Math.max(0, Math.min(base.width, (event.clientX - box.left) * k)),
        y: Math.max(0, Math.min(base.height, (event.clientY - box.top) * k))
      };
    }

    view.addEventListener('pointerdown', function (event) {
      if (textInput) { commitText(); return; }
      var point = at(event);
      if (tool === 'text') { openTextInput(point, event); return; }
      view.setPointerCapture(event.pointerId);
      pending = {
        type: tool, color: color,
        x1: point.x, y1: point.y, x2: point.x, y2: point.y,
        points: tool === 'pen' ? [point] : null
      };
      render();
    });

    view.addEventListener('pointermove', function (event) {
      if (!pending) { return; }
      var point = at(event);
      pending.x2 = point.x;
      pending.y2 = point.y;
      if (pending.type === 'pen') { pending.points.push(point); }
      render();
    });

    ['pointerup', 'pointercancel'].forEach(function (name) {
      view.addEventListener(name, function () {
        if (!pending) { return; }
        var big = Math.abs(pending.x2 - pending.x1) > 4 || Math.abs(pending.y2 - pending.y1) > 4;
        if (big || (pending.type === 'pen' && pending.points.length > 2)) { shapes.push(pending); }
        pending = null;
        render();
        refreshTools();
      });
    });

    /* -- text ------------------------------------------------------------- */

    function openTextInput(point, event) {
      var box = view.getBoundingClientRect();
      var stageBox = stage.getBoundingClientRect();
      textInput = el('input.shot-text', {
        type: 'text', placeholder: 'Type, then Enter',
        style: {
          left: (event.clientX - stageBox.left) + 'px',
          top: (event.clientY - stageBox.top) + 'px',
          color: color
        },
        onkeydown: function (e) {
          if (e.key === 'Enter') { commitText(); }
          if (e.key === 'Escape') { cancelText(); }
        }
      });
      textInput.dataset.x = point.x;
      textInput.dataset.y = point.y;
      stage.appendChild(textInput);
      textInput.focus();
      // Text is sized against the picture, not the screen, so it stays right
      // when the same shot is edited on a different display.
      textInput.dataset.size = Math.max(18, Math.round(base.height / 24));
      void box;
    }

    function commitText() {
      if (!textInput) { return; }
      var value = textInput.value.trim();
      if (value) {
        shapes.push({
          type: 'text', color: color, text: value,
          x1: Number(textInput.dataset.x), y1: Number(textInput.dataset.y),
          x2: 0, y2: 0, size: Number(textInput.dataset.size)
        });
      }
      cancelText();
      render();
      refreshTools();
    }

    function cancelText() {
      if (textInput && textInput.parentNode) { textInput.parentNode.removeChild(textInput); }
      textInput = null;
    }

    /* -- crop -------------------------------------------------------------- */

    function cropTo(shape) {
      var x = Math.round(Math.min(shape.x1, shape.x2));
      var y = Math.round(Math.min(shape.y1, shape.y2));
      var w = Math.round(Math.abs(shape.x2 - shape.x1));
      var h = Math.round(Math.abs(shape.y2 - shape.y1));
      if (w < 16 || h < 16) { ML.toast('Drag a larger area to crop to.', 'error'); return; }

      // Bake everything drawn so far, then keep only the chosen rectangle.
      var flat = flatten();
      var cropped = document.createElement('canvas');
      cropped.width = w;
      cropped.height = h;
      cropped.getContext('2d').drawImage(flat, x, y, w, h, 0, 0, w, h);
      base = cropped;
      shapes = [];
      fit();
      refreshTools();
    }

    /** The picture at full size with every mark on it. */
    function flatten() {
      var out = document.createElement('canvas');
      out.width = base.width;
      out.height = base.height;
      var octx = out.getContext('2d');
      octx.drawImage(base, 0, 0);

      // Reuse the painting code by pointing it at the full-size context.
      var realCtx = vctx, realView = view;
      vctx = octx;
      view = out;
      shapes.forEach(function (shape) { paint(shape); });
      vctx = realCtx;
      view = realView;
      return out;
    }

    /* -- chrome ------------------------------------------------------------ */

    var toolRow = el('div.shot-tools');
    var TOOLS = [
      { key: 'arrow', glyph: '↗', label: 'Arrow' },
      { key: 'box', glyph: '▭', label: 'Box' },
      { key: 'pen', glyph: '✎', label: 'Pen' },
      { key: 'text', glyph: 'T', label: 'Text' },
      { key: 'blur', glyph: '▩', label: 'Blur' },
      { key: 'crop', glyph: '⛶', label: 'Crop — drag, then click Apply crop' }
    ];

    function refreshTools() {
      ML.$$('.shot-tool', toolRow).forEach(function (node) {
        node.classList.toggle('active', node.dataset.tool === tool);
      });
      cropBtn.style.display = tool === 'crop' ? '' : 'none';
      undoBtn.disabled = !shapes.length;
    }

    TOOLS.forEach(function (item) {
      var button = el('button.btn.sm.shot-tool', {
        type: 'button', title: item.label,
        onclick: function () { tool = item.key; cancelText(); refreshTools(); }
      }, item.glyph);
      button.dataset.tool = item.key;
      toolRow.appendChild(button);
    });

    var colorRow = el('div.shot-colors', {}, COLORS.map(function (value) {
      return el('button.swatch' + (value === color ? '.on' : ''), {
        type: 'button', title: value, style: { background: value },
        onclick: function (event) {
          color = value;
          ML.$$('.swatch', colorRow).forEach(function (node) { node.classList.remove('on'); });
          event.target.classList.add('on');
        }
      });
    }));

    var undoBtn = el('button.btn.sm', {
      type: 'button', disabled: true,
      onclick: function () { shapes.pop(); render(); refreshTools(); }
    }, '↶ Undo');

    var cropBtn = el('button.btn.sm', {
      type: 'button', style: { display: 'none' },
      onclick: function () {
        var last = shapes[shapes.length - 1];
        if (!last || last.type !== 'crop') { ML.toast('Drag the area to keep first.', 'error'); return; }
        shapes.pop();
        cropTo(last);
      }
    }, 'Apply crop');

    var status = el('span.tiny.muted');
    var saveBtn = el('button.btn.primary', {
      type: 'button',
      onclick: function () {
        cancelText();
        saveBtn.disabled = true;
        status.textContent = 'Saving…';
        toBlob().then(function (blob) {
          return options.onSave(blob, flatten());
        }).catch(function (error) {
          ML.toastError(error);
        }).then(function () {
          saveBtn.disabled = false;
          status.textContent = '';
        });
      }
    }, options.saveLabel || 'Save & share');

    var downloadBtn = el('button.btn', {
      type: 'button',
      onclick: function () {
        cancelText();
        toBlob().then(function (blob) {
          var url = URL.createObjectURL(blob);
          var link = el('a', { href: url, download: (options.name || 'screenshot') + '.png' });
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        });
      }
    }, '⬇ PNG');

    var copyBtn = el('button.btn', {
      type: 'button',
      onclick: function () {
        toBlob().then(function (blob) {
          if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
            throw new Error('This browser cannot copy images to the clipboard.');
          }
          var item = {};
          item[blob.type] = blob;
          return navigator.clipboard.write([new window.ClipboardItem(item)]);
        }).then(function () { ML.toast('Copied to the clipboard', 'success'); })
          .catch(function (error) { ML.toastError(error); });
      }
    }, 'Copy');

    function toBlob() {
      return new Promise(function (resolve) {
        flatten().toBlob(function (blob) { resolve(blob); }, 'image/png');
      });
    }

    // The crop tool draws a rectangle like any other shape; it is just applied
    // differently, so it borrows the box drawing and a marker type.
    var realPaint = paint;
    paint = function (shape) {
      if (shape.type === 'crop') {
        vctx.save();
        vctx.setLineDash([8, 6]);
        vctx.strokeStyle = '#fff';
        vctx.lineWidth = 2;
        var k = scale();
        vctx.strokeRect(Math.min(shape.x1, shape.x2) * k, Math.min(shape.y1, shape.y2) * k,
          Math.abs(shape.x2 - shape.x1) * k, Math.abs(shape.y2 - shape.y1) * k);
        vctx.restore();
        return;
      }
      realPaint(shape);
    };

    var root = el('div.shot-editor', {}, [
      el('div.shot-bar', {}, [toolRow, colorRow, undoBtn, cropBtn, el('span.grow'),
        status, copyBtn, downloadBtn, saveBtn]),
      stage
    ]);

    refreshTools();
    setTimeout(fit, 0);
    window.addEventListener('resize', fit);

    return {
      node: root,
      flatten: flatten,
      destroy: function () { window.removeEventListener('resize', fit); cancelText(); }
    };
  };

  /* --- Saving ---------------------------------------------------------------- */

  /** Store a screenshot: a new one, or over an existing one being re-edited. */
  Shot.save = function (blob, options) {
    options = options || {};
    var thumb = options.thumbnail || '';

    if (options.uid) {
      var key;
      return ML.post('upload/replace-start', { uid: options.uid, mime: 'image/png' })
        .then(function (started) {
          key = started.key || started.upload_key;
          return ML.Export.uploadBlob(blob, key, options.onProgress);
        })
        .then(function () {
          return ML.post('upload/replace-finish', { key: key, mime: 'image/png', duration: 0 });
        })
        .then(function () { return { uid: options.uid }; });
    }

    return ML.post('videos/create', {
      kind: 'image',
      mime: 'image/png',
      title: options.title || 'Screenshot',
      space_id: options.spaceId || 0,
      visibility: 'link'
    }).then(function (created) {
      return ML.Export.uploadBlob(blob, created.upload_key, options.onProgress).then(function () {
        return ML.post('upload/finish', {
          key: created.upload_key,
          duration: 0,
          width: options.width || 0,
          height: options.height || 0,
          thumbnail_data: thumb
        });
      }).then(function () { return created; });
    });
  };

  /** A small JPEG of the picture, for the library grid. */
  Shot.thumbnail = function (canvas) {
    try {
      var out = document.createElement('canvas');
      var ratio = Math.min(1, 640 / canvas.width);
      out.width = Math.max(1, Math.round(canvas.width * ratio));
      out.height = Math.max(1, Math.round(canvas.height * ratio));
      out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/jpeg', 0.72);
    } catch (error) {
      return '';
    }
  };
})(window, document);

/* ==========================================================================
   The screenshot view: whatever was just captured, ready to mark up.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var Views = ML.Views = ML.Views || {};

  Views.shot = function (root, params) {
    params = params || {};
    var editor = null;
    clear(root);

    var head = el('div.page-head', {}, [
      el('div', {}, [
        el('h1', {}, params.uid ? 'Edit screenshot' : 'New screenshot'),
        el('p.muted', {}, 'Arrow, box, pen, text and blur. Crop with the frame tool.')
      ]),
      el('button.btn', { type: 'button', onclick: function () { window.App.go(params.uid ? '/video/' + params.uid : '/'); } }, 'Cancel')
    ]);
    root.appendChild(head);

    var host = el('div.card.pad');
    root.appendChild(host);

    var ready = params.uid
      ? ML.Shot.load(params.src)
      : (ML.Shot.pending ? Promise.resolve(ML.Shot.pending) : Promise.reject(new Error('Nothing was captured. Take a screenshot from the library.')));

    ready.then(function (canvas) {
      ML.Shot.pending = null;
      editor = ML.Shot.editor(canvas, {
        saveLabel: params.uid ? 'Save changes' : 'Save & share',
        name: 'screenshot',
        onSave: function (blob, flat) {
          return ML.Shot.save(blob, {
            uid: params.uid,
            width: flat.width,
            height: flat.height,
            title: params.title || ('Screenshot ' + new Date().toLocaleString()),
            thumbnail: ML.Shot.thumbnail(flat)
          }).then(function (saved) {
            ML.toast('Saved', 'success');
            window.App.go('/video/' + saved.uid + (params.uid ? '' : '?new=1'));
          });
        }
      });
      clear(host);
      host.appendChild(editor.node);
    }).catch(function (error) {
      clear(host);
      host.appendChild(el('p.muted', { text: error.message }));
    });

    return function () { if (editor) { editor.destroy(); } };
  };
})(window, document);
