/* Shared helpers for talking to a MyLoom install. Loaded by the popup,
   the options page and the offscreen document. */

/** Read the saved site URL and API token. */
export async function loadSettings() {
  const stored = await chrome.storage.local.get(['siteUrl', 'token', 'prefs']);
  return {
    siteUrl: (stored.siteUrl || '').replace(/\/+$/, ''),
    token: stored.token || '',
    prefs: Object.assign(
      { mode: 'screen', camBubble: true, bubbleCorner: 'bl', bubbleSize: 'm',
        mic: true, systemAudio: true, countdown: true },
      stored.prefs || {}
    )
  };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

/** Build an API URL for a route, e.g. api('videos/create'). */
export function apiUrl(siteUrl, route) {
  return siteUrl.replace(/\/+$/, '') + '/api.php?r=' + encodeURIComponent(route);
}

/** JSON request against the MyLoom API using the stored token. */
export async function api(siteUrl, token, route, body, method) {
  const response = await fetch(apiUrl(siteUrl, route), {
    method: method || (body ? 'POST' : 'GET'),
    headers: Object.assign(
      { Authorization: 'Bearer ' + token },
      body ? { 'Content-Type': 'application/json' } : {}
    ),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!data) {
    throw new Error('Unexpected response from ' + siteUrl + ' (HTTP ' + response.status + ')');
  }
  if (data.ok === false) { throw new Error(data.error || 'Request failed'); }
  return data;
}

/** Upload one raw chunk of recorded video. */
export async function uploadChunk(siteUrl, token, key, index, blob) {
  const url = apiUrl(siteUrl, 'upload/chunk') +
    '&key=' + encodeURIComponent(key) + '&index=' + index;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
    body: blob
  });
  const data = await response.json().catch(() => null);
  if (!data || data.ok === false) {
    throw new Error((data && data.error) || 'Chunk upload failed (HTTP ' + response.status + ')');
  }
  return data;
}

/** Confirm a site URL and token actually work; returns the whoami payload. */
export async function verify(siteUrl, token) {
  if (!/^https?:\/\//i.test(siteUrl)) {
    throw new Error('The address must start with http:// or https://');
  }
  if (!token) { throw new Error('Paste the API token from MyLoom → Settings → Profile.'); }
  return api(siteUrl, token, 'tokens/whoami');
}
