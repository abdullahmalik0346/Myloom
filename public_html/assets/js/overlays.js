/* ==========================================================================
   MyLoom overlays — shared geometry and rendering for on-video annotations.

   Annotations are stored as normalised rectangles (0-1 of the video frame).
   A <video> letterboxes its content inside its box, so drawing an overlay at
   the right place means computing the *content* rect, not the element rect.
   The same maths is reused by the player, the editor and the burn-in export.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el;

  /**
   * Where the video's picture actually sits inside its element, accounting for
   * `object-fit: contain` letterboxing.
   * Returns { left, top, width, height } in CSS pixels relative to the element.
   */
  function contentRect(video) {
    var boxW = video.clientWidth || video.offsetWidth || 0;
    var boxH = video.clientHeight || video.offsetHeight || 0;
    var vw = video.videoWidth || 16;
    var vh = video.videoHeight || 9;
    if (!boxW || !boxH) { return { left: 0, top: 0, width: 0, height: 0 }; }

    var scale = Math.min(boxW / vw, boxH / vh);
    var width = vw * scale;
    var height = vh * scale;
    return {
      left: (boxW - width) / 2,
      top: (boxH - height) / 2,
      width: width,
      height: height
    };
  }

  /** Is this annotation visible at time `t` (seconds, absolute)? */
  function isActive(annotation, t) {
    return t >= Number(annotation.start_time) && t <= Number(annotation.end_time);
  }

  /**
   * Build the DOM node for one annotation. `rect` is the content rect, used to
   * convert normalised units into pixels.
   */
  function build(annotation, rect, options) {
    options = options || {};
    var px = function (n) { return n + 'px'; };
    var left = rect.left + annotation.x * rect.width;
    var top = rect.top + annotation.y * rect.height;
    var width = Math.max(4, annotation.w * rect.width);
    var height = Math.max(4, annotation.h * rect.height);

    var base = {
      position: 'absolute',
      left: px(Math.round(left)),
      top: px(Math.round(top)),
      width: px(Math.round(width)),
      height: px(Math.round(height)),
      zIndex: String(100 + (annotation.z_index || 1)),
      boxSizing: 'border-box'
    };

    var node;
    switch (annotation.type) {
      case 'blur':
        // backdrop-filter alone is unreliable on a small box — a large radius
        // mostly drags in the surrounding colour instead of smearing the
        // content — so a translucent scrim is layered on top. That combination
        // reliably makes the covered area unreadable. It is still only a
        // player-side effect: the pixels remain in the file until the overlay
        // is burned in, which the editor says plainly.
        var radius = Math.max(4, Math.min(40, annotation.intensity));
        node = el('div.ov.ov-blur', {
          style: Object.assign({}, base, {
            backdropFilter: 'blur(' + radius + 'px)',
            WebkitBackdropFilter: 'blur(' + radius + 'px)',
            borderRadius: '4px',
            background: supportsBackdrop()
              ? 'rgba(28,28,38,' + (0.34 + Math.min(0.4, radius / 100)).toFixed(2) + ')'
              : 'rgba(24,24,32,.98)'
          })
        });
        break;

      case 'rect':
      case 'ellipse':
        node = el('div.ov.ov-shape', {
          style: Object.assign({}, base, {
            border: Math.max(1, annotation.stroke_width * rect.height) + 'px solid ' + annotation.color,
            borderRadius: annotation.type === 'ellipse' ? '50%' : '6px',
            background: annotation.background ? hexToRgba(annotation.background, 0.28) : 'transparent'
          })
        });
        break;

      case 'arrow':
        node = buildArrow(annotation, base, rect);
        break;

      case 'link':
      case 'text':
      default:
        var fontPx = Math.max(9, annotation.font_size * rect.height);
        var style = Object.assign({}, base, {
          color: annotation.color,
          background: annotation.background ? hexToRgba(annotation.background, 0.82) : 'transparent',
          font: '600 ' + Math.round(fontPx) + 'px/1.25 ' +
            '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
          padding: Math.round(fontPx * 0.32) + 'px ' + Math.round(fontPx * 0.5) + 'px',
          borderRadius: Math.round(fontPx * 0.3) + 'px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: annotation.type === 'link' ? 'center' : 'flex-start',
          textAlign: annotation.type === 'link' ? 'center' : 'left',
          overflow: 'hidden',
          wordBreak: 'break-word',
          textShadow: annotation.background ? 'none' : '0 1px 3px rgba(0,0,0,.65)'
        });

        if (annotation.type === 'link' && annotation.url && !options.inert) {
          node = el('a.ov.ov-link', {
            href: annotation.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: annotation.url,
            style: Object.assign(style, {
              textDecoration: 'none',
              cursor: 'pointer',
              pointerEvents: 'auto',
              boxShadow: '0 2px 10px rgba(0,0,0,.35)'
            })
          }, annotation.body || 'Learn more');
        } else {
          node = el('div.ov.ov-text', { style: style }, annotation.body || '');
        }
    }

    node.dataset.annotationId = annotation.id || '';
    return node;
  }

  /** An arrow drawn as inline SVG from the box's top-left to bottom-right. */
  function buildArrow(annotation, base, rect) {
    var w = Math.max(8, annotation.w * rect.width);
    var h = Math.max(8, annotation.h * rect.height);
    var stroke = Math.max(2, annotation.stroke_width * rect.height);
    var head = Math.max(6, stroke * 3.2);
    var id = 'ah' + Math.random().toString(36).slice(2, 8);

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML =
      '<defs><marker id="' + id + '" viewBox="0 0 10 10" refX="8" refY="5" ' +
      'markerWidth="' + (head / stroke) + '" markerHeight="' + (head / stroke) + '" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="' + annotation.color + '"/></marker></defs>' +
      '<line x1="' + (stroke) + '" y1="' + (stroke) + '" x2="' + (w - head) + '" y2="' + (h - head) + '" ' +
      'stroke="' + annotation.color + '" stroke-width="' + stroke + '" stroke-linecap="round" ' +
      'marker-end="url(#' + id + ')"/>';

    var wrap = el('div.ov.ov-arrow', {
      style: Object.assign({}, base, { filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.5))' })
    });
    wrap.appendChild(svg);
    return wrap;
  }

  var backdropSupport = null;
  function supportsBackdrop() {
    if (backdropSupport === null) {
      backdropSupport = !!(window.CSS && CSS.supports &&
        (CSS.supports('backdrop-filter', 'blur(4px)') || CSS.supports('-webkit-backdrop-filter', 'blur(4px)')));
    }
    return backdropSupport;
  }

  function hexToRgba(hex, alpha) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) { return 'rgba(0,0,0,' + alpha + ')'; }
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  /**
   * Attach a live overlay layer to a player.
   *   var layer = ML.Overlays.attach(player, annotations)
   * Redraws on timeupdate, seek and resize; returns { set, refresh, destroy }.
   */
  function attach(player, annotations, options) {
    options = options || {};
    var list = (annotations || []).slice();
    var layer = el('div.overlay-layer', {
      style: {
        position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden'
      }
    });
    // Sit under the controls so the scrub bar stays clickable.
    layer.style.zIndex = '5';
    player.root.insertBefore(layer, player.root.querySelector('.player-controls'));

    var signature = '';

    function refresh() {
      var t = player.absoluteTime();
      var rect = contentRect(player.video);
      var active = list.filter(function (a) { return isActive(a, t); });

      // Only rebuild when the visible set or geometry actually changed.
      var next = active.map(function (a) { return a.id + ':' + a.type; }).join('|') +
        '@' + Math.round(rect.width) + 'x' + Math.round(rect.height);
      if (next === signature) { return; }
      signature = next;

      ML.clear(layer);
      active
        .sort(function (a, b) { return (a.z_index || 0) - (b.z_index || 0); })
        .forEach(function (a) { layer.appendChild(build(a, rect, options)); });
    }

    var onTime = function () { refresh(); };
    player.video.addEventListener('timeupdate', onTime);
    player.video.addEventListener('seeked', onTime);
    player.video.addEventListener('loadedmetadata', function () { signature = ''; refresh(); });

    var onResize = function () { signature = ''; refresh(); };
    window.addEventListener('resize', onResize);
    var observer = null;
    if (window.ResizeObserver) {
      observer = new ResizeObserver(onResize);
      observer.observe(player.root);
    }
    refresh();

    return {
      layer: layer,
      refresh: function () { signature = ''; refresh(); },
      set: function (next) { list = (next || []).slice(); signature = ''; refresh(); },
      destroy: function () {
        player.video.removeEventListener('timeupdate', onTime);
        player.video.removeEventListener('seeked', onTime);
        window.removeEventListener('resize', onResize);
        if (observer) { observer.disconnect(); }
        layer.remove();
      }
    };
  }

  /**
   * A persistent watermark: the workspace logo or a line of text, pinned to a
   * corner for the whole video. Separate from annotations because it is not
   * timed and belongs to the workspace, not the recording.
   */
  function attachWatermark(player, watermark) {
    if (!watermark || watermark.mode === 'none') { return null; }

    var corners = {
      'top-left': { top: '3.5%', left: '3%' },
      'top-right': { top: '3.5%', right: '3%' },
      'bottom-left': { bottom: '13%', left: '3%' },
      'bottom-right': { bottom: '13%', right: '3%' }
    };
    var position = corners[watermark.position] || corners['bottom-right'];

    var content = watermark.mode === 'logo' && watermark.logo
      ? el('img', { src: watermark.logo, alt: '', style: { height: '100%', width: 'auto', display: 'block' } })
      : el('span', {
          text: watermark.text || '',
          style: {
            font: '600 clamp(10px, 1.6vw, 16px)/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
            color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,.7)', whiteSpace: 'nowrap'
          }
        });

    var node = el('div.watermark', {
      style: Object.assign({
        position: 'absolute', zIndex: '8', pointerEvents: 'none',
        opacity: '.72', maxWidth: '28%', height: watermark.mode === 'logo' ? '9%' : 'auto'
      }, position)
    }, content);

    player.root.insertBefore(node, player.root.querySelector('.player-controls'));
    return node;
  }

  ML.Overlays = {
    attachWatermark: attachWatermark,
    attach: attach,
    build: build,
    contentRect: contentRect,
    isActive: isActive,
    hexToRgba: hexToRgba,
    supportsBackdrop: supportsBackdrop
  };
})(window, document);
