/* ==========================================================================
   MyLoom watch page — public player, access gates, comments and transcript.
   Also drives the /embed/ iframe (window.MYLOOM.embed === true).
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var boot = ML.boot;
  var root = ML.$('#watch-root');
  var isEmbed = boot.embed === true;

  var player = null;
  var video = null;
  var viewCounted = false;
  var buckets = {};
  var lastBeat = 0;
  var watchedSeconds = 0;
  var lastTick = 0;

  function query(extra) {
    var params = extra || {};
    if (boot.token) { params.token = boot.token; } else { params.uid = boot.uid; }
    return params;
  }

  /* --- Load ---------------------------------------------------------------- */

  function load() {
    ML.get('watch', query()).then(function (response) {
      if (response.ok === false) { return renderGate(response.gate, response.video); }
      video = response.video;
      if (isEmbed) { renderEmbed(); } else { renderPage(); }
    }).catch(function (error) {
      clear(root).appendChild(ML.emptyState('⚠️', 'This video could not be loaded', error.message));
    });
  }

  /* --- Access gates -------------------------------------------------------- */

  function renderGate(gate, info) {
    clear(root);
    if (gate === 'password') { return renderPasswordGate(info); }
    if (gate === 'email') { return renderEmailGate(info); }
    if (gate === 'login') {
      return root.appendChild(el('div.card.pad.gate-card', {}, [
        el('div.empty-icon', {}, '🔑'),
        el('h2', { text: (info && info.title) || 'Sign in to watch' }),
        el('p.small.muted', {}, 'The owner has limited this video to signed-in people.'),
        el('a.btn.primary.block.mt', { href: (boot.baseUrl || '') + '/login' }, 'Sign in'),
        el('a.btn.block.mt', { href: (boot.baseUrl || '') + '/signup' }, 'Create an account')
      ]));
    }
    if (gate === 'expired') {
      return root.appendChild(ML.emptyState('⌛', 'This link has expired',
        'Ask the sender for a new one.'));
    }
    return root.appendChild(ML.emptyState('🔒', 'This video is private',
      'You do not have permission to watch it. Try signing in with an account that does.',
      el('a.btn', { href: (boot.baseUrl || '') + '/' }, 'Sign in')));
  }

  function renderPasswordGate(info) {
    var input = el('input', { type: 'password', placeholder: 'Enter password', autofocus: true });
    var error = el('p.small', { style: { color: 'var(--danger)', display: 'none' } });

    function submit() {
      ML.post('share/unlock', query({ password: input.value }))
        .then(function () { load(); })
        .catch(function (err) {
          error.style.display = '';
          error.textContent = err.message;
          input.select();
        });
    }
    input.onkeydown = function (event) { if (event.key === 'Enter') { submit(); } };

    root.appendChild(el('div.card.pad.gate-card', {}, [
      el('div.empty-icon', {}, '🔒'),
      el('h2', { text: (info && info.title) || 'Password required' }),
      el('p.small.muted', {}, 'This video is protected. Enter the password to watch it.'),
      el('div.mt', {}, input),
      error,
      el('button.btn.primary.block.mt', { type: 'button', onclick: submit }, 'Unlock')
    ]));
  }

  function renderEmailGate(info) {
    var name = el('input', { type: 'text', placeholder: 'Your name' });
    var email = el('input', { type: 'email', placeholder: 'you@company.com' });
    var error = el('p.small', { style: { color: 'var(--danger)', display: 'none' } });

    root.appendChild(el('div.card.pad.gate-card', {}, [
      el('div.empty-icon', {}, '✉️'),
      el('h2', { text: (info && info.title) || 'Almost there' }),
      el('p.small.muted', {}, 'Tell us who you are and the video will start.'),
      el('div.col.mt', {}, [name, email]),
      error,
      el('button.btn.primary.block.mt', {
        type: 'button',
        onclick: function () {
          ML.post('share/identify', { name: name.value, email: email.value })
            .then(load)
            .catch(function (err) { error.style.display = ''; error.textContent = err.message; });
        }
      }, 'Watch video')
    ]));
  }

  /* --- Embed --------------------------------------------------------------- */

  function renderEmbed() {
    clear(root);
    var holder = el('div', { style: { width: '100%', height: '100%' } });
    root.appendChild(holder);
    buildPlayer(holder, { autoplay: false });
    ML.Overlays.attachWatermark(player, video.watermark);
    root.appendChild(el('a', {
      href: video.share_url, target: '_blank', rel: 'noopener',
      style: {
        position: 'fixed', right: '10px', top: '10px', zIndex: '10',
        background: 'rgba(0,0,0,.6)', color: '#fff', padding: '4px 9px',
        borderRadius: '6px', fontSize: '11.5px', textDecoration: 'none'
      }
    }, 'Watch on ' + (video.branding.workspace || 'MyLoom')));
  }

  /* --- Full watch page ------------------------------------------------------ */

  function renderPage() {
    document.title = video.title + ' — ' + (video.branding.workspace || boot.siteName || 'MyLoom');

    var playerNode = el('div');
    var commentsNode = el('div');
    var transcriptNode = el('div');
    var commentCount = el('span.tiny.muted');

    var actions = el('div.watch-actions', {}, [
      el('button.btn', { type: 'button', onclick: function () { ML.copy(video.share_url); } }, '🔗 Copy link'),
      video.download_url
        ? el('button.btn', {
            type: 'button',
            onclick: function () { ML.Export.open({ video: video, annotations: video.annotations }); }
          }, '⬇ Download')
        : null,
      el('button.btn', {
        type: 'button',
        onclick: function () {
          ML.modal({
            title: 'Embed this video',
            wide: true,
            body: [
              el('p.hint', {}, 'Paste this snippet into any page.'),
              el('textarea', { rows: 4, readonly: true, value: video.embed_code, onclick: function () { this.select(); } })
            ],
            footer: function (api) {
              return [
                el('button.btn', { type: 'button', onclick: api.close }, 'Close'),
                el('button.btn.primary', { type: 'button', onclick: function () { ML.copy(video.embed_code); } }, 'Copy')
              ];
            }
          });
        }
      }, '</> Embed'),
      video.can_manage
        ? el('a.btn.primary', { href: (boot.baseUrl || '') + '/video/' + video.uid }, '✎ Manage')
        : null
    ]);

    var side = el('div.watch-side', {}, [
      el('div.side-panel', {}, [
        el('header', {}, [el('span', {}, 'Comments'), commentCount]),
        el('div.side-body', {}, commentsNode)
      ]),
      video.chapters.length
        ? el('div.side-panel', {}, [
            el('header', {}, 'Chapters'),
            el('div.side-body', {}, video.chapters.map(function (chapter) {
              return el('div.chapter-item', {
                onclick: function () { player.seekAbsolute(Number(chapter.start_time)); player.play(); }
              }, [el('time', { text: ML.duration(chapter.start_time) }), el('span', { text: chapter.title })]);
            }))
          ])
        : null,
      el('div.side-panel', { style: { display: 'none' }, id: 'transcript-panel' }, [
        el('header', {}, 'Transcript'),
        el('div.side-body', {}, transcriptNode)
      ])
    ]);

    clear(root).appendChild(el('div.watch-layout', {}, [
      el('div', {}, [
        playerNode,
        el('h1.watch-title', { text: video.title }),
        el('div.watch-byline', {}, [
          ML.avatar(video.owner, 'sm'),
          el('strong', { text: video.owner.name }),
          el('span', {}, '·'),
          el('span', { text: ML.dateLabel(video.created_at) }),
          el('span', {}, '·'),
          el('span', { text: video.view_count + ' views' })
        ]),
        actions,
        video.cta ? el('div.cta-banner', {}, [
          el('strong', { text: video.title }),
          el('a.btn.primary', {
            href: video.cta.url, target: '_blank', rel: 'noopener',
            onclick: function () { trackClick('cta', video.cta.url, 0); }
          }, video.cta.label)
        ]) : null,
        video.summary ? el('div.card.pad.mt', {}, [el('h3', {}, 'Summary'), el('p.small', { text: video.summary })]) : null,
        video.description ? el('div.card.pad.mt', {}, [el('h3', {}, 'Description'), el('p.small', { text: video.description })]) : null
      ]),
      side
    ]));

    buildPlayer(playerNode, { autoplay: !isEmbed });

    ML.CommentsPanel(commentsNode, {
      uid: boot.uid, token: boot.token, player: player,
      canManage: video.can_manage, signedIn: boot.signedIn,
      allowComments: video.allow_comments, allowReactions: video.allow_reactions,
      allowTimestamps: video.kind !== 'image',
      onCount: function (count) { commentCount.textContent = count ? count + '' : ''; }
    });

    loadTranscript(transcriptNode);
    renderTopActions();
  }

  function renderTopActions() {
    var host = ML.$('#watch-top-actions');
    if (!host) { return; }
    clear(host);
    if (!video.branding.hide_branding) {
      host.appendChild(el('span.tiny.muted', {}, 'Powered by ' + (boot.siteName || 'MyLoom')));
    }
    host.appendChild(el('button.btn.sm', {
      type: 'button', onclick: function () { ML.copy(video.share_url); }
    }, 'Copy link'));
  }

  /* --- Player + view tracking ------------------------------------------------ */

  /**
   * A screenshot shares everything with a recording except the playing. The
   * comments panel expects a player, so it gets a stand-in: comments on an
   * image are simply not pinned to a time.
   */
  function buildImage(node) {
    clear(node);
    var frame = el('div.shot-frame', {}, el('img', {
      src: video.media_url, alt: video.title,
      onload: function () { countView(); }
    }));
    node.appendChild(frame);
    player = {
      root: frame,
      currentTime: function () { return 0; },
      seek: function () {},
      play: function () {},
      pause: function () {},
      setMarkers: function () {},
      setChapters: function () {},
      setCaptions: function () {},
      setCaptionTracks: function () {},
      activeCaptionTrack: function () { return null; },
      floatEmoji: function (emoji) {
        var node2 = el('div.reaction-float', { text: emoji, style: { left: (12 + Math.random() * 66) + '%' } });
        frame.appendChild(node2);
        setTimeout(function () { node2.remove(); }, 1750);
      },
      destroy: function () {}
    };
    return player;
  }

  function buildPlayer(node, options) {
    if (video.kind === 'image') { return buildImage(node); }
    player = ML.Player(node, {
      src: video.media_url,
      poster: video.poster,
      fallbackDuration: video.duration,
      trimStart: video.trim_start,
      trimEnd: video.trim_end,
      segments: video.segments,
      chapters: video.chapters,
      autoplay: options.autoplay,
      keyboardScope: 'document',
      onPlay: countView,
      onProgress: onProgress,
      onPause: function () { flush(true); },
      onEnded: function () { flush(true); },
      onError: function () {
        ML.toast('This video could not be played. It may still be processing.', 'error');
      },
      onTrackChange: function (track) { loadCaptionTrack(track); }
    });

    ML.Overlays.attach(player, video.annotations || []);
    ML.Overlays.attachWatermark(player, video.watermark);

    // Record clicks on link overlays so the owner can see if the CTA works.
    player.root.addEventListener('click', function (event) {
      var link = event.target.closest && event.target.closest('a.ov-link');
      if (!link) { return; }
      trackClick('overlay', link.getAttribute('href'), link.dataset.annotationId);
    });

    var tracks = video.caption_tracks || [];
    if (tracks.length) {
      player.setCaptionTracks(tracks);
      // Remember the viewer's language choice across videos.
      var preferred = ML.storage('captionLang');
      var chosen = tracks.filter(function (t) { return t.lang === preferred; })[0] ||
        tracks.filter(function (t) { return t.is_default; })[0] || tracks[0];
      loadCaptionTrack(chosen);
    }

    function loadCaptionTrack(track) {
      if (!track) { return; }
      ML.get('transcript/get', query({ lang: track.lang })).then(function (response) {
        if (response.transcript && response.transcript.segments.length) {
          player.setCaptions(response.transcript.segments);
        }
      }).catch(function () { /* optional */ });
    }
  }

  function trackClick(kind, url, annotationId) {
    ML.post('watch/click', query({
      kind: kind, url: url || '',
      annotation_id: annotationId ? Number(annotationId) : 0,
      at_time: player ? player.absoluteTime() : 0
    })).catch(function () { /* never block the click */ });
  }

  function countView() {
    if (viewCounted) { return; }
    viewCounted = true;
    ML.post('watch/view', query({ referrer: document.referrer || '' })).catch(function () { /* non-critical */ });
  }

  function onProgress(current, total) {
    var now = Date.now();
    if (lastTick && now - lastTick < 2000) {
      watchedSeconds += (now - lastTick) / 1000;
    }
    lastTick = now;

    if (total > 0) {
      buckets[Math.min(99, Math.floor((current / total) * 100))] = true;
    }
    if (now - lastBeat > 12000) { flush(false); }
  }

  function flush(force) {
    if (!viewCounted) { return; }
    var keys = Object.keys(buckets);
    if (!force && !keys.length) { return; }
    lastBeat = Date.now();
    var total = player ? player.duration() : 0;
    var payload = query({
      watched: Number(watchedSeconds.toFixed(1)),
      percent: total > 0 ? Math.round((player.currentTime() / total) * 100) : 0,
      buckets: keys.map(Number)
    });
    buckets = {};

    // Use sendBeacon on unload so the last heartbeat is not dropped.
    if (force && navigator.sendBeacon) {
      try {
        var url = ML.apiUrl('watch/progress');
        var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        // The CSRF header cannot ride along with sendBeacon, so fall back to fetch
        // while the page is still alive and only beacon on a real unload.
        if (document.visibilityState === 'hidden') { navigator.sendBeacon(url, blob); return; }
      } catch (e) { /* fall through */ }
    }
    ML.post('watch/progress', payload).catch(function () { /* non-critical */ });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { flush(true); }
  });
  window.addEventListener('pagehide', function () { flush(true); });

  /* --- Transcript ------------------------------------------------------------ */

  function loadTranscript(node) {
    ML.get('transcript/get', query()).then(function (response) {
      if (!response.transcript || !response.transcript.segments.length) { return; }
      var panel = ML.$('#transcript-panel');
      if (panel) { panel.style.display = ''; }

      var lines = response.transcript.segments.map(function (segment) {
        var line = el('div.transcript-line', {
          onclick: function () { player.seekAbsolute(segment.start); player.play(); }
        }, [el('time', { text: ML.duration(segment.start) }), el('span', { text: segment.text })]);
        line.dataset.start = segment.start;
        line.dataset.end = segment.end;
        return line;
      });

      var search = el('input', {
        type: 'search', placeholder: 'Search transcript…',
        style: { marginBottom: '10px' },
        oninput: function (event) {
          var term = event.target.value.toLowerCase();
          lines.forEach(function (line) {
            line.style.display = !term || line.textContent.toLowerCase().indexOf(term) !== -1 ? '' : 'none';
          });
        }
      });

      clear(node).appendChild(el('div', {}, [search].concat(lines)));

      // Highlight the active line as playback moves.
      player.video.addEventListener('timeupdate', function () {
        var now = player.absoluteTime();
        lines.forEach(function (line) {
          line.classList.toggle('active',
            now >= Number(line.dataset.start) && now <= Number(line.dataset.end));
        });
      });
    }).catch(function () { /* optional */ });
  }

  load();
})(window, document);
