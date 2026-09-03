/* ==========================================================================
   MyLoom audio extraction.

   Speech-to-text services take audio, not a 200 MB screen recording, and the
   server has no ffmpeg to strip the track. So the browser decodes the file,
   mixes it to 16 kHz mono and writes plain WAV — the format every provider
   accepts — then splits it into pieces small enough to upload.

   16 kHz mono 16-bit is 32 KB per second: about 15 MB for eight minutes, which
   sits comfortably inside the usual 25 MB request limit.
   ========================================================================== */
(function (window) {
  'use strict';

  var ML = window.ML;
  var TARGET_RATE = 16000;

  /** Fetch and decode a media file into an AudioBuffer. */
  function decode(url, onProgress) {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) { return Promise.reject(new Error('This browser cannot decode audio.')); }

    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) { throw new Error('Could not read the video file (HTTP ' + response.status + ').'); }
        var total = Number(response.headers.get('content-length') || 0);
        if (total > 600 * 1024 * 1024) {
          throw new Error('This recording is too large to process in the browser (over 600 MB).');
        }
        if (!response.body || !total) { return response.arrayBuffer(); }

        // Stream so a long download can report progress instead of hanging.
        var reader = response.body.getReader();
        var chunks = [];
        var received = 0;
        return (function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              var merged = new Uint8Array(received);
              var offset = 0;
              chunks.forEach(function (chunk) { merged.set(chunk, offset); offset += chunk.length; });
              return merged.buffer;
            }
            chunks.push(result.value);
            received += result.value.length;
            if (onProgress) { onProgress('Downloading audio', received / total); }
            return pump();
          });
        })();
      })
      .then(function (buffer) {
        if (onProgress) { onProgress('Decoding audio', 0); }
        var ctx = new AudioCtx();
        return ctx.decodeAudioData(buffer).then(
          function (audio) { ctx.close(); return audio; },
          function () { ctx.close(); throw new Error('The audio track could not be decoded.'); }
        );
      });
  }

  /** Mix to mono and resample to 16 kHz using an OfflineAudioContext. */
  function toMono16k(audio, onProgress) {
    var OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var frames = Math.ceil(audio.duration * TARGET_RATE);
    if (!OfflineCtx || frames <= 0) {
      return Promise.reject(new Error('This browser cannot resample audio.'));
    }
    if (onProgress) { onProgress('Preparing audio', 0); }

    var offline = new OfflineCtx(1, frames, TARGET_RATE);
    var source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start(0);
    return offline.startRendering();
  }

  /** Encode a mono AudioBuffer slice as a 16-bit PCM WAV blob. */
  function encodeWav(channel, sampleRate, from, to) {
    var length = to - from;
    var buffer = new ArrayBuffer(44 + length * 2);
    var view = new DataView(buffer);

    var writeText = function (offset, text) {
      for (var i = 0; i < text.length; i++) { view.setUint8(offset + i, text.charCodeAt(i)); }
    };

    writeText(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM header size
    view.setUint16(20, 1, true);           // format: PCM
    view.setUint16(22, 1, true);           // channels: mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeText(36, 'data');
    view.setUint32(40, length * 2, true);

    var offset = 44;
    for (var i = from; i < to; i++) {
      var sample = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * Turn a media URL into WAV chunks ready to upload.
   * Resolves with [{ blob, offset, duration }], each at most `chunkSeconds`.
   */
  function extractChunks(url, chunkSeconds, onProgress) {
    chunkSeconds = chunkSeconds || 480;   // eight minutes ≈ 15 MB
    return decode(url, onProgress)
      .then(function (audio) { return toMono16k(audio, onProgress); })
      .then(function (mono) {
        if (onProgress) { onProgress('Packaging audio', 0); }
        var channel = mono.getChannelData(0);
        var perChunk = Math.floor(chunkSeconds * TARGET_RATE);
        var chunks = [];
        for (var start = 0; start < channel.length; start += perChunk) {
          var end = Math.min(channel.length, start + perChunk);
          chunks.push({
            blob: encodeWav(channel, TARGET_RATE, start, end),
            offset: start / TARGET_RATE,
            duration: (end - start) / TARGET_RATE
          });
          if (onProgress) { onProgress('Packaging audio', end / channel.length); }
        }
        return chunks;
      });
  }

  ML.Audio = {
    extractChunks: extractChunks,
    decode: decode,
    encodeWav: encodeWav,
    TARGET_RATE: TARGET_RATE
  };
})(window);
