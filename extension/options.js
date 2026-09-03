/* Options page: store the MyLoom address and API token, and prove they work. */
import { loadSettings, saveSettings, verify } from './config.js';

const siteInput = document.getElementById('site');
const tokenInput = document.getElementById('token');
const status = document.getElementById('status');

function setStatus(message, kind) {
  status.textContent = message;
  status.className = 'status' + (kind ? ' ' + kind : '');
}

(async function init() {
  const settings = await loadSettings();
  siteInput.value = settings.siteUrl;
  if (settings.token) {
    tokenInput.value = settings.token;
    setStatus('Connected. Save again to re-test.', 'ok');
  }
})();

document.getElementById('open-site').addEventListener('click', async (event) => {
  event.preventDefault();
  const url = siteInput.value.trim() || (await loadSettings()).siteUrl;
  if (url) { chrome.tabs.create({ url: url.replace(/\/+$/, '') + '/settings/profile' }); }
  else { setStatus('Enter your MyLoom address first.', 'bad'); }
});

document.getElementById('save').addEventListener('click', async (event) => {
  const button = event.target;
  const siteUrl = siteInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();

  button.disabled = true;
  setStatus('Testing…');
  try {
    const info = await verify(siteUrl, token);
    await saveSettings({ siteUrl, token });
    setStatus('Connected as ' + info.user.name +
      (info.workspace ? ' · ' + info.workspace.name : '') + '. You can record now.', 'ok');
  } catch (error) {
    setStatus(error.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('forget').addEventListener('click', async () => {
  await chrome.storage.local.remove(['siteUrl', 'token']);
  siteInput.value = '';
  tokenInput.value = '';
  setStatus('Disconnected.', '');
});

/* --- Diagnostics ---------------------------------------------------------- */

const diagnoseButton = document.getElementById('diagnose');
const report = document.getElementById('report');
const copyButton = document.getElementById('copy-report');

diagnoseButton.addEventListener('click', async () => {
  diagnoseButton.disabled = true;
  diagnoseButton.textContent = 'Checking…';
  report.hidden = false;
  report.textContent = 'Running…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'diagnose' });
    report.textContent = (result && result.report) || 'No report came back.';
    copyButton.hidden = false;
  } catch (error) {
    report.textContent = 'Diagnostics failed: ' + error.message +
      '\n\nThe extension service worker may have stopped. Reload the extension on ' +
      'chrome://extensions and try again.';
  } finally {
    diagnoseButton.disabled = false;
    diagnoseButton.textContent = 'Run diagnostics';
  }
});

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(report.textContent).catch(() => {});
  copyButton.textContent = 'Copied';
  setTimeout(() => { copyButton.textContent = 'Copy report'; }, 1500);
});
