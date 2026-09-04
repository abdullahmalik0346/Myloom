/* ==========================================================================
   MyLoom extension — camera and microphone consent.

   The recorder lives in an offscreen document, and Chrome will not show a
   permission prompt there: getUserMedia comes straight back with
   "NotAllowedError: Permission dismissed", so a recording would quietly have no
   microphone and no camera bubble. A prompt can be shown on a page like this
   one, and the grant it produces belongs to the whole extension — the offscreen
   document included.
   ========================================================================== */

const statusNode = document.getElementById('status');
const doneHint = document.getElementById('done-hint');

function setStatus(message, kind) {
  statusNode.textContent = message || '';
  statusNode.className = 'status' + (kind ? ' ' + kind : '');
}

/** Chrome's own word for where a permission stands, or null if it cannot say. */
async function permissionState(name) {
  try {
    const result = await navigator.permissions.query({ name });
    return result.state;
  } catch (error) {
    return null;
  }
}

async function hasDevice(kind) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === kind);
  } catch (error) {
    return true;   // cannot tell; assume there is one rather than discourage
  }
}

const LABELS = {
  granted: ['Allowed', 'ok'],
  denied: ['Blocked', 'bad'],
  prompt: ['Not asked yet', ''],
  missing: ['No device found', '']
};

async function refresh() {
  const [mic, cam] = await Promise.all([permissionState('microphone'), permissionState('camera')]);
  const [hasMic, hasCam] = await Promise.all([hasDevice('audioinput'), hasDevice('videoinput')]);

  const paint = (id, state, present) => {
    const node = document.getElementById(id);
    const key = state === 'granted' ? 'granted' : (!present ? 'missing' : (state || 'prompt'));
    const [text, kind] = LABELS[key] || LABELS.prompt;
    node.textContent = text;
    node.className = 'perm-state' + (kind ? ' ' + kind : '');
  };
  paint('state-mic', mic, hasMic);
  paint('state-cam', cam, hasCam);

  const ready = mic === 'granted' && (cam === 'granted' || !hasCam);
  doneHint.hidden = !ready;
  return { mic, cam, hasMic, hasCam };
}

/**
 * Ask for what is wanted. Chrome shows one prompt for a combined request, so
 * try that first; if it fails, ask separately, because a missing camera should
 * not cost you the microphone as well.
 */
async function ask(wantCamera) {
  setStatus('Waiting for your answer…');
  const stop = (stream) => stream.getTracks().forEach((track) => track.stop());

  if (wantCamera) {
    try {
      stop(await navigator.mediaDevices.getUserMedia({ audio: true, video: true }));
      setStatus('Thank you — both are allowed.', 'ok');
      await refresh();
      return;
    } catch (error) { /* fall through and try them one at a time */ }
  }

  const results = [];
  for (const [name, constraints] of [['Microphone', { audio: true }], ['Camera', { video: true }]]) {
    if (name === 'Camera' && !wantCamera) { continue; }
    try {
      stop(await navigator.mediaDevices.getUserMedia(constraints));
      results.push(name + ': allowed');
    } catch (error) {
      results.push(name + ': ' + describe(error));
    }
  }
  const state = await refresh();
  const good = state.mic === 'granted' && (!wantCamera || state.cam === 'granted');
  setStatus(results.join(' · '), good ? 'ok' : 'bad');
}

function describe(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError') { return 'you said no, or Chrome blocked it'; }
  if (name === 'NotFoundError') { return 'no device of that kind'; }
  if (name === 'NotReadableError') { return 'another program is using it'; }
  return (error && error.message) || 'unavailable';
}

document.getElementById('ask').addEventListener('click', () => ask(true));
document.getElementById('ask-mic').addEventListener('click', () => ask(false));

refresh().then((state) => {
  // Arriving here from the popup means something is missing; ask straight away
  // so the prompt is the first thing seen, not a second click.
  const params = new URLSearchParams(location.search);
  if (params.get('ask') === '1' && (state.mic === 'prompt' || state.cam === 'prompt')) {
    ask(state.cam === 'prompt' && state.hasCam);
  }
});
