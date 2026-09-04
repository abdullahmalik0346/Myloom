/* Floating control bar shown on the page while recording.
   Injected on demand; removes itself when the recording ends. */
(function () {
  if (window.__myloomBar) { return; }

  var bar = document.createElement('div');
  bar.id = 'myloom-bar';
  bar.setAttribute('role', 'status');

  var dot = document.createElement('span');
  dot.className = 'ml-dot';
  var time = document.createElement('span');
  time.className = 'ml-time';
  time.textContent = '0:00';
  var note = document.createElement('span');
  note.className = 'ml-note';

  // Move the camera bubble out of the way of whatever you are demonstrating,
  // without leaving the page you are recording.
  var CORNERS = ['bl', 'br', 'tr', 'tl'];
  var GLYPHS = { tl: '◤', tr: '◥', bl: '◣', br: '◢' };
  var corner = 'bl';
  var bubble = document.createElement('button');
  bubble.className = 'ml-bubble';
  bubble.title = 'Move the camera bubble to another corner';
  bubble.textContent = GLYPHS[corner];
  bubble.hidden = true;
  bubble.addEventListener('click', function () {
    corner = CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length];
    bubble.textContent = GLYPHS[corner];
    chrome.runtime.sendMessage({ type: 'setBubble', corner: corner });
  });

  // Drop the camera without ending the recording.
  var cameraOn = true;
  var camera = document.createElement('button');
  camera.className = 'ml-camera';
  camera.title = 'Turn the camera bubble off or on';
  camera.textContent = '🎥';
  camera.hidden = true;
  camera.addEventListener('click', function () {
    cameraOn = !cameraOn;
    camera.textContent = cameraOn ? '🎥' : '🚫';
    camera.classList.toggle('off', !cameraOn);
    chrome.runtime.sendMessage({ type: 'setCamera', on: cameraOn });
  });

  var pause = document.createElement('button');
  pause.textContent = 'Pause';
  pause.addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'pause' });
  });

  var stop = document.createElement('button');
  stop.className = 'ml-stop';
  stop.textContent = 'Stop & save';
  stop.addEventListener('click', function () {
    stop.disabled = true;
    stop.textContent = 'Saving…';
    chrome.runtime.sendMessage({ type: 'stop' });
  });

  bar.append(dot, time, camera, bubble, pause, stop, note);
  document.documentElement.appendChild(bar);
  window.__myloomBar = bar;

  function format(seconds) {
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function teardown() {
    chrome.runtime.onMessage.removeListener(onMessage);
    if (bar.parentNode) { bar.parentNode.removeChild(bar); }
    delete window.__myloomBar;
  }

  function onMessage(message) {
    if (!message) { return; }
    if (message.type === 'tick') { time.textContent = format(message.seconds); }
    if (message.type === 'upload' && typeof message.sent === 'number') {
      var mb = message.sent / (1024 * 1024);
      note.textContent = 'Uploaded ' + (mb < 1 ? Math.round(message.sent / 1024) + ' KB' : mb.toFixed(1) + ' MB') +
        (message.pending ? ' · ' + message.pending + ' queued' : '');
    }
    if (message.type === 'bubble' && message.corner) {
      corner = message.corner;
      bubble.textContent = GLYPHS[corner] || GLYPHS.bl;
      bubble.hidden = false;
    }
    if (message.type === 'camera') {
      cameraOn = message.on !== false;
      camera.textContent = cameraOn ? '🎥' : '🚫';
      camera.classList.toggle('off', !cameraOn);
      camera.hidden = false;
    }
    if (message.type === 'state') {
      bar.classList.toggle('paused', message.status === 'paused');
      pause.textContent = message.status === 'paused' ? 'Resume' : 'Pause';
      if (message.status === 'finishing') {
        pause.disabled = true;
        stop.disabled = true;
        stop.textContent = 'Saving…';
      }
    }
    if (message.type === 'teardown') { teardown(); }
  }

  chrome.runtime.onMessage.addListener(onMessage);
})();
