/* ==========================================================================
   MyLoom core — API client, DOM helpers, toasts, modals and formatting.
   Loaded on every page. Exposes the global `ML`.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var boot = window.MYLOOM || {};
  var csrf = boot.csrf || '';

  /* --- DOM helpers -------------------------------------------------------- */

  function $(selector, scope) { return (scope || document).querySelector(selector); }
  function $$(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  /** Create an element: el('div.card', {onclick: fn}, [children|string]) */
  function el(spec, attrs, children) {
    var parts = String(spec).split(/(?=[.#])/);
    var node = document.createElement(parts.shift() || 'div');
    parts.forEach(function (part) {
      if (part[0] === '.') { node.classList.add(part.slice(1)); }
      else if (part[0] === '#') { node.id = part.slice(1); }
    });
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) { return; }
        if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'html') {
          node.innerHTML = value;
        } else if (key === 'text') {
          node.textContent = value;
        } else if (key === 'style' && typeof value === 'object') {
          Object.assign(node.style, value);
        } else if (key === 'dataset') {
          Object.assign(node.dataset, value);
        } else if (key in node && key !== 'list' && typeof value !== 'string') {
          node[key] = value;
        } else {
          node.setAttribute(key, value === true ? '' : value);
        }
      });
    }
    append(node, children);
    return node;
  }

  function append(parent, children) {
    if (children === null || children === undefined || children === false) { return parent; }
    if (Array.isArray(children)) {
      children.forEach(function (child) { append(parent, child); });
      return parent;
    }
    parent.appendChild(children.nodeType ? children : document.createTextNode(String(children)));
    return parent;
  }

  function clear(node) { while (node && node.firstChild) { node.removeChild(node.firstChild); } return node; }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* --- API client --------------------------------------------------------- */

  function apiUrl(route) {
    var base = boot.apiUrl || 'api.php';
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'r=' + encodeURIComponent(route);
  }

  /** GET with query params. */
  function get(route, params) {
    var url = apiUrl(route);
    if (params) {
      Object.keys(params).forEach(function (key) {
        if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
          url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
        }
      });
    }
    return request(url, { method: 'GET' });
  }

  /** POST JSON. */
  function post(route, body) {
    return request(apiUrl(route), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body || {})
    });
  }

  /** POST raw bytes (upload chunks). */
  function postRaw(route, params, blob) {
    var url = apiUrl(route);
    Object.keys(params || {}).forEach(function (key) {
      url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    });
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
      body: blob
    });
  }

  /** POST multipart (file import), with optional progress callback. */
  function postForm(route, formData, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl(route));
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = function (event) {
          if (event.lengthComputable) { onProgress(event.loaded / event.total); }
        };
      }
      xhr.onload = function () {
        var data;
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        if (!data) { reject(new Error('The server returned an unexpected response.')); return; }
        if (data.ok === false) { reject(apiError(data, xhr.status)); return; }
        resolve(data);
      };
      xhr.onerror = function () { reject(new Error('Network error during upload.')); };
      xhr.send(formData);
    });
  }

  function apiError(data, status) {
    var error = new Error((data && data.error) || 'Request failed.');
    error.status = status;
    error.data = data;
    return error;
  }

  function request(url, options) {
    options = options || {};
    options.credentials = 'same-origin';
    return fetch(url, options).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        if (!data) {
          throw new Error('Unexpected server response (HTTP ' + response.status + '). ' +
            'Check _storage/logs/php-error.log.');
        }
        if (data.csrf) { csrf = data.csrf; }
        if (data.ok === false && data.gate === undefined) {
          throw apiError(data, response.status);
        }
        return data;
      });
    });
  }

  function setCsrf(token) { if (token) { csrf = token; } }

  /* --- Toasts ------------------------------------------------------------- */

  function toast(message, kind, ms) {
    var host = $('#toasts');
    if (!host) {
      host = el('div#toasts.toasts', { 'aria-live': 'polite' });
      document.body.appendChild(host);
    }
    var node = el('div.toast' + (kind ? '.' + kind : ''), { text: message });
    host.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .25s, transform .25s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(function () { node.remove(); }, 260);
    }, ms || (kind === 'error' ? 5200 : 3000));
    return node;
  }

  function toastError(error) {
    toast(error && error.message ? error.message : String(error), 'error');
  }

  /* --- Modals ------------------------------------------------------------- */

  /**
   * modal({title, body, footer, wide, onClose}) -> {close, root, body}
   * `body` and `footer` may be nodes, arrays or builder functions receiving the API.
   */
  function modal(options) {
    options = options || {};
    var root = $('#modal-root') || document.body;
    var api = {};
    var bodyNode = el('div.modal-body');
    var footNode = null;

    var box = el('div.modal' + (options.wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' }, [
      el('div.modal-head', {}, [
        el('h2', { text: options.title || '' }),
        el('button.close-x', { type: 'button', 'aria-label': 'Close', onclick: function () { api.close(); } }, '×')
      ]),
      bodyNode
    ]);

    var backdrop = el('div.modal-backdrop', {
      onclick: function (event) { if (event.target === backdrop && options.dismissable !== false) { api.close(); } }
    }, box);

    api.root = box;
    api.body = bodyNode;
    api.close = function () {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (options.onClose) { options.onClose(); }
    };
    api.setFooter = function (children) {
      if (!footNode) { footNode = el('div.modal-foot'); box.appendChild(footNode); }
      clear(footNode);
      append(footNode, children);
    };

    append(bodyNode, typeof options.body === 'function' ? options.body(api) : options.body);
    if (options.footer) {
      api.setFooter(typeof options.footer === 'function' ? options.footer(api) : options.footer);
    }

    function onKey(event) {
      if (event.key === 'Escape' && options.dismissable !== false) { api.close(); }
    }
    document.addEventListener('keydown', onKey);
    root.appendChild(backdrop);

    var focusTarget = box.querySelector('input, textarea, select, button.primary');
    if (focusTarget) { setTimeout(function () { focusTarget.focus(); }, 40); }
    return api;
  }

  function confirmDialog(options) {
    return new Promise(function (resolve) {
      var settled = false;
      var dialog = modal({
        title: options.title || 'Are you sure?',
        body: el('p', { text: options.message || '' }),
        onClose: function () { if (!settled) { resolve(false); } },
        footer: function (api) {
          return [
            el('button.btn', { type: 'button', onclick: function () { settled = true; api.close(); resolve(false); } },
              options.cancelLabel || 'Cancel'),
            el('button.btn.' + (options.danger ? 'danger' : 'primary'), {
              type: 'button',
              onclick: function () { settled = true; api.close(); resolve(true); }
            }, options.confirmLabel || 'Confirm')
          ];
        }
      });
      return dialog;
    });
  }

  /* --- Formatting --------------------------------------------------------- */

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function duration(seconds) {
    seconds = Math.max(0, Math.round(Number(seconds) || 0));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  /**
   * Parse a timecode into seconds. Accepts "90", "1:30", "1:30.5",
   * "01:02:03" and "1m30s". Returns null when it cannot be read.
   */
  function parseTime(input) {
    if (typeof input === 'number') { return isFinite(input) ? Math.max(0, input) : null; }
    var text = String(input == null ? '' : input).trim().toLowerCase();
    if (text === '') { return null; }

    var loose = text.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:([\d.]+)\s*s)?$/);
    if (loose && (loose[1] || loose[2] || loose[3])) {
      return Math.max(0, (Number(loose[1] || 0) * 3600) + (Number(loose[2] || 0) * 60) + Number(loose[3] || 0));
    }

    var parts = text.split(':');
    if (parts.length > 3 || parts.some(function (p) { return p !== '' && !/^[\d.]+$/.test(p); })) {
      return null;
    }
    var seconds = 0;
    for (var i = 0; i < parts.length; i++) {
      var value = Number(parts[i] || 0);
      if (!isFinite(value)) { return null; }
      seconds = seconds * 60 + value;
    }
    return Math.max(0, seconds);
  }

  /** Seconds as m:ss / h:mm:ss, keeping tenths when they matter. */
  function timecode(seconds, withTenths) {
    seconds = Math.max(0, Number(seconds) || 0);
    var whole = Math.floor(seconds);
    var tenth = Math.round((seconds - whole) * 10);
    if (tenth === 10) { whole += 1; tenth = 0; }
    var base = duration(whole);
    return withTenths && tenth > 0 ? base + '.' + tenth : base;
  }

  function bytes(value) {
    value = Number(value) || 0;
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return (value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)) + ' ' + units[i];
  }

  /** Parse a UTC "YYYY-MM-DD HH:MM:SS" timestamp from the API. */
  function parseDate(value) {
    if (!value) { return null; }
    if (value instanceof Date) { return value; }
    var parsed = new Date(String(value).replace(' ', 'T') + 'Z');
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function timeAgo(value) {
    var date = parseDate(value);
    if (!date) { return ''; }
    var diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 45) { return 'just now'; }
    if (diff < 90) { return 'a minute ago'; }
    var table = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2592000, 'month'], [31536000, 'year']];
    for (var i = table.length - 1; i >= 0; i--) {
      var unitSeconds = table[i][0];
      if (diff >= unitSeconds * (i === 0 ? 1 : 1)) {
        var n = Math.floor(diff / unitSeconds);
        if (n >= 1) { return n + ' ' + table[i][1] + (n > 1 ? 's' : '') + ' ago'; }
      }
    }
    return 'just now';
  }

  function dateLabel(value) {
    var date = parseDate(value);
    if (!date) { return ''; }
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function dateTimeLabel(value) {
    var date = parseDate(value);
    if (!date) { return ''; }
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (part) { return part[0] || ''; }).join('').toUpperCase() || '?';
  }

  /** Avatar node that falls back to initials. */
  function avatar(person, size) {
    var cls = 'div.avatar' + (size ? '.' + size : '');
    if (person && person.avatar) {
      return el('img' + cls.slice(3), { src: person.avatar, alt: '', className: 'avatar' + (size ? ' ' + size : '') });
    }
    return el(cls, { title: (person && person.name) || '' }, initials(person && person.name));
  }

  /* --- Clipboard ---------------------------------------------------------- */

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text)
        .then(function () { toast('Copied to clipboard', 'success'); return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var area = el('textarea', { value: text, style: { position: 'fixed', opacity: '0', top: '0' } });
    document.body.appendChild(area);
    area.select();
    var done = false;
    try { done = document.execCommand('copy'); } catch (e) { done = false; }
    area.remove();
    toast(done ? 'Copied to clipboard' : 'Press Ctrl/Cmd+C to copy', done ? 'success' : '');
    return done;
  }

  /** A read-only input plus Copy button. */
  function copyField(value, label) {
    var input = el('input', { type: 'text', value: value, readonly: true, onclick: function () { input.select(); } });
    return el('div.copy-field', {}, [
      input,
      el('button.btn', { type: 'button', onclick: function () { copy(value); } }, label || 'Copy')
    ]);
  }

  /* --- Misc --------------------------------------------------------------- */

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait || 250);
    };
  }

  function storage(key, value) {
    try {
      if (value === undefined) {
        var raw = localStorage.getItem('myloom.' + key);
        return raw === null ? null : JSON.parse(raw);
      }
      localStorage.setItem('myloom.' + key, JSON.stringify(value));
      return value;
    } catch (e) { return null; }
  }

  function loading(node, message) {
    clear(node);
    append(node, el('div.empty-state', {}, [
      el('div.boot-logo', { style: { margin: '0 auto 12px' } }),
      el('p', { text: message || 'Loading…' })
    ]));
  }

  function emptyState(icon, title, message, action) {
    return el('div.empty-state', {}, [
      el('div.empty-icon', { text: icon }),
      el('h2', { text: title }),
      message ? el('p', { text: message }) : null,
      action || null
    ]);
  }

  /** Browser capability probe used by the recorder screen. */
  function capabilities() {
    var media = navigator.mediaDevices || {};
    return {
      secure: window.isSecureContext,
      displayCapture: typeof media.getDisplayMedia === 'function',
      userMedia: typeof media.getUserMedia === 'function',
      recorder: typeof window.MediaRecorder === 'function',
      speech: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
      pip: document.pictureInPictureEnabled === true
    };
  }

  window.ML = {
    boot: boot, $: $, $$: $$, el: el, append: append, clear: clear, escapeHtml: escapeHtml,
    get: get, post: post, postRaw: postRaw, postForm: postForm, setCsrf: setCsrf, apiUrl: apiUrl,
    toast: toast, toastError: toastError, modal: modal, confirm: confirmDialog,
    duration: duration, bytes: bytes, timeAgo: timeAgo, dateLabel: dateLabel,
    parseTime: parseTime, timecode: timecode,
    dateTimeLabel: dateTimeLabel, parseDate: parseDate, initials: initials, avatar: avatar,
    copy: copy, copyField: copyField, debounce: debounce, storage: storage,
    loading: loading, emptyState: emptyState, capabilities: capabilities
  };
})(window, document);
