/* ==========================================================================
   MyLoom annotation editor — add text, links, blur boxes and shapes on top of
   a video, positioned in space and time. Opens as a full-width panel on the
   video page. Nothing is re-encoded: annotations are metadata the player draws.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;

  var PRESET_COLORS = ['#ffffff', '#ff3b3b', '#ffd23f', '#3ddc84', '#4da3ff', '#c084fc', '#16161d'];

  var TOOLS = [
    { type: 'text',    icon: 'T',  label: 'Text',   hint: 'A caption or label on the video' },
    { type: 'link',    icon: '🔗', label: 'Link',   hint: 'A clickable button viewers can open' },
    { type: 'blur',    icon: '🫧', label: 'Blur',   hint: 'Hide a password, email or face' },
    { type: 'rect',    icon: '▭',  label: 'Box',    hint: 'Draw attention to an area' },
    { type: 'ellipse', icon: '◯',  label: 'Circle', hint: 'Circle something on screen' },
    { type: 'arrow',   icon: '↘',  label: 'Arrow',  hint: 'Point at something' }
  ];

  /**
   * open({ video, onSaved })
   * Renders into a modal-sized panel with its own player instance.
   */
  function open(options) {
    var video = options.video;
    var items = (video.annotations || []).map(function (a) { return Object.assign({}, a); });
    var selected = null;
    var player = null;
    var dirty = false;

    var blurWarningNode = null;
    var stageWrap = el('div', { style: { position: 'relative' } });
    var handleLayer = el('div', {
      style: { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '60' }
    });
    var listNode = el('div.col', { style: { gap: '4px' } });
    var propsNode = el('div');
    var timeLabel = el('span.tiny.muted');

    var dialog = ML.modal({
      title: 'Edit overlays — ' + video.title,
      wide: true,
      dismissable: false,
      body: function () {
        return el('div.editor', {}, [
          el('p.hint', {}, 'Overlays play on the share page and in embeds. To bake them into the ' +
            'file itself, use Download → “Burn overlays into the video”.'),
          blurWarning(),
          el('div.editor-tools', {}, TOOLS.map(function (tool) {
            return el('button.btn.sm', {
              type: 'button', title: tool.hint,
              onclick: function () { addItem(tool.type); }
            }, [tool.icon + ' ' + tool.label]);
          })),
          stageWrap,
          el('div.row.between.mt', {}, [
            timeLabel,
            el('span.tiny.muted', {}, 'Drag to move · drag the corner to resize')
          ]),
          el('div.editor-grid.mt', {}, [
            el('div.card', {}, [
              el('div.card-head', {}, el('strong.small', {}, 'Overlays')),
              el('div.card-body', { style: { maxHeight: '260px', overflowY: 'auto' } }, listNode)
            ]),
            el('div.card', {}, [
              el('div.card-head', {}, el('strong.small', {}, 'Properties')),
              el('div.card-body', {}, propsNode)
            ])
          ])
        ]);
      }
    });

    dialog.root.classList.add('editor-modal');
    dialog.setFooter([
      el('span.grow.tiny.muted', { text: items.length + ' overlay(s)' }),
      el('button.btn', {
        type: 'button',
        onclick: function () {
          if (!dirty) { close(); return; }
          ML.confirm({
            title: 'Discard changes?',
            message: 'Your overlay edits will not be saved.',
            danger: true, confirmLabel: 'Discard'
          }).then(function (yes) { if (yes) { close(); } });
        }
      }, 'Cancel'),
      el('button.btn.primary', { type: 'button', onclick: save }, 'Save overlays')
    ]);

    function close() {
      if (player) { player.destroy(); }
      dialog.close();
    }

    /**
     * A blur drawn by the player is cosmetic — the pixels are still in the
     * file. Anyone using this to hide a password needs to know that, and needs
     * the one-click way to make it real.
     */
    function blurWarning() {
      var wrap = el('div.card.pad', {
        style: { borderColor: 'var(--warn)', marginBottom: '12px', display: 'none' }
      }, [
        el('p.small', { style: { margin: '0 0 8px' } }, [
          el('strong', {}, 'Hiding something sensitive? '),
          'A blur here only covers the area in the player — the original pixels stay in the ' +
          'video file. To remove them for good, re-encode the video with the overlays baked in.'
        ]),
        el('button.btn.sm', {
          type: 'button',
          onclick: function () {
            if (dirty) {
              ML.toast('Save your overlays first, then apply them permanently.', 'error');
              return;
            }
            close();
            ML.Export.applyPermanently({
              video: video,
              annotations: items,
              onDone: function () { if (options.onSaved) { options.onSaved([]); } }
            });
          }
        }, 'Apply permanently (re-encode)')
      ]);
      blurWarningNode = wrap;
      return wrap;
    }

    /* --- Player + stage --------------------------------------------------- */

    player = ML.Player(stageWrap, {
      src: video.media_url,
      poster: video.thumbnail,
      fallbackDuration: video.duration,
      trimStart: video.trim_start,
      trimEnd: video.trim_end,
      showCaptions: false,
      onProgress: function () {
        timeLabel.textContent = 'At ' + ML.duration(player.absoluteTime());
        drawHandles();
      },
      onReady: function () { drawHandles(); }
    });
    player.root.appendChild(handleLayer);

    var overlayLayer = ML.Overlays.attach(player, items, { inert: true });

    /* --- Item CRUD -------------------------------------------------------- */

    function addItem(type) {
      var now = player.absoluteTime();
      var duration = video.duration || 30;
      var item = {
        id: 'new-' + Math.random().toString(36).slice(2, 9),
        type: type,
        start_time: Math.round(now * 10) / 10,
        end_time: Math.min(duration, Math.round((now + 4) * 10) / 10),
        x: 0.34, y: 0.42, w: 0.32, h: 0.14,
        body: type === 'link' ? 'Learn more' : (type === 'text' ? 'Your text here' : ''),
        url: '',
        color: type === 'blur' ? '#ffffff' : '#ffd23f',
        background: type === 'text' || type === 'link' ? '#16161d' : '',
        font_size: 0.06,
        stroke_width: 0.008,
        intensity: 14,
        z_index: items.length + 1
      };
      if (type === 'arrow') { item.w = 0.18; item.h = 0.18; item.color = '#ff3b3b'; }
      if (type === 'blur') { item.w = 0.22; item.h = 0.1; }

      items.push(item);
      selected = item;
      dirty = true;
      sync();
    }

    function removeItem(item) {
      items = items.filter(function (i) { return i !== item; });
      if (selected === item) { selected = null; }
      dirty = true;
      sync();
    }

    function sync() {
      overlayLayer.set(items);
      renderList();
      renderProps();
      drawHandles();
      var counter = dialog.root.querySelector('.modal-foot .grow');
      if (counter) { counter.textContent = items.length + ' overlay(s)'; }
      if (blurWarningNode) {
        var hasBlur = items.some(function (i) { return i.type === 'blur'; });
        blurWarningNode.style.display = hasBlur ? '' : 'none';
      }
    }

    function select(item) {
      selected = item;
      // Jump to where it is visible so the user can see what they picked.
      if (player.absoluteTime() < item.start_time || player.absoluteTime() > item.end_time) {
        player.seekAbsolute(item.start_time + 0.05);
      }
      sync();
    }

    /* --- Selection handles ------------------------------------------------ */

    // While a drag is in flight the handle box must not be rebuilt — replacing
    // the node would drop the pointer capture and the drag would stop dead
    // after one move event. So position it in place and only redraw on release.
    var dragging = false;
    var handleBox = null;

    function drawHandles() {
      if (dragging) { positionHandles(); return; }
      clear(handleLayer);
      handleBox = null;
      if (!selected) { return; }
      if (!ML.Overlays.isActive(selected, player.absoluteTime())) { return; }

      handleBox = el('div', {
        style: {
          position: 'absolute',
          border: '1px dashed rgba(255,255,255,.95)',
          boxShadow: '0 0 0 1px rgba(0,0,0,.5)',
          cursor: 'move',
          pointerEvents: 'auto',
          touchAction: 'none'
        }
      });
      var grip = el('div', {
        style: {
          position: 'absolute', right: '-7px', bottom: '-7px', width: '14px', height: '14px',
          background: '#fff', border: '1px solid #16161d', borderRadius: '3px',
          cursor: 'nwse-resize', pointerEvents: 'auto', touchAction: 'none'
        }
      });
      handleBox.appendChild(grip);
      handleLayer.appendChild(handleBox);
      positionHandles();

      dragify(handleBox, 'move');
      dragify(grip, 'resize');
    }

    function positionHandles() {
      if (!handleBox || !selected) { return; }
      var rect = ML.Overlays.contentRect(player.video);
      handleBox.style.left = (rect.left + selected.x * rect.width) + 'px';
      handleBox.style.top = (rect.top + selected.y * rect.height) + 'px';
      handleBox.style.width = (selected.w * rect.width) + 'px';
      handleBox.style.height = (selected.h * rect.height) + 'px';
    }

    function dragify(node, mode) {
      node.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (!selected) { return; }

        var rect = ML.Overlays.contentRect(player.video);
        if (!rect.width || !rect.height) { return; }

        dragging = true;
        node.setPointerCapture(event.pointerId);
        var startX = event.clientX, startY = event.clientY;
        var origin = { x: selected.x, y: selected.y, w: selected.w, h: selected.h };

        var onMove = function (moveEvent) {
          var dx = (moveEvent.clientX - startX) / rect.width;
          var dy = (moveEvent.clientY - startY) / rect.height;
          if (mode === 'move') {
            selected.x = Math.max(-0.2, Math.min(1.1, origin.x + dx));
            selected.y = Math.max(-0.2, Math.min(1.1, origin.y + dy));
          } else {
            selected.w = Math.max(0.03, Math.min(1.4, origin.w + dx));
            selected.h = Math.max(0.03, Math.min(1.4, origin.h + dy));
          }
          dirty = true;
          overlayLayer.set(items);
          positionHandles();
        };
        var onUp = function (upEvent) {
          dragging = false;
          node.removeEventListener('pointermove', onMove);
          node.removeEventListener('pointerup', onUp);
          node.removeEventListener('pointercancel', onUp);
          try { node.releasePointerCapture(upEvent.pointerId); } catch (e) { /* ignore */ }
          renderProps();
          drawHandles();
        };
        node.addEventListener('pointermove', onMove);
        node.addEventListener('pointerup', onUp);
        node.addEventListener('pointercancel', onUp);
      });
    }

    /* --- List ------------------------------------------------------------- */

    function renderList() {
      clear(listNode);
      if (!items.length) {
        listNode.appendChild(el('p.small.muted', {},
          'No overlays yet. Pick a tool above to add one at the current time.'));
        return;
      }
      items.forEach(function (item) {
        var tool = TOOLS.filter(function (t) { return t.type === item.type; })[0] || TOOLS[0];
        listNode.appendChild(el('div.ov-row' + (selected === item ? '.active' : ''), {
          onclick: function () { select(item); }
        }, [
          el('span', { text: tool.icon }),
          el('span.grow.truncate', {
            text: item.body || tool.label
          }),
          el('span.tiny.muted.nowrap', {
            text: ML.duration(item.start_time) + '–' + ML.duration(item.end_time)
          }),
          el('button.btn.sm.ghost', {
            type: 'button', title: 'Delete',
            onclick: function (event) { event.stopPropagation(); removeItem(item); }
          }, '✕')
        ]));
      });
    }

    /* --- Properties ------------------------------------------------------- */

    function renderProps() {
      clear(propsNode);
      if (!selected) {
        propsNode.appendChild(el('p.small.muted', {}, 'Select an overlay to edit it.'));
        return;
      }
      var item = selected;
      var fields = [];

      var change = function () { dirty = true; overlayLayer.set(items); renderList(); drawHandles(); };

      if (item.type === 'text' || item.type === 'link') {
        fields.push(field('Text', el('input', {
          type: 'text', value: item.body || '',
          oninput: function (e) { item.body = e.target.value; change(); }
        })));
      }
      if (item.type === 'link') {
        fields.push(field('Link URL', el('input', {
          type: 'url', value: item.url || '', placeholder: 'https://example.com',
          oninput: function (e) { item.url = e.target.value; change(); }
        }), 'Must start with http:// or https://'));
      }
      if (item.type === 'text' || item.type === 'link') {
        fields.push(field('Text size', el('input', {
          type: 'range', min: '2', max: '18', step: '0.5', value: String(item.font_size * 100),
          oninput: function (e) { item.font_size = Number(e.target.value) / 100; change(); }
        })));
      }
      if (item.type === 'blur') {
        fields.push(field('Blur strength', el('input', {
          type: 'range', min: '4', max: '40', step: '1', value: String(item.intensity),
          oninput: function (e) { item.intensity = Number(e.target.value); change(); }
        })));
      }
      if (item.type === 'rect' || item.type === 'ellipse' || item.type === 'arrow') {
        fields.push(field('Line thickness', el('input', {
          type: 'range', min: '2', max: '30', step: '1', value: String(item.stroke_width * 1000),
          oninput: function (e) { item.stroke_width = Number(e.target.value) / 1000; change(); }
        })));
      }
      if (item.type !== 'blur') {
        fields.push(field(item.type === 'text' || item.type === 'link' ? 'Text colour' : 'Colour',
          swatches(item.color, function (color) { item.color = color; change(); })));
      }
      if (item.type !== 'blur' && item.type !== 'arrow') {
        fields.push(field('Background', el('div', {}, [
          swatches(item.background || '', function (color) { item.background = color; change(); }, true)
        ])));
      }

      fields.push(el('div.row.gap-lg', {}, [
        el('label.field.grow', {}, [
          el('span', {}, 'Starts at (s)'),
          el('div.row', {}, [
            el('input', {
              type: 'number', step: '0.1', min: '0', value: String(item.start_time),
              oninput: function (e) { item.start_time = Number(e.target.value) || 0; change(); }
            }),
            el('button.btn.sm', {
              type: 'button', title: 'Use the current time',
              onclick: function () {
                item.start_time = Math.round(player.absoluteTime() * 10) / 10;
                if (item.end_time <= item.start_time) { item.end_time = item.start_time + 3; }
                change(); renderProps();
              }
            }, '⏱')
          ])
        ]),
        el('label.field.grow', {}, [
          el('span', {}, 'Ends at (s)'),
          el('div.row', {}, [
            el('input', {
              type: 'number', step: '0.1', min: '0', value: String(item.end_time),
              oninput: function (e) { item.end_time = Number(e.target.value) || 0; change(); }
            }),
            el('button.btn.sm', {
              type: 'button', title: 'Use the current time',
              onclick: function () {
                item.end_time = Math.round(player.absoluteTime() * 10) / 10;
                change(); renderProps();
              }
            }, '⏱')
          ])
        ])
      ]));

      fields.push(el('div.row.mt', {}, [
        el('button.btn.sm', {
          type: 'button',
          onclick: function () {
            item.x = 0.05; item.y = 0.05; item.w = 0.9; item.h = 0.9; change();
          }
        }, 'Fill frame'),
        el('button.btn.sm', {
          type: 'button',
          onclick: function () {
            var copy = Object.assign({}, item, {
              id: 'new-' + Math.random().toString(36).slice(2, 9),
              y: Math.min(0.8, item.y + 0.12),
              z_index: items.length + 1
            });
            items.push(copy);
            selected = copy;
            dirty = true;
            sync();
          }
        }, 'Duplicate'),
        el('button.btn.sm.danger', { type: 'button', onclick: function () { removeItem(item); } }, 'Delete')
      ]));

      ML.append(propsNode, fields);
    }

    function field(label, control, hint) {
      return el('label.field', {}, [
        el('span', { text: label }),
        control,
        hint ? el('div.hint', { text: hint }) : null
      ]);
    }

    function swatches(current, onPick, allowNone) {
      var row = el('div.draw-palette', {});
      if (allowNone) {
        row.appendChild(el('i.swatch' + (!current ? '.active' : ''), {
          title: 'None',
          style: { background: 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50%/8px 8px' },
          onclick: function () {
            onPick('');
            ML.$$('.swatch', row).forEach(function (s) { s.classList.remove('active'); });
            this.classList.add('active');
          }
        }));
      }
      PRESET_COLORS.forEach(function (color) {
        row.appendChild(el('i.swatch' + (current === color ? '.active' : ''), {
          style: { background: color }, title: color,
          onclick: function () {
            onPick(color);
            ML.$$('.swatch', row).forEach(function (s) { s.classList.remove('active'); });
            this.classList.add('active');
          }
        }));
      });
      return row;
    }

    /* --- Save ------------------------------------------------------------- */

    function save() {
      var payload = items.map(function (item, index) {
        return {
          type: item.type,
          start_time: item.start_time,
          end_time: item.end_time,
          x: item.x, y: item.y, w: item.w, h: item.h,
          body: item.body || '',
          url: item.url || '',
          color: item.color || '#ffffff',
          background: item.background || '',
          font_size: item.font_size,
          stroke_width: item.stroke_width,
          intensity: item.intensity,
          z_index: index + 1
        };
      });
      ML.post('annotations/save', { uid: video.uid, annotations: payload })
        .then(function (response) {
          ML.toast('Overlays saved', 'success');
          dirty = false;
          if (options.onSaved) { options.onSaved(response.annotations || []); }
          close();
        })
        .catch(ML.toastError);
    }

    sync();
    return dialog;
  }

  ML.AnnotationEditor = { open: open, TOOLS: TOOLS };
})(window, document);
