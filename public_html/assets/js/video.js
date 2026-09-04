/* ==========================================================================
   MyLoom video page — owner-facing detail view.
   Tabs: Overview (player + comments), Share, Analytics, Transcript, Settings.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var Views = ML.Views = ML.Views || {};

  Views.video = function (root, params) {
    var uid = params.uid;
    var video = null;
    var player = null;
    var tab = params.tab || 'overview';

    clear(root);
    var shell = el('div');
    root.appendChild(shell);
    ML.loading(shell);

    ML.get('videos/get', { uid: uid }).then(function (response) {
      video = response.video;
      render();
      if (params.isNew) { setTimeout(function () { shareDialog(video); }, 400); }
    }).catch(function (error) {
      clear(shell).appendChild(ML.emptyState('⚠️', 'Could not open this video', error.message,
        el('button.btn', { type: 'button', onclick: function () { App.go('/'); } }, 'Back to library')));
    });

    /* --- Layout ----------------------------------------------------------- */

    /** A screenshot has no timeline, so several panes read differently. */
    function isImage() {
      return video && video.kind === 'image';
    }

    function render() {
      var tabsNode = el('div.tabs');
      var paneNode = el('div');

      var tabs = [
        { key: 'overview', label: 'Overview' },
        { key: 'share', label: 'Share' },
        { key: 'analytics', label: 'Analytics' },
        // A screenshot has nothing to transcribe.
        isImage() ? null : { key: 'transcript', label: 'Transcript' },
        { key: 'settings', label: 'Settings' }
      ].filter(Boolean);
      tabs.forEach(function (item) {
        tabsNode.appendChild(el('button.tab' + (tab === item.key ? '.active' : ''), {
          type: 'button',
          onclick: function () {
            tab = item.key;
            ML.$$('.tab', tabsNode).forEach(function (node) { node.classList.remove('active'); });
            this.classList.add('active');
            renderPane(paneNode);
            history.replaceState({}, '', App.href('/video/' + uid + (tab === 'overview' ? '' : '?tab=' + tab)));
          }
        }, item.label));
      });

      clear(shell).appendChild(el('div', {}, [
        el('div.page-head', {}, [
          el('div.grow', {}, [
            el('h1.truncate', { text: video.title, title: video.title }),
            el('div.row.wrap.small.muted', {}, [
              el('span', { text: ML.dateTimeLabel(video.created_at) }),
              el('span', {}, '·'),
              el('span', {
              text: isImage() ? (video.width ? video.width + ' × ' + video.height : 'Screenshot')
                : (video.is_cut && video.play_duration_human
                  ? video.play_duration_human + ' (cut from ' + video.duration_human + ')'
                  : video.duration_human)
            }),
              el('span', {}, '·'),
              el('span', { text: video.view_count + ' views' }),
              el('span', {}, '·'),
              el('span', { text: video.size_human }),
              video.status !== 'ready' ? el('span.badge.warn', {}, video.status) : null
            ])
          ]),
          el('div.row', {}, [
            el('button.btn', {
              type: 'button', onclick: function () { window.open(video.share_url, '_blank', 'noopener'); }
            }, 'Preview'),
            el('button.btn.primary', { type: 'button', onclick: function () { shareDialog(video); } }, '🔗 Share')
          ])
        ]),
        tabsNode,
        paneNode
      ]));
      renderPane(paneNode);
    }

    function renderPane(node) {
      clear(node);
      if (tab === 'overview') { return overviewPane(node); }
      if (tab === 'share') { return sharePane(node); }
      if (tab === 'analytics') { return analyticsPane(node); }
      if (tab === 'transcript') { return transcriptPane(node); }
      return settingsPane(node);
    }

    /* --- Overview --------------------------------------------------------- */

    function overviewPane(node) {
      var playerNode = el('div');
      var commentsNode = el('div');

      node.appendChild(el('div.watch-layout', {}, [
        el('div', {}, [
          playerNode,
          video.summary
            ? el('div.card.pad.mt', {}, [el('h3', {}, 'Summary'), el('p.small', { text: video.summary })])
            : null,
          video.description
            ? el('div.card.pad.mt', {}, [el('h3', {}, 'Description'), el('p.small', { text: video.description })])
            : null,
          el('div.card.mt', {}, [
            el('div.card-head', {}, el('strong', {}, 'Comments')),
            el('div.card-body', {}, commentsNode)
          ])
        ]),
        el('div.watch-side', {}, [
          el('div.side-panel', {}, [
            el('header', {}, 'Quick actions'),
            el('div.side-body.col', {}, [
              ML.copyField(video.share_url),
              el('button.btn.block', {
                type: 'button', onclick: function () { ML.Export.open({ video: video }); }
              }, isImage() ? '⬇ Download PNG' : '⬇ Download (WebM / MP4)'),
              el('button.btn.block', { type: 'button', onclick: function () { embedDialog(video); } }, '</> Embed code'),
              el('button.btn.block', { type: 'button', onclick: function () { thumbnailDialog(video, refresh); } }, '🖼 Set thumbnail'),
              el('button.btn.block', {
                type: 'button',
                onclick: function () {
                  ML.AnnotationEditor.open({ video: video, onSaved: function () { refresh(); } });
                }
              }, [
                '✏️ Text, links, blur & shapes',
                video.annotations && video.annotations.length
                  ? el('span.badge.accent', { style: { marginLeft: '6px' } }, String(video.annotations.length))
                  : null
              ]),
              (video.annotations && video.annotations.length) || video.trim_start > 0 || video.trim_end
                ? el('button.btn.block', {
                    type: 'button',
                    title: 'Re-encode so overlays and trim become part of the file',
                    onclick: function () {
                      ML.Export.applyPermanently({ video: video, onDone: refresh });
                    }
                  }, '🔒 Apply overlays & trim permanently')
                : null,
              el('button.btn.block', {
                type: 'button',
                onclick: function () {
                  ML.CutEditor.open({ video: video, onSaved: function () { refresh(); } });
                }
              }, [
                '✂️ Cut, trim & stitch',
                video.is_cut
                  ? el('span.badge.accent', { style: { marginLeft: '6px' } },
                      video.segments && video.segments.length > 1
                        ? video.segments.length + ' pieces' : 'trimmed')
                  : null
              ]),
              el('button.btn.block', { type: 'button', onclick: function () { chaptersDialog(video, player, refresh); } }, '📑 Chapters')
            ])
          ]),
          video.chapters && video.chapters.length
            ? el('div.side-panel', {}, [
                el('header', {}, 'Chapters'),
                el('div.side-body', {}, video.chapters.map(function (chapter) {
                  return el('div.chapter-item', {
                    onclick: function () { if (player) { player.seekAbsolute(Number(chapter.start_time)); player.play(); } }
                  }, [
                    el('time', { text: ML.duration(chapter.start_time) }),
                    el('span', { text: chapter.title })
                  ]);
                }))
              ])
            : null
        ])
      ]));

      if (isImage()) {
        player = showImage(playerNode);
      } else {
        player = ML.Player(playerNode, {
          src: video.media_url,
          poster: video.thumbnail,
          fallbackDuration: video.duration,
          trimStart: video.trim_start,
          trimEnd: video.trim_end,
          segments: video.segments,
          chapters: video.chapters || []
        });
        ML.Overlays.attach(player, video.annotations || []);
        ML.Overlays.attachWatermark(player, video.watermark);
        loadCaptionsInto(player);
      }

      ML.CommentsPanel(commentsNode, {
        uid: uid, player: player, canManage: true, signedIn: true,
        allowComments: video.allow_comments, allowReactions: video.allow_reactions,
        allowTimestamps: !isImage()
      });
    }

    /** A screenshot instead of a player, with a way back into the editor. */
    function showImage(node) {
      clear(node);
      node.appendChild(el('div.shot-frame', {}, el('img', { src: video.media_url, alt: video.title })));
      node.appendChild(el('div.row.mt', {}, el('button.btn', {
        type: 'button',
        onclick: function () {
          App.go('/shot?uid=' + encodeURIComponent(uid) + '&src=' + encodeURIComponent(video.media_url));
        }
      }, '✎ Edit screenshot')));
      return {
        root: node,
        currentTime: function () { return 0; },
        seek: function () {}, play: function () {}, pause: function () {},
        setMarkers: function () {}, setChapters: function () {},
        setCaptions: function () {}, setCaptionTracks: function () {},
        activeCaptionTrack: function () { return null; },
        floatEmoji: function () {},
        destroy: function () {}
      };
    }

    function loadCaptionsInto(target) {
      ML.get('transcript/get', { uid: uid }).then(function (response) {
        if (response.transcript && response.transcript.segments.length) {
          target.setCaptions(response.transcript.segments);
        }
      }).catch(function () { /* captions are optional */ });
    }

    function refresh() {
      return ML.get('videos/get', { uid: uid }).then(function (response) {
        video = response.video;
        render();
      });
    }

    /* --- Share ------------------------------------------------------------ */

    function sharePane(node) {
      var linksNode = el('div');
      node.appendChild(el('div', { style: { maxWidth: '760px' } }, [
        el('div.card.pad', {}, [
          el('h3', {}, 'Main link'),
          el('p.hint', {}, 'Anyone with this link can watch, subject to the privacy setting below.'),
          ML.copyField(video.share_url),
          el('div.row.wrap.mt', {}, [
            el('button.btn.sm', { type: 'button', onclick: function () { embedDialog(video); } }, 'Embed'),
            el('a.btn.sm', {
              href: 'mailto:?subject=' + encodeURIComponent(video.title) + '&body=' + encodeURIComponent(video.share_url),
              target: '_blank'
            }, '✉️ Email'),
            el('a.btn.sm', {
              href: 'https://wa.me/?text=' + encodeURIComponent(video.title + ' ' + video.share_url),
              target: '_blank', rel: 'noopener'
            }, 'WhatsApp'),
            el('a.btn.sm', {
              href: 'https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(video.share_url),
              target: '_blank', rel: 'noopener'
            }, 'LinkedIn')
          ])
        ]),
        el('div.card.mt-lg', {}, [
          el('div.card-head', {}, [
            el('strong', {}, 'Tracked links'),
            el('button.btn.sm.primary', { type: 'button', onclick: function () { linkDialog(null); } }, '+ New link')
          ]),
          el('div.card-body', {}, [
            el('p.hint', {}, 'Create separate links per recipient with their own password, expiry and view cap.'),
            linksNode
          ])
        ])
      ]));

      function loadLinks() {
        ML.loading(linksNode);
        ML.get('share/list', { uid: uid }).then(function (response) {
          clear(linksNode);
          if (!response.links.length) {
            linksNode.appendChild(el('p.small.muted', {}, 'No tracked links yet.'));
            return;
          }
          linksNode.appendChild(el('div.table-wrap', {}, el('table.data', {}, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'Label'), el('th', {}, 'Link'), el('th', {}, 'Protection'),
              el('th.right', {}, 'Views'), el('th', {}, '')
            ])),
            el('tbody', {}, response.links.map(function (link) {
              return el('tr', { style: link.revoked ? { opacity: '.5' } : null }, [
                el('td', { text: link.label || '—' }),
                el('td', {}, el('button.btn.sm.ghost', {
                  type: 'button', onclick: function () { ML.copy(link.url); }
                }, 'Copy link')),
                el('td', {}, [
                  link.has_password ? el('span.badge', {}, '🔒 Password') : null,
                  link.expires_at ? el('span.badge', {}, 'Expires ' + ML.dateLabel(link.expires_at)) : null,
                  link.max_views ? el('span.badge', {}, 'Max ' + link.max_views) : null,
                  link.revoked ? el('span.badge.danger', {}, 'Revoked') : null,
                  (!link.has_password && !link.expires_at && !link.max_views && !link.revoked)
                    ? el('span.muted.tiny', {}, 'Open') : null
                ]),
                el('td.right', { text: String(link.view_count) }),
                el('td.right', {}, el('div.row.end', {}, [
                  el('button.btn.sm', { type: 'button', onclick: function () { linkDialog(link); } }, 'Edit'),
                  el('button.btn.sm.danger', {
                    type: 'button',
                    onclick: function () {
                      ML.confirm({ title: 'Delete this link?', message: 'Anyone holding it will lose access.', danger: true, confirmLabel: 'Delete' })
                        .then(function (yes) {
                          if (yes) { ML.post('share/delete', { id: link.id }).then(loadLinks).catch(ML.toastError); }
                        });
                    }
                  }, 'Delete')
                ]))
              ]);
            }))
          ])));
        }).catch(function (error) {
          clear(linksNode).appendChild(el('p.small', { text: error.message }));
        });
      }

      function linkDialog(link) {
        var label = el('input', { type: 'text', value: (link && link.label) || '', placeholder: 'e.g. Acme Corp proposal' });
        var password = el('input', { type: 'password', placeholder: link && link.has_password ? 'unchanged' : 'no password' });
        var expires = el('input', { type: 'datetime-local', value: link && link.expires_at ? link.expires_at.replace(' ', 'T').slice(0, 16) : '' });
        var maxViews = el('input', { type: 'number', min: '0', value: link && link.max_views ? String(link.max_views) : '' });
        var download = el('input', { type: 'checkbox', checked: !link || link.allow_download });
        var revoked = el('input', { type: 'checkbox', checked: !!(link && link.revoked) });

        ML.modal({
          title: link ? 'Edit link' : 'New tracked link',
          body: [
            el('label.field', {}, [el('span', {}, 'Label (private)'), label]),
            el('label.field', {}, [el('span', {}, 'Password'), password,
              el('div.hint', {}, link && link.has_password ? 'Leave blank to keep the current password.' : 'Optional.')]),
            el('label.field', {}, [el('span', {}, 'Expires'), expires]),
            el('label.field', {}, [el('span', {}, 'Maximum views'), maxViews, el('div.hint', {}, 'Blank or 0 means unlimited.')]),
            el('label.check', {}, [download, el('span', {}, 'Allow downloads through this link')]),
            link ? el('label.check', {}, [revoked, el('span', {}, 'Revoked (link stops working)')]) : null
          ],
          footer: function (api) {
            return [
              el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
              el('button.btn.primary', {
                type: 'button',
                onclick: function () {
                  var payload = {
                    uid: uid,
                    label: label.value,
                    expires_at: expires.value,
                    max_views: Number(maxViews.value || 0),
                    allow_download: download.checked
                  };
                  if (password.value) { payload.password = password.value; }
                  if (link) {
                    payload.id = link.id;
                    payload.revoked = revoked.checked;
                    if (!password.value) { delete payload.password; }
                  }
                  ML.post(link ? 'share/update' : 'share/create', payload)
                    .then(function (response) {
                      api.close();
                      if (response.url) { ML.copy(response.url); }
                      loadLinks();
                    })
                    .catch(ML.toastError);
                }
              }, link ? 'Save' : 'Create link')
            ];
          }
        });
      }

      loadLinks();
    }

    /* --- Analytics -------------------------------------------------------- */

    function analyticsPane(node) {
      ML.loading(node);
      ML.get('analytics/video', { uid: uid }).then(function (data) {
        var totals = data.totals;
        var maxEngagement = Math.max.apply(null, data.engagement.concat([1]));
        var daily = Views.dailySeries(data.daily, 30);
        var maxDaily = Math.max.apply(null, daily.map(function (d) { return d.views; }).concat([1]));

        clear(node).appendChild(el('div', {}, [
          el('div.stat-grid', {}, [
            Views.stat('Views', totals.views),
            Views.stat('Unique viewers', totals.uniques),
            Views.stat('Watch time', totals.watch_human),
            Views.stat('Avg. completion', totals.avg_percent + '%'),
            Views.stat('Finished', totals.completions),
            Views.stat('Engagement', totals.comments + totals.reactions, totals.comments + ' comments · ' + totals.reactions + ' reactions'),
            Views.stat('Link clicks', totals.cta_clicks || 0,
              (totals.cta_clickers || 0) + ' of ' + totals.uniques + ' viewers clicked')
          ]),

          el('div.card.mt-lg', {}, [
            el('div.card-head', {}, [
              el('strong', {}, 'Attention across the video'),
              el('span.tiny.muted', {}, 'Taller bars = more replays')
            ]),
            el('div.card-body', {}, [
              el('div.bars', {}, data.engagement.map(function (plays, index) {
                return el('i', {
                  style: { height: Math.max(2, (plays / maxEngagement) * 100) + '%' },
                  title: Math.round((index / 100) * (video.duration || 0)) + 's — ' + plays + ' plays'
                });
              })),
              el('div.row.between.tiny.muted.mt', {}, [el('span', {}, '0:00'), el('span', { text: video.duration_human })])
            ])
          ]),

          el('div.card.mt-lg', {}, [
            el('div.card-head', {}, el('strong', {}, 'Views over time')),
            el('div.card-body', {}, [
              el('div.bars', {}, daily.map(function (day) {
                return el('i', {
                  style: { height: Math.max(2, (day.views / maxDaily) * 100) + '%', opacity: day.views ? '.9' : '.18' },
                  title: day.day + ': ' + day.views + ' views'
                });
              })),
              el('div.row.between.tiny.muted.mt', {}, [
                el('span', { text: daily[0].day }), el('span', { text: daily[daily.length - 1].day })
              ])
            ])
          ]),

          el('div.card.mt-lg', {}, [
            el('div.card-head', {}, [
              el('strong', {}, 'Who watched'),
              el('a.btn.sm', {
                href: ML.apiUrl('analytics/export') + '&uid=' + encodeURIComponent(uid)
              }, '⬇ Export CSV')
            ]),
            el('div.table-wrap', {}, el('table.data', {}, [
              el('thead', {}, el('tr', {}, [
                el('th', {}, 'Viewer'), el('th', {}, 'Watched'), el('th', {}, 'Completion'),
                el('th', {}, 'Device'), el('th', {}, 'Source'), el('th', {}, 'When')
              ])),
              el('tbody', {}, data.viewers.length
                ? data.viewers.map(function (viewer) {
                    return el('tr', {}, [
                      el('td', {}, el('div.row', {}, [
                        ML.avatar(viewer, 'sm'),
                        el('div', {}, [
                          el('div', { text: viewer.name }),
                          viewer.email ? el('div.tiny.muted', { text: viewer.email }) : null
                        ])
                      ])),
                      el('td', { text: viewer.watched }),
                      el('td', {}, [
                        el('span', { text: viewer.percent + '%' }),
                        viewer.completed ? el('span.badge.ok', { style: { marginLeft: '6px' } }, 'Finished') : null
                      ]),
                      el('td', { text: viewer.device || '—' }),
                      el('td.truncate', { style: { maxWidth: '180px' }, text: viewer.referrer || 'Direct' }),
                      el('td', { text: ML.timeAgo(viewer.created_at), title: ML.dateTimeLabel(viewer.created_at) })
                    ]);
                  })
                : el('tr', {}, el('td', { colspan: '6' }, el('span.muted', {}, 'No views recorded yet.'))))
            ]))
          ]),

          (data.clicks && data.clicks.length) ? el('div.card.mt-lg', {}, [
            el('div.card-head', {}, el('strong', {}, 'Links clicked')),
            el('div.table-wrap', {}, el('table.data', {}, [
              el('thead', {}, el('tr', {}, [
                el('th', {}, 'Destination'), el('th', {}, 'Where'), el('th.right', {}, 'Clicks')
              ])),
              el('tbody', {}, data.clicks.map(function (click) {
                return el('tr', {}, [
                  el('td.truncate', { style: { maxWidth: '360px' }, text: click.url }),
                  el('td', { text: click.kind === 'cta' ? 'CTA banner' : 'On-video link' }),
                  el('td.right', { text: String(click.count) })
                ]);
              }))
            ]))
          ]) : null,

          data.devices.length ? el('div.card.mt-lg', {}, [
            el('div.card-head', {}, el('strong', {}, 'Devices & sources')),
            el('div.card-body.row.wrap.gap-lg', {}, [
              el('div.grow', {}, [
                el('h3.small', {}, 'Devices'),
                el('div', {}, data.devices.map(function (item) {
                  return el('div.row.between.small', {}, [el('span', { text: item.device }), el('strong', { text: String(item.count) })]);
                }))
              ]),
              el('div.grow', {}, [
                el('h3.small', {}, 'Traffic sources'),
                el('div', {}, data.referrers.map(function (item) {
                  return el('div.row.between.small', {}, [
                    el('span.truncate', { style: { maxWidth: '220px' }, text: item.source }),
                    el('strong', { text: String(item.count) })
                  ]);
                }))
              ])
            ])
          ]) : null
        ]));
      }).catch(function (error) {
        clear(node).appendChild(el('div.card.pad', {}, el('p', { text: error.message })));
      });
    }

    /* --- Transcript ------------------------------------------------------- */

    function transcriptPane(node) {
      ML.loading(node);
      var activeLang = '';

      function load() {
        return Promise.all([
          ML.get('transcript/list', { uid: uid }),
          ML.get('transcript/get', { uid: uid, lang: activeLang })
        ]).then(function (results) {
          renderPane(results[0].transcripts || [], results[1].transcript);
        }).catch(function (error) {
          clear(node).appendChild(el('div.card.pad', {}, el('p', { text: error.message })));
        });
      }

      function renderPane(tracks, transcript) {
        var body = el('div');
        var langRow = el('div.row.wrap', { style: { gap: '6px' } });

        tracks.forEach(function (track) {
          langRow.appendChild(el('button.chip' + ((activeLang || (transcript && transcript.lang)) === track.lang ? '.active' : ''), {
            type: 'button',
            onclick: function () { activeLang = track.lang; load(); }
          }, [
            track.label + ' (' + track.lang + ')',
            track.is_default ? el('span.tiny', {}, ' ★') : null
          ]));
        });

        clear(node).appendChild(el('div', { style: { maxWidth: '860px' } }, [
          el('div.card', {}, [
            el('div.card-head', {}, [
              el('strong', {}, 'Transcript & captions'),
              el('div.row.wrap', {}, [
                el('button.btn.sm.primary', {
                  type: 'button', onclick: transcribeDialog
                }, '🎙 Transcribe with AI'),
                el('button.btn.sm', { type: 'button', onclick: pasteTranscriptDialog },
                  transcript ? 'Paste / replace' : 'Paste transcript'),
                transcript ? el('button.btn.sm', { type: 'button', onclick: translateDialog }, '🌍 Translate') : null,
                el('button.btn.sm', {
                  type: 'button',
                  onclick: function (event) {
                    var button = event.target;
                    button.disabled = true;
                    button.textContent = 'Summarising…';
                    ML.post('transcript/summarize', { uid: uid })
                      .then(function (result) {
                        ML.toast(result.source === 'ai' ? 'Summary generated with AI' : 'Summary generated', 'success');
                        return refresh();
                      })
                      .catch(function (error) {
                        button.disabled = false;
                        button.textContent = '✨ Summarise';
                        ML.toastError(error);
                      });
                  }
                }, '✨ Summarise')
              ])
            ]),
            tracks.length > 1 ? el('div.card-body', { style: { paddingBottom: '0' } }, [
              el('p.hint', {}, 'Languages'), langRow
            ]) : null,
            el('div.card-body', {}, body)
          ])
        ]));

        if (!transcript) {
          body.appendChild(ML.emptyState('📝', 'No transcript yet',
            'Use “Transcribe with AI” for an accurate one, record with “Capture transcript” ' +
            'enabled in Chrome, or paste an existing transcript.'));
          return;
        }

        var lang = transcript.lang;
        body.appendChild(el('div.row.between.wrap.mb', {}, [
          el('span.small.muted', {
            text: transcript.segments.length + ' lines · ' + transcript.label +
              ' · from ' + (transcript.source === 'api' ? 'AI' : transcript.source)
          }),
          el('div.row.wrap', {}, [
            el('a.btn.sm', { href: App.fileUrl('c=' + encodeURIComponent(uid) + '&lang=' + encodeURIComponent(lang)),
              download: uid + '-' + lang + '.vtt' }, '⬇ .vtt'),
            el('a.btn.sm', { href: App.fileUrl('c=' + encodeURIComponent(uid) + '&lang=' + encodeURIComponent(lang) + '&format=srt') }, '⬇ .srt'),
            el('button.btn.sm', { type: 'button', onclick: function () { ML.copy(transcript.text); } }, 'Copy text'),
            el('button.btn.sm', { type: 'button', onclick: function () { editDialog(transcript); } }, '✎ Edit lines'),
            tracks.length > 1 && !isDefault(tracks, lang) ? el('button.btn.sm', {
              type: 'button',
              onclick: function () {
                ML.post('transcript/make-default', { uid: uid, lang: lang })
                  .then(function () { ML.toast('Default caption language set', 'success'); return load(); })
                  .catch(ML.toastError);
              }
            }, 'Make default') : null,
            tracks.length > 1 ? el('button.btn.sm.danger', {
              type: 'button',
              onclick: function () {
                ML.confirm({ title: 'Delete this language?', message: transcript.label + ' captions will be removed.',
                  danger: true, confirmLabel: 'Delete' }).then(function (yes) {
                  if (!yes) { return; }
                  ML.post('transcript/delete', { uid: uid, lang: lang })
                    .then(function () { activeLang = ''; return load(); })
                    .catch(ML.toastError);
                });
              }
            }, 'Delete') : null
          ])
        ]));

        body.appendChild(el('div', { style: { maxHeight: '460px', overflowY: 'auto' } },
          transcript.segments.map(function (segment) {
            return el('div.transcript-line', {
              onclick: function () {
                if (player) { player.seekAbsolute(segment.start); player.play(); }
              }
            }, [
              el('time', { text: ML.timecode(segment.start) }),
              el('span', { text: segment.text })
            ]);
          })));
      }

      function isDefault(tracks, lang) {
        return tracks.some(function (t) { return t.lang === lang && t.is_default; });
      }

      /* --- Transcribe with AI ------------------------------------------- */

      function transcribeDialog() {
        var langInput = el('input', { type: 'text', placeholder: 'auto-detect', value: '' });
        var status = el('p.hint');
        var bar = el('div.upload-progress', { style: { display: 'none' } }, el('i', { style: { width: '0%' } }));
        var cancelled = false;

        var dialog = ML.modal({
          title: 'Transcribe with AI',
          body: [
            el('p.small', {}, 'Your browser extracts the audio and sends it to the speech-to-text ' +
              'service configured for this instance. Nothing goes anywhere else.'),
            el('label.field', {}, [
              el('span', {}, 'Spoken language (optional)'), langInput,
              el('div.hint', {}, 'A two-letter code like en, ur, ar or es. Leave blank to auto-detect.')
            ]),
            bar, status
          ],
          footer: function (api) {
            return [
              el('button.btn', { type: 'button', onclick: function () { cancelled = true; api.close(); } }, 'Cancel'),
              el('button.btn.primary', {
                type: 'button',
                onclick: function (event) { run(event.target, api); }
              }, 'Start')
            ];
          }
        });

        function progress(label, ratio) {
          bar.style.display = '';
          bar.firstChild.style.width = Math.round((ratio || 0) * 100) + '%';
          status.textContent = label + (ratio ? ' — ' + Math.round(ratio * 100) + '%' : '…');
        }

        function run(button, api) {
          button.disabled = true;
          langInput.disabled = true;
          status.style.color = '';

          ML.Audio.extractChunks(video.media_url, 480, progress)
            .then(function (chunks) {
              var all = [];
              var index = 0;
              var next = function () {
                if (cancelled || index >= chunks.length) { return Promise.resolve(all); }
                var chunk = chunks[index];
                progress('Transcribing part ' + (index + 1) + ' of ' + chunks.length, index / chunks.length);
                var form = new FormData();
                form.append('uid', uid);
                form.append('audio', chunk.blob, 'chunk-' + index + '.wav');
                form.append('offset', String(chunk.offset));
                form.append('duration', String(chunk.duration));
                if (langInput.value.trim()) { form.append('language', langInput.value.trim()); }
                return ML.postForm('transcript/transcribe', form).then(function (response) {
                  all = all.concat(response.segments || []);
                  index++;
                  return next();
                });
              };
              return next();
            })
            .then(function (segments) {
              if (cancelled) { return null; }
              if (!segments.length) { throw new Error('No speech was recognised in this recording.'); }
              progress('Saving', 1);
              return ML.post('transcript/save', {
                uid: uid, segments: segments, source: 'api',
                lang: langInput.value.trim() || 'en',
                label: (langInput.value.trim() || 'en').toUpperCase()
              }).then(function () {
                api.close();
                ML.toast(segments.length + ' lines transcribed', 'success');
                activeLang = '';
                return load();
              });
            })
            .catch(function (error) {
              button.disabled = false;
              langInput.disabled = false;
              status.textContent = error.message;
              status.style.color = 'var(--danger)';
            });
        }
      }

      /* --- Translate ------------------------------------------------------ */

      function translateDialog() {
        var lang = el('input', { type: 'text', value: 'ur', placeholder: 'ur' });
        var label = el('input', { type: 'text', value: 'Urdu', placeholder: 'Urdu' });
        ML.modal({
          title: 'Translate captions',
          body: [
            el('p.small', {}, 'Creates a second caption track. Timings are kept, so it lines up with the video.'),
            el('label.field', {}, [el('span', {}, 'Language code'), lang]),
            el('label.field', {}, [el('span', {}, 'Language name'), label])
          ],
          footer: function (api) {
            return [
              el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
              el('button.btn.primary', {
                type: 'button',
                onclick: function (event) {
                  var button = event.target;
                  button.disabled = true;
                  button.textContent = 'Translating…';
                  ML.post('transcript/translate', {
                    uid: uid, lang: lang.value.trim(), label: label.value.trim()
                  }).then(function (result) {
                    api.close();
                    ML.toast(result.lines + ' lines translated', 'success');
                    activeLang = result.lang;
                    return load();
                  }).catch(function (error) {
                    button.disabled = false;
                    button.textContent = 'Translate';
                    ML.toastError(error);
                  });
                }
              }, 'Translate')
            ];
          }
        });
      }

      /* --- Edit lines ------------------------------------------------------ */

      function editDialog(transcript) {
        var rows = transcript.segments.map(function (segment) {
          return { start: segment.start, end: segment.end, text: segment.text };
        });
        var listNode = el('div.col', { style: { gap: '6px' } });

        rows.forEach(function (row, index) {
          listNode.appendChild(el('div.row', { style: { alignItems: 'flex-start' } }, [
            el('input', {
              type: 'text', value: ML.timecode(row.start, true), style: { maxWidth: '90px' },
              title: 'Start time',
              onchange: function (e) {
                var parsed = ML.parseTime(e.target.value);
                if (parsed === null) { e.target.value = ML.timecode(row.start, true); return; }
                row.start = parsed;
              }
            }),
            el('textarea', {
              rows: 1, value: row.text, style: { minHeight: '36px' },
              oninput: function (e) { row.text = e.target.value; }
            }),
            el('button.btn.sm.ghost', {
              type: 'button', title: 'Delete this line',
              onclick: function (event) { rows[index] = null; event.target.closest('.row').remove(); }
            }, '✕')
          ]));
        });

        ML.modal({
          title: 'Edit captions — ' + transcript.label,
          wide: true,
          body: [
            el('p.hint', {}, 'Fix wording or timings. End times follow the next line automatically.'),
            el('div', { style: { maxHeight: '52vh', overflowY: 'auto' } }, listNode)
          ],
          footer: function (api) {
            return [
              el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
              el('button.btn.primary', {
                type: 'button',
                onclick: function () {
                  var kept = rows.filter(Boolean)
                    .filter(function (row) { return row.text.trim(); })
                    .sort(function (a, b) { return a.start - b.start; });
                  kept.forEach(function (row, i) {
                    var next = kept[i + 1];
                    row.end = next ? Math.max(row.start + 0.4, Math.min(row.end, next.start)) 
                                   : Math.max(row.end, row.start + 1);
                  });
                  if (!kept.length) { ML.toast('Nothing left to save.', 'error'); return; }
                  ML.post('transcript/save', {
                    uid: uid, segments: kept, source: 'manual',
                    lang: transcript.lang, label: transcript.label
                  }).then(function () {
                    api.close();
                    ML.toast('Captions saved', 'success');
                    return load();
                  }).catch(ML.toastError);
                }
              }, 'Save captions')
            ];
          }
        });
      }

      /* --- Paste ------------------------------------------------------------ */

      function pasteTranscriptDialog() {
        var textarea = el('textarea', { rows: 12, placeholder: 'Paste the transcript here. One line per caption, optionally prefixed with a timestamp like 0:12 or 00:00:12.' });
        ML.modal({
          title: 'Paste a transcript',
          wide: true,
          body: [el('p.hint', {}, 'Timestamps are optional — lines without them are spread evenly across the video.'), textarea],
          footer: function (api) {
            return [
              el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
              el('button.btn.primary', {
                type: 'button',
                onclick: function () {
                  var segments = parseTranscript(textarea.value, video.duration);
                  if (!segments.length) { ML.toast('Nothing to import.', 'error'); return; }
                  ML.post('transcript/save', { uid: uid, segments: segments, source: 'manual' })
                    .then(function () { api.close(); ML.toast('Transcript saved', 'success'); return load(); })
                    .catch(ML.toastError);
                }
              }, 'Save transcript')
            ];
          }
        });
      }

      load();
    }

    /** Parse pasted text into timed segments. */
    function parseTranscript(text, duration) {
      var lines = String(text).split(/\r?\n/).map(function (line) { return line.trim(); })
        .filter(function (line) { return line.length > 0; });
      if (!lines.length) { return []; }
      var stampRe = /^\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]?\s*[-–—:]?\s*/;
      var parsed = lines.map(function (line) {
        var match = line.match(stampRe);
        if (!match) { return { start: null, text: line }; }
        var hours = Number(match[1] || 0), minutes = Number(match[2]), seconds = Number(match[3]);
        return { start: hours * 3600 + minutes * 60 + seconds, text: line.replace(stampRe, '').trim() };
      }).filter(function (item) { return item.text; });

      var total = duration || parsed.length * 4;
      return parsed.map(function (item, index) {
        var start = item.start !== null ? item.start : (index / parsed.length) * total;
        var next = parsed[index + 1];
        var end = next && next.start !== null ? next.start : start + Math.max(1.5, item.text.split(/\s+/).length / 2.6);
        return { start: start, end: Math.max(start + 0.8, end), text: item.text };
      });
    }

    /* --- Settings --------------------------------------------------------- */

    function settingsPane(node) {
      var title = el('input', { type: 'text', value: video.title });
      var description = el('textarea', { rows: 4, value: video.description || '' });
      var visibility = el('select', {}, [
        el('option', { value: 'private' }, 'Private — only me and workspace admins'),
        el('option', { value: 'workspace' }, 'Workspace — anyone in this workspace'),
        el('option', { value: 'link' }, 'Anyone with the link'),
        el('option', { value: 'public' }, 'Public — indexable by search engines')
      ]);
      visibility.value = video.visibility;

      var password = el('input', { type: 'password', placeholder: video.has_password ? 'unchanged' : 'no password' });
      var clearPassword = el('input', { type: 'checkbox' });
      var expires = el('input', { type: 'datetime-local', value: video.expires_at ? video.expires_at.replace(' ', 'T').slice(0, 16) : '' });
      var comments = el('input', { type: 'checkbox', checked: video.allow_comments });
      var reactions = el('input', { type: 'checkbox', checked: video.allow_reactions });
      var download = el('input', { type: 'checkbox', checked: video.allow_download });
      var requireEmail = el('input', { type: 'checkbox', checked: video.require_email });
      var requireLogin = el('input', { type: 'checkbox', checked: video.require_login });
      var ctaLabel = el('input', { type: 'text', value: video.cta_label || '', placeholder: 'Book a call' });
      var ctaUrl = el('input', { type: 'url', value: video.cta_url || '', placeholder: 'https://…' });
      var spaceSelect = el('select', {}, [el('option', { value: '0' }, 'No folder')]
        .concat((App.state.spaces || []).map(function (space) {
          return el('option', { value: String(space.id) }, space.name);
        })));
      spaceSelect.value = String(video.space_id || 0);

      node.appendChild(el('div.settings-max', {}, [
        el('div.section', {}, [
          el('h3', {}, 'Details'),
          el('label.field', {}, [el('span', {}, 'Title'), title]),
          el('label.field', {}, [el('span', {}, 'Description'), description]),
          el('label.field', {}, [el('span', {}, 'Folder'), spaceSelect])
        ]),
        el('div.section', {}, [
          el('h3', {}, 'Privacy'),
          el('label.field', {}, [el('span', {}, 'Who can watch'), visibility]),
          el('label.field', {}, [el('span', {}, 'Password'), password,
            el('div.hint', {}, 'Viewers must enter this before the video plays.')]),
          video.has_password ? el('label.check', {}, [clearPassword, el('span', {}, 'Remove the password')]) : null,
          el('label.field', {}, [el('span', {}, 'Link expires'), expires, el('div.hint', {}, 'Leave blank for no expiry.')]),
          el('label.check', {}, [requireEmail, el('span', {}, ['Ask viewers for their email before watching',
            el('span.check-sub', {}, 'Captures leads and names them in your analytics.')])]),
          el('label.check', {}, [requireLogin, el('span', {}, ['Require viewers to sign in',
            el('span.check-sub', {}, 'Only people with an account on this site can watch. '
              + 'Overrides the email prompt.')])])
        ]),
        el('div.section', {}, [
          el('h3', {}, 'Viewer experience'),
          el('label.check', {}, [comments, el('span', {}, 'Allow comments')]),
          el('label.check', {}, [reactions, el('span', {}, 'Allow emoji reactions')]),
          el('label.check', {}, [download, el('span', {}, 'Allow downloads')]),
          el('label.field.mt', {}, [el('span', {}, 'Call-to-action label'), ctaLabel]),
          el('label.field', {}, [el('span', {}, 'Call-to-action URL'), ctaUrl,
            el('div.hint', {}, 'Shown as a button under the player.')])
        ]),
        el('div.row.mt-lg', {}, [
          el('button.btn.primary', {
            type: 'button',
            onclick: function (event) {
              var button = event.target;
              button.disabled = true;
              var payload = {
                uid: uid,
                title: title.value,
                description: description.value,
                visibility: visibility.value,
                expires_at: expires.value,
                allow_comments: comments.checked,
                allow_reactions: reactions.checked,
                allow_download: download.checked,
                require_email: requireEmail.checked,
                require_login: requireLogin.checked,
                cta_label: ctaLabel.value,
                cta_url: ctaUrl.value,
                space_id: Number(spaceSelect.value)
              };
              if (clearPassword.checked) { payload.password = ''; }
              else if (password.value) { payload.password = password.value; }

              ML.post('videos/update', payload)
                .then(function () { ML.toast('Saved', 'success'); return refresh(); })
                .catch(function (error) { button.disabled = false; ML.toastError(error); });
            }
          }, 'Save changes'),
          el('button.btn.ghost', { type: 'button', onclick: function () { renderPane(node); } }, 'Reset')
        ]),
        el('div.section.mt-lg', {}, [
          el('h3', { style: { color: 'var(--danger)' } }, 'Danger zone'),
          el('p.hint', {}, 'Moving to trash keeps the file for now; deleting forever erases it.'),
          el('div.row', {}, [
            el('button.btn.danger', {
              type: 'button',
              onclick: function () {
                ML.confirm({ title: 'Move to trash?', message: 'You can restore it from Trash.', danger: true, confirmLabel: 'Move to trash' })
                  .then(function (yes) {
                    if (!yes) { return; }
                    ML.post('videos/delete', { uid: uid })
                      .then(function () { ML.toast('Moved to trash'); App.go('/'); })
                      .catch(ML.toastError);
                  });
              }
            }, 'Move to trash')
          ])
        ])
      ]));
    }

    /* --- Dialogs ---------------------------------------------------------- */

    function shareDialog(target) {
      ML.modal({
        title: 'Share “' + target.title + '”',
        body: [
          el('p.hint', {}, 'Anyone with this link can watch it, subject to your privacy settings.'),
          ML.copyField(target.share_url),
          el('div.row.wrap.mt-lg', {}, [
            el('button.btn.sm', { type: 'button', onclick: function () { embedDialog(target); } }, '</> Embed'),
            el('a.btn.sm', { href: 'mailto:?subject=' + encodeURIComponent(target.title) + '&body=' + encodeURIComponent(target.share_url) }, '✉️ Email'),
            el('button.btn.sm', { type: 'button', onclick: function () { window.open(target.share_url, '_blank', 'noopener'); } }, '👁 Preview')
          ]),
          el('hr'),
          el('p.small.muted', {}, 'Need a password, an expiry date or per-recipient tracking? Open the Share tab.')
        ],
        footer: function (api) { return el('button.btn.primary', { type: 'button', onclick: api.close }, 'Done'); }
      });
    }

    function embedDialog(target) {
      var code = el('textarea', { rows: 4, readonly: true, value: target.embed_code, onclick: function () { this.select(); } });
      ML.modal({
        title: 'Embed this video',
        wide: true,
        body: [
          el('p.hint', {}, 'Paste this into any website, Notion, WordPress or help centre.'),
          code
        ],
        footer: function (api) {
          return [
            el('button.btn', { type: 'button', onclick: api.close }, 'Close'),
            el('button.btn.primary', { type: 'button', onclick: function () { ML.copy(target.embed_code); } }, 'Copy code')
          ];
        }
      });
    }

    function thumbnailDialog(target, done) {
      var preview = el('img', { src: target.thumbnail || '', style: { borderRadius: '10px', maxHeight: '220px', margin: '0 auto' } });
      var dataUrl = null;
      var fileInput = el('input', {
        type: 'file', accept: 'image/*',
        onchange: function (event) {
          var file = event.target.files[0];
          if (!file) { return; }
          var reader = new FileReader();
          reader.onload = function () { dataUrl = reader.result; preview.src = dataUrl; };
          reader.readAsDataURL(file);
        }
      });

      ML.modal({
        title: 'Video thumbnail',
        body: [
          target.thumbnail ? preview : el('p.hint', {}, 'No thumbnail set yet.'),
          el('label.field.mt', {}, [el('span', {}, 'Upload an image'), fileInput]),
          el('button.btn.sm', {
            type: 'button',
            onclick: function () {
              if (!player) { ML.toast('Open the Overview tab first.', 'error'); return; }
              var frame = document.createElement('canvas');
              var source = player.video;
              var scale = Math.min(1, 1280 / (source.videoWidth || 1280));
              frame.width = Math.round((source.videoWidth || 1280) * scale);
              frame.height = Math.round((source.videoHeight || 720) * scale);
              try {
                frame.getContext('2d').drawImage(source, 0, 0, frame.width, frame.height);
                dataUrl = frame.toDataURL('image/jpeg', 0.8);
                preview.src = dataUrl;
                preview.style.display = '';
              } catch (e) {
                ML.toast('Could not capture this frame.', 'error');
              }
            }
          }, '📸 Use the current frame')
        ],
        footer: function (api) {
          return [
            el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
            el('button.btn.primary', {
              type: 'button',
              onclick: function () {
                if (!dataUrl) { api.close(); return; }
                ML.post('videos/update', { uid: target.uid, thumbnail_data: dataUrl })
                  .then(function () { api.close(); ML.toast('Thumbnail updated', 'success'); done(); })
                  .catch(ML.toastError);
              }
            }, 'Save thumbnail')
          ];
        }
      });
    }

    function trimDialog(target, activePlayer, done) {
      var duration = target.duration || 0;
      var start = el('input', { type: 'number', step: '0.1', min: '0', value: String(target.trim_start || 0) });
      var end = el('input', { type: 'number', step: '0.1', min: '0', value: String(target.trim_end || duration) });

      function grab(input) {
        return el('button.btn.sm', {
          type: 'button',
          onclick: function () {
            if (!activePlayer) { ML.toast('Open the Overview tab first.', 'error'); return; }
            input.value = activePlayer.absoluteTime().toFixed(1);
          }
        }, 'Use current time');
      }

      ML.modal({
        title: 'Trim video',
        body: [
          el('p.hint', {}, 'Trimming sets playback boundaries — the original file is kept, so you can always undo it.'),
          el('label.field', {}, [el('span', {}, 'Start (seconds)'), el('div.row', {}, [start, grab(start)])]),
          el('label.field', {}, [el('span', {}, 'End (seconds)'), el('div.row', {}, [end, grab(end)])]),
          el('p.hint', {}, 'Full length: ' + ML.duration(duration))
        ],
        footer: function (api) {
          return [
            el('button.btn', {
              type: 'button',
              onclick: function () {
                ML.post('videos/update', { uid: target.uid, trim_start: 0, trim_end: 0 })
                  .then(function () { api.close(); ML.toast('Trim removed'); done(); })
                  .catch(ML.toastError);
              }
            }, 'Remove trim'),
            el('button.btn.primary', {
              type: 'button',
              onclick: function () {
                var s = Number(start.value) || 0;
                var e = Number(end.value) || 0;
                if (e && e <= s) { ML.toast('The end must come after the start.', 'error'); return; }
                ML.post('videos/update', { uid: target.uid, trim_start: s, trim_end: e >= duration ? 0 : e })
                  .then(function () { api.close(); ML.toast('Trim saved', 'success'); done(); })
                  .catch(ML.toastError);
              }
            }, 'Save trim')
          ];
        }
      });
    }

    function chaptersDialog(target, activePlayer, done) {
      var rows = el('div.col');
      var items = (target.chapters || []).map(function (chapter) {
        return { start: Number(chapter.start_time), title: chapter.title };
      });
      if (!items.length) { items.push({ start: 0, title: 'Introduction' }); }

      function renderRows() {
        clear(rows);
        items.forEach(function (item, index) {
          var timeInput = el('input', {
            type: 'number', step: '0.1', min: '0', value: String(item.start),
            style: { maxWidth: '110px' },
            oninput: function (event) { item.start = Number(event.target.value) || 0; }
          });
          var titleInput = el('input', {
            type: 'text', value: item.title, placeholder: 'Chapter title',
            oninput: function (event) { item.title = event.target.value; }
          });
          rows.appendChild(el('div.row', {}, [
            timeInput,
            el('button.btn.sm', {
              type: 'button', title: 'Use the current playback time',
              onclick: function () {
                if (!activePlayer) { return; }
                item.start = Number(activePlayer.absoluteTime().toFixed(1));
                timeInput.value = String(item.start);
              }
            }, '⏱'),
            titleInput,
            el('button.btn.sm.ghost', {
              type: 'button',
              onclick: function () { items.splice(index, 1); renderRows(); }
            }, '✕')
          ]));
        });
      }
      renderRows();

      ML.modal({
        title: 'Chapters',
        wide: true,
        body: [
          el('p.hint', {}, 'Chapters appear as markers on the scrub bar and in a list beside the player.'),
          rows,
          el('button.btn.sm.mt', {
            type: 'button',
            onclick: function () {
              items.push({ start: activePlayer ? Number(activePlayer.absoluteTime().toFixed(1)) : 0, title: '' });
              renderRows();
            }
          }, '+ Add chapter')
        ],
        footer: function (api) {
          return [
            el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
            el('button.btn.primary', {
              type: 'button',
              onclick: function () {
                var payload = items
                  .filter(function (item) { return item.title.trim(); })
                  .map(function (item) { return { start_time: item.start, title: item.title.trim() }; })
                  .sort(function (a, b) { return a.start_time - b.start_time; });
                ML.post('videos/chapters', { uid: target.uid, chapters: payload })
                  .then(function () { api.close(); ML.toast('Chapters saved', 'success'); done(); })
                  .catch(ML.toastError);
              }
            }, 'Save chapters')
          ];
        }
      });
    }

    return function cleanup() {
      if (player) { player.destroy(); player = null; }
    };
  };
})(window, document);
