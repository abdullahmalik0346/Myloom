/* Toolbar popup: pick a mode and start, or stop what is already running. */
import { loadSettings, saveSettings } from './config.js';

const app = document.getElementById('app');

const MODES = [
  { key: 'screen_camera', icon: '🖥️', label: 'Screen + cam' },
  { key: 'screen', icon: '🖵', label: 'Screen' },
  { key: 'camera', icon: '🎥', label: 'Camera' }
];

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
    return renderRecording(state);
  }

  let prefs = settings.prefs;
  const modeRow = el('div.modes');
  MODES.forEach((mode) => {
    modeRow.appendChild(el('button.mode' + (prefs.mode === mode.key ? '.active' : ''), {
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
    toggle('mic', 'Microphone'),
    toggle('systemAudio', 'Tab / system audio')
  ]));
  app.appendChild(el('div.actions', {}, [
    startButton,
    el('button.btn', { onclick: () => chrome.tabs.create({ url: settings.siteUrl }) }, 'Open my library')
  ]));
  app.appendChild(error);
}

function renderRecording(state) {
  const finishing = state.status === 'finishing';
  app.appendChild(el('div.status', {}, [
    finishing ? null : el('span.dot'),
    el('span', { text: finishing ? 'Saving…' : (state.status === 'paused' ? 'Paused' : 'Recording') }),
    el('span.muted.small', { text: formatSeconds(state.seconds || 0) })
  ]));
  if (finishing) { return; }
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
