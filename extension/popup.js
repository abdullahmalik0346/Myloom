/* Toolbar popup: pick a mode and start, or stop what is already running. */
import { loadSettings, saveSettings } from './config.js';

const app = document.getElementById('app');

const MODES = [
  { key: 'screen', icon: '🖥️', label: 'Screen', hint: 'A whole display or one window' },
  { key: 'tab', icon: '🗔', label: 'Tab', hint: 'The tab you are on, with its audio' },
  { key: 'camera', icon: '🎥', label: 'Camera', hint: 'A talking-head video' }
];

/** Older saved preferences used a combined screen+camera mode. */
function normaliseMode(prefs) {
  if (prefs.mode === 'screen_camera') {
    return { ...prefs, mode: 'screen', camBubble: true };
  }
  if (!['screen', 'tab', 'camera'].includes(prefs.mode)) {
    return { ...prefs, mode: 'screen' };
  }
  return prefs;
}

function el(tag, attrs, children) {
  const parts = String(tag).split(/(?=[.#])/);
  const node = document.createElement(parts.shift() || 'div');
  parts.forEach((p) => { if (p[0] === '.') { node.classList.add(p.slice(1)); } else { node.id = p.slice(1); } });
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === null || v === undefined || v === false) { return; }
    if (k.startsWith('on') && typeof v === 'function') { node.addEventListener(k.slice(2), v); }
    else if (k === 'text') { node.textContent = v; }
    else if (k === 'html') { node.innerHTML = v; }
    else { node.setAttribute(k, v === true ? '' : v); }
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined || c === false) { return; }
    node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  });
  return node;
}

/**
 * Chrome will not show a camera or microphone prompt to the offscreen document
 * the recorder runs in, so a first recording would silently have neither. Find
 * out what is still unasked before starting, and send them somewhere a prompt
 * can actually appear.
 */
async function unaskedPermissions(prefs) {
  const wanted = [];
  if (prefs.mic !== false) { wanted.push('microphone'); }
  if (prefs.mode === 'camera' || (prefs.mode !== 'camera' && prefs.camBubble !== false)) {
    wanted.push('camera');
  }
  const states = await Promise.all(wanted.map((name) => navigator.permissions
    .query({ name })
    .then((result) => result.state)
    .catch(() => 'granted')));   // a browser that cannot say should not block

  return {
    unasked: wanted.filter((_, i) => states[i] === 'prompt'),
    blocked: wanted.filter((_, i) => states[i] === 'denied')
  };
}

const CORNERS = [
  { key: 'tl', glyph: '◤', label: 'Top left' },
  { key: 'tr', glyph: '◥', label: 'Top right' },
  { key: 'bl', glyph: '◣', label: 'Bottom left' },
  { key: 'br', glyph: '◢', label: 'Bottom right' }
];
const SIZES = [{ key: 's', label: 'S' }, { key: 'm', label: 'M' }, { key: 'l', label: 'L' }];

/**
 * Where the camera bubble sits, and how big. Works mid-recording too — the
 * recorder reads the placement on every frame — which is the only way to move
 * it once you have left this tab.
 */
/** The controls report changes in their own words; store them in prefs terms. */
function normalisePatch(patch) {
  const out = {};
  if (patch.corner) { out.bubbleCorner = patch.corner; out.bubbleX = undefined; out.bubbleY = undefined; }
  if (patch.size) { out.bubbleSize = patch.size; }
  if (typeof patch.bubbleX === 'number') { out.bubbleX = patch.bubbleX; out.bubbleY = patch.bubbleY; }
  if (typeof patch.cameraOn === 'boolean') { out.cameraOn = patch.cameraOn; }
  return out;
}

function bubbleControls(prefs, onChange) {
  const corner = prefs.bubbleCorner || 'bl';
  const size = prefs.bubbleSize || 'm';

  const row = (items, current, key) => el('div.pickrow', {}, items.map((item) => el(
    'button.pick' + (item.key === current ? '.on' : ''),
    {
      title: item.label || item.key,
      onclick: async () => {
        const patch = { [key]: item.key };
        await chrome.runtime.sendMessage({ type: 'setBubble', ...patch }).catch(() => {});
        onChange(patch);
      }
    },
    item.glyph || item.label
  )));

  // A miniature of the screen: drag the dot to put the bubble anywhere. There
  // is no preview to drag on — the recorder is invisible — and an overlay on
  // the page would end up inside the recording, so the handle lives here.
  const dot = el('div.padDot');
  const pad = el('div.pad', {}, dot);
  const place = (x, y) => {
    dot.style.left = (x * 100) + '%';
    dot.style.top = (y * 100) + '%';
  };
  place(typeof prefs.bubbleX === 'number' ? prefs.bubbleX : (corner.indexOf('l') >= 0 ? 0.04 : 0.96),
    typeof prefs.bubbleY === 'number' ? prefs.bubbleY : (corner.indexOf('t') >= 0 ? 0.04 : 0.96));

  const dragTo = (event) => {
    const box = pad.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const y = Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
    place(x, y);
    return { x, y };
  };
  let dragging = false;
  pad.addEventListener('pointerdown', (event) => {
    dragging = true;
    pad.setPointerCapture(event.pointerId);
    dragTo(event);
  });
  pad.addEventListener('pointermove', (event) => { if (dragging) { dragTo(event); } });
  const release = async (event) => {
    if (!dragging) { return; }
    dragging = false;
    const at = dragTo(event);
    // Only on release: a message per pointer move would flood the worker.
    await chrome.runtime.sendMessage({ type: 'setBubble', x: at.x, y: at.y }).catch(() => {});
    onChange({ bubbleX: at.x, bubbleY: at.y });
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);

  const cameraOn = prefs.cameraOn !== false;
  const cameraButton = el('button.pick.wide' + (cameraOn ? '' : '.off'), {
    onclick: async () => {
      const next = !(prefs.cameraOn !== false);
      await chrome.runtime.sendMessage({ type: 'setCamera', on: next }).catch(() => {});
      onChange({ cameraOn: next });
    }
  }, cameraOn ? '🎥 Camera on' : '🚫 Camera off');

  return el('div.bubblebox', {}, [
    el('div.picklabel', { text: 'Camera bubble — drag to place it' }),
    pad,
    row(CORNERS, corner, 'corner'),
    row(SIZES, size, 'size'),
    el('div.pickrow', {}, cameraButton)
  ]);
}

function header() {
  return el('div.head', {}, [el('div.mark'), el('span.title', { text: 'MyLoom' })]);
}

/** The last capture failure, if there is one worth showing. */
function errorPanel(stored) {
  if (!stored || !stored.message) { return null; }
  const age = Date.now() - (stored.at || 0);
  if (age > 30 * 60 * 1000) { return null; }   // stale, not worth alarming anyone

  return el('div.errbox', {}, [
    el('div.errtitle', { text: 'Last attempt failed' }),
    el('div.errmsg', { text: stored.message }),
    el('div.errtools', {}, [
      el('button.link', {
        onclick: async () => {
          await navigator.clipboard.writeText(stored.message).catch(() => {});
          ML_toast('Copied');
        }
      }, 'Copy'),
      el('button.link', {
        onclick: async () => {
          await chrome.runtime.sendMessage({ type: 'clearError' });
          render();
        }
      }, 'Dismiss')
    ])
  ]);
}

function ML_toast(text) {
  const note = el('div.toast', { text });
  document.body.appendChild(note);
  setTimeout(() => note.remove(), 1400);
}

async function render() {
  const settings = await loadSettings();
  const stored = await chrome.storage.local.get('lastError');
  const state = await chrome.runtime.sendMessage({ type: 'getState' }).catch(() => ({ status: 'idle' }));
  app.replaceChildren();
  app.appendChild(header());
  const panel = errorPanel(stored.lastError);
  if (panel) { app.appendChild(panel); }

  if (!settings.siteUrl || !settings.token) {
    app.appendChild(el('div.pad', {}, [
      el('p', { text: 'Connect this extension to your MyLoom before recording.' }),
      el('button.btn.primary', { onclick: () => chrome.runtime.openOptionsPage() }, 'Open settings')
    ]));
    return;
  }

  if (state.status === 'recording' || state.status === 'paused' || state.status === 'finishing') {
    return renderRecording(state, normaliseMode(settings.prefs));
  }

  let prefs = normaliseMode(settings.prefs);
  const modeRow = el('div.modes');
  MODES.forEach((mode) => {
    modeRow.appendChild(el('button.mode' + (prefs.mode === mode.key ? '.active' : ''), {
      title: mode.hint,
      onclick: async () => {
        prefs = { ...prefs, mode: mode.key };
        await saveSettings({ prefs });
        render();
      }
    }, [el('span.ico', { text: mode.icon }), mode.label]));
  });

  const toggle = (key, label) => el('label.check', {}, [
    el('input', {
      type: 'checkbox', checked: prefs[key] !== false,
      onchange: async (e) => { prefs = { ...prefs, [key]: e.target.checked }; await saveSettings({ prefs }); }
    }),
    label
  ]);

  const error = el('div.err');
  const startButton = el('button.btn.primary', {
    onclick: async () => {
      startButton.disabled = true;
      startButton.textContent = 'Starting…';
      error.textContent = '';

      const { unasked, blocked } = await unaskedPermissions(prefs);
      if (unasked.length) {
        chrome.tabs.create({ url: chrome.runtime.getURL('permission.html?ask=1') });
        window.close();
        return;
      }
      if (blocked.length) {
        // Blocked on purpose, perhaps. Say what will be missing and carry on.
        error.textContent = 'Recording without your ' + blocked.join(' or ')
          + ' — Chrome has it blocked for this extension.';
      }

      const result = await chrome.runtime.sendMessage({ type: 'start', options: prefs })
        .catch((e) => ({ ok: false, error: e.message }));
      if (result && result.ok) { window.close(); return; }
      startButton.disabled = false;
      startButton.textContent = '⏺ Start recording';
      error.textContent = (result && result.error) || 'Could not start.';
    }
  }, '⏺ Start recording');

  app.appendChild(modeRow);
  app.appendChild(el('div.opts', {}, [
    // Named for what people look for: this is the screen-and-camera mode.
    prefs.mode !== 'camera' ? toggle('camBubble', 'Camera bubble (screen + camera)') : null,
    toggle('mic', 'Microphone'),
    toggle('systemAudio', prefs.mode === 'tab' ? 'Tab audio' : 'System audio')
  ].filter(Boolean)));
  if (prefs.mode !== 'camera' && prefs.camBubble !== false) {
    app.appendChild(bubbleControls(prefs, (patch) => {
      prefs = { ...prefs, ...normalisePatch(patch) };
      render();
    }));
  }
  app.appendChild(el('div.actions', {}, [
    startButton,
    el('button.btn', { onclick: () => chrome.tabs.create({ url: settings.siteUrl }) }, 'Open my library')
  ]));
  app.appendChild(el('div.footlinks', {}, [
    el('button.link', {
      onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') })
    }, 'Camera & mic access')
  ]));
  app.appendChild(error);
}

function renderRecording(state, prefs) {
  const finishing = state.status === 'finishing';
  app.appendChild(el('div.status', {}, [
    finishing ? null : el('span.dot'),
    el('span', { text: finishing ? 'Saving…' : (state.status === 'paused' ? 'Paused' : 'Recording') }),
    el('span.muted.small', { text: formatSeconds(state.seconds || 0) })
  ]));
  if (finishing) { return; }
  if (prefs && prefs.mode !== 'camera' && prefs.camBubble !== false) {
    app.appendChild(bubbleControls(prefs, (patch) => {
      Object.assign(prefs, normalisePatch(patch));
      render();
    }));
  }
  app.appendChild(el('div.actions', {}, [
    el('button.btn.danger', {
      onclick: async () => { await chrome.runtime.sendMessage({ type: 'stop' }); window.close(); }
    }, '⏹ Stop & save'),
    el('button.btn', {
      onclick: async () => { await chrome.runtime.sendMessage({ type: 'pause' }); render(); }
    }, state.status === 'paused' ? '▶ Resume' : '⏸ Pause'),
    el('button.btn', {
      onclick: async () => {
        if (!confirm('Discard this recording?')) { return; }
        await chrome.runtime.sendMessage({ type: 'cancel' });
        render();
      }
    }, 'Discard')
  ]));
}

function formatSeconds(s) {
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

render();
