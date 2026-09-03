/* ==========================================================================
   MyLoom views — library grid, trash and the workspace analytics dashboard.
   Each view renders into the shell's content node. `App` provides state.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var Views = ML.Views = ML.Views || {};

  /* --- Shared: video card --------------------------------------------------- */

  function videoCard(video, context) {
    context = context || {};
    var thumbInner = video.thumbnail
      ? el('img', { src: video.thumbnail, alt: '', loading: 'lazy' })
      : el('div.thumb-fallback', {}, '🎬');

    var openVideo = function () { App.go('/video/' + video.uid); };

    // Hover preview: after a moment, play the real file muted in place. No extra
    // storage or GIF generation, and it stops the moment the pointer leaves.
    var previewTimer = null;
    var previewNode = null;
    var thumbHolder = el('div.thumb', { onclick: openVideo, title: 'Open ' + video.title }, [
      thumbInner,
      el('div.play-overlay', {}, el('i')),
      el('span.len', { text: video.duration_human })
    ]);

    function startPreview() {
      if (previewNode || video.status !== 'ready') { return; }
      previewTimer = setTimeout(function () {
        previewNode = el('video.thumb-preview', {
          src: video.share_url ? null : null,
          muted: true, autoplay: true, loop: true, playsinline: true, preload: 'none'
        });
        previewNode.muted = true;
        previewNode.src = App.fileUrl('v=' + encodeURIComponent(video.uid));
        previewNode.addEventListener('loadeddata', function () {
          try { previewNode.currentTime = Math.min(1.5, (video.duration || 4) / 4); } catch (e) { /* ignore */ }
        });
        previewNode.play().catch(function () { /* autoplay may be blocked */ });
        thumbHolder.appendChild(previewNode);
      }, 450);
    }

    function stopPreview() {
      clearTimeout(previewTimer);
      previewTimer = null;
      if (previewNode) {
        previewNode.pause();
        previewNode.removeAttribute('src');
        previewNode.remove();
        previewNode = null;
      }
    }

    thumbHolder.addEventListener('pointerenter', startPreview);
    thumbHolder.addEventListener('pointerleave', stopPreview);

    var card = el('div.video-card', {}, [
      context.selectable
        ? el('input.card-select', {
            type: 'checkbox',
            checked: context.isSelected && context.isSelected(video.uid),
            onclick: function (event) {
              event.stopPropagation();
              context.onSelect(video.uid, event.target.checked);
            }
          })
        : null,
      thumbHolder,
      el('div.card-actions', {}, [
        el('button.btn.sm.icon', {
          type: 'button', title: 'Copy share link',
          onclick: function (event) { event.stopPropagation(); ML.copy(video.share_url); }
        }, '🔗'),
        el('button.btn.sm.icon', {
          type: 'button', title: 'More actions',
          onclick: function (event) { event.stopPropagation(); cardMenu(event.currentTarget, video, context); }
        }, '⋯')
      ]),
      el('div.card-meta', {}, [
        el('div.card-title', { text: video.title, onclick: openVideo }),
        el('div.card-sub', {}, [
          video.status !== 'ready' ? el('span.badge.warn', {}, video.status) : null,
          el('span', { text: ML.timeAgo(video.created_at), title: ML.dateTimeLabel(video.created_at) }),
          el('span', {}, '·'),
          el('span', { text: video.view_count + (video.view_count === 1 ? ' view' : ' views') }),
          video.comment_count ? el('span', {}, '·') : null,
          video.comment_count ? el('span', { text: video.comment_count + ' 💬' }) : null,
          video.has_password ? el('span.badge', { title: 'Password protected' }, '🔒') : null,
          video.visibility === 'private' ? el('span.badge', {}, 'Private') : null,
          video.visibility === 'public' ? el('span.badge.accent', {}, 'Public') : null
        ])
      ])
    ]);
    return card;
  }

  function cardMenu(anchor, video, context) {
    var existing = document.querySelector('.card-menu');
    if (existing) { existing.remove(); }

    var menu = el('div.dropdown-menu.card-menu', { style: { position: 'fixed', zIndex: '7000' } }, [
      el('button.dropdown-item', { type: 'button', onclick: function () { close(); App.go('/video/' + video.uid); } }, ['📂 Open']),
      el('button.dropdown-item', { type: 'button', onclick: function () { close(); ML.copy(video.share_url); } }, ['🔗 Copy link']),
      el('button.dropdown-item', {
        type: 'button',
        onclick: function () { close(); window.open(video.share_url, '_blank', 'noopener'); }
      }, ['👁 Open share page']),
      el('button.dropdown-item', {
        type: 'button',
        onclick: function () {
          close();
          ML.post('videos/star', { uid: video.uid })
            .then(function () { ML.toast(video.is_starred ? 'Removed from starred' : 'Starred'); context.reload && context.reload(); })
            .catch(ML.toastError);
        }
      }, [video.is_starred ? '☆ Unstar' : '⭐ Star']),
      el('button.dropdown-item', {
        type: 'button',
        onclick: function () { close(); moveDialog([video.uid], context); }
      }, ['📁 Move to folder']),
      el('div.dropdown-sep'),
      el('button.dropdown-item.danger', {
        type: 'button',
        onclick: function () {
          close();
          ML.confirm({
            title: 'Move to trash?',
            message: '"' + video.title + '" will be moved to trash. You can restore it later.',
            danger: true, confirmLabel: 'Move to trash'
          }).then(function (yes) {
            if (!yes) { return; }
            ML.post('videos/delete', { uid: video.uid })
              .then(function () { ML.toast('Moved to trash'); context.reload && context.reload(); })
              .catch(ML.toastError);
          });
        }
      }, ['🗑 Move to trash'])
    ]);

    function close() {
      menu.remove();
      document.removeEventListener('click', onDoc, true);
    }
    function onDoc(event) { if (!menu.contains(event.target)) { close(); } }

    document.body.appendChild(menu);
    var rect = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 250, rect.right - 220)) + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    setTimeout(function () { document.addEventListener('click', onDoc, true); }, 10);
  }

  function moveDialog(uids, context) {
    var select = el('select', {}, [el('option', { value: '0' }, 'Library root (no folder)')]
      .concat((App.state.spaces || []).map(function (space) {
        return el('option', { value: String(space.id) }, space.name);
      })));

    ML.modal({
      title: uids.length > 1 ? 'Move ' + uids.length + ' videos' : 'Move video',
      body: el('label.field', {}, [el('span', {}, 'Destination folder'), select]),
      footer: function (api) {
        return [
          el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
          el('button.btn.primary', {
            type: 'button',
            onclick: function () {
              ML.post('videos/move', { uids: uids, space_id: Number(select.value) })
                .then(function () {
                  api.close();
                  ML.toast('Moved');
                  App.loadSpaces();
                  context.reload && context.reload();
                })
                .catch(ML.toastError);
            }
          }, 'Move')
        ];
      }
    });
  }

  /* --- Library -------------------------------------------------------------- */

  Views.library = function (root, params) {
    params = params || {};
    var state = {
      filter: params.filter || 'all',
      sort: ML.storage('librarySort') || 'recent',
      q: params.q || '',
      spaceId: params.space || '',
      page: 1,
      videos: [],
      total: 0,
      hasMore: false,
      selected: {}
    };

    var gridNode = el('div.video-grid');
    var footNode = el('div.center.mt-lg');
    var bulkBar = el('div.card.pad.mb', { style: { display: 'none' } });

    var searchInput = el('input', {
      type: 'search', placeholder: 'Search titles, descriptions and transcripts…',
      value: state.q,
      oninput: ML.debounce(function (event) {
        state.q = event.target.value.trim();
        state.page = 1;
        load();
      }, 320)
    });

    var sortSelect = el('select', {
      style: { width: 'auto' },
      onchange: function (event) {
        state.sort = event.target.value;
        ML.storage('librarySort', state.sort);
        state.page = 1;
        load();
      }
    }, [
      el('option', { value: 'recent' }, 'Newest first'),
      el('option', { value: 'oldest' }, 'Oldest first'),
      el('option', { value: 'views' }, 'Most viewed'),
      el('option', { value: 'longest' }, 'Longest'),
      el('option', { value: 'title' }, 'Title A–Z')
    ]);
    sortSelect.value = state.sort;

    var filters = [
      { key: 'all', label: 'All videos' },
      { key: 'mine', label: 'My videos' },
      { key: 'shared', label: 'Shared with me' },
      { key: 'starred', label: 'Starred' }
    ];
    var chipRow = el('div.row.wrap', {}, filters.map(function (item) {
      return el('button.chip' + (state.filter === item.key ? '.active' : ''), {
        type: 'button',
        onclick: function () {
          state.filter = item.key;
          state.page = 1;
          ML.$$('.chip', chipRow).forEach(function (chip) { chip.classList.remove('active'); });
          this.classList.add('active');
          load();
        }
      }, item.label);
    }));

    var spaceName = '';
    if (state.spaceId) {
      var space = (App.state.spaces || []).filter(function (s) { return String(s.id) === String(state.spaceId); })[0];
      spaceName = space ? space.name : '';
    }

    clear(root).appendChild(el('div', {}, [
      el('div.page-head', {}, [
        el('div', {}, [
          spaceName
            ? el('div.row.tiny.muted', { style: { marginBottom: '2px' } }, [
                el('a', {
                  href: '#',
                  onclick: function (event) { event.preventDefault(); App.go('/'); }
                }, 'Library'),
                el('span', {}, '/'),
                el('span', {}, 'Folder')
              ])
            : null,
          el('div.row', {}, [
            el('h1', { text: spaceName || 'Library' }),
            spaceName
              ? el('button.btn.sm.ghost', {
                  type: 'button', title: 'Rename, recolour or delete this folder',
                  onclick: function (event) {
                    var folder = (App.state.spaces || []).filter(function (sp) {
                      return String(sp.id) === String(state.spaceId);
                    })[0];
                    if (folder) { App.folderMenu(event.currentTarget, folder); }
                  }
                }, '⋯')
              : null
          ]),
          el('p.muted.small', {
            text: spaceName
              ? 'Videos in this folder.'
              : 'Record, organise and share your videos.'
          })
        ]),
        el('div.row', {}, [
          el('button.btn', {
            type: 'button', title: 'Create a folder to group videos',
            onclick: function () { App.newSpaceDialog(function () { load(); }); }
          }, '📁 New folder'),
          el('button.btn', { type: 'button', onclick: function () { uploadDialog(load); } }, '⬆ Upload'),
          el('button.btn.primary', { type: 'button', onclick: function () { App.go('/record'); } }, '⏺ New recording')
        ])
      ]),
      el('div.toolbar', {}, [
        el('div.searchbox.grow', {}, searchInput),
        chipRow,
        sortSelect
      ]),
      bulkBar,
      gridNode,
      footNode
    ]));

    function renderBulkBar() {
      var ids = Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
      if (!ids.length) { bulkBar.style.display = 'none'; return; }
      bulkBar.style.display = '';
      clear(bulkBar).appendChild(el('div.row.between.wrap', {}, [
        el('strong', { text: ids.length + ' selected' }),
        el('div.row', {}, [
          el('button.btn.sm', { type: 'button', onclick: function () { moveDialog(ids, { reload: load }); } }, 'Move to folder'),
          el('button.btn.sm.danger', {
            type: 'button',
            onclick: function () {
              ML.confirm({
                title: 'Move ' + ids.length + ' videos to trash?',
                message: 'You can restore them from Trash later.', danger: true, confirmLabel: 'Move to trash'
              }).then(function (yes) {
                if (!yes) { return; }
                Promise.all(ids.map(function (uid) { return ML.post('videos/delete', { uid: uid }); }))
                  .then(function () { state.selected = {}; ML.toast('Moved to trash'); load(); })
                  .catch(ML.toastError);
              });
            }
          }, 'Move to trash'),
          el('button.btn.sm.ghost', {
            type: 'button',
            onclick: function () { state.selected = {}; load(); }
          }, 'Clear')
        ])
      ]));
    }

    function load() {
      if (state.page === 1) {
        clear(gridNode);
        for (var i = 0; i < 8; i++) { gridNode.appendChild(el('div.skeleton.sk-card')); }
      }
      return ML.get('videos', {
        filter: state.filter, sort: state.sort, q: state.q,
        space_id: state.spaceId, page: state.page, per_page: 24
      }).then(function (response) {
        if (state.page === 1) { state.videos = []; clear(gridNode); }
        state.videos = state.videos.concat(response.videos);
        state.total = response.total;
        state.hasMore = response.has_more;

        if (!state.videos.length) {
          clear(gridNode);
          gridNode.appendChild(el('div', { style: { gridColumn: '1/-1' } },
            ML.emptyState(
              state.q ? '🔍' : '🎬',
              state.q ? 'No videos match "' + state.q + '"' : 'No videos yet',
              state.q ? 'Try a different search term.' : 'Record your screen and it will show up here.',
              state.q ? null : el('button.btn.primary', {
                type: 'button', onclick: function () { App.go('/record'); }
              }, 'Record your first video')
            )));
        } else {
          response.videos.forEach(function (video) {
            gridNode.appendChild(videoCard(video, {
              reload: load,
              selectable: true,
              isSelected: function (uid) { return !!state.selected[uid]; },
              onSelect: function (uid, checked) { state.selected[uid] = checked; renderBulkBar(); }
            }));
          });
        }

        clear(footNode);
        if (state.hasMore) {
          footNode.appendChild(el('button.btn', {
            type: 'button',
            onclick: function () { state.page++; load(); }
          }, 'Load more'));
        } else if (state.videos.length) {
          footNode.appendChild(el('p.small.muted', {
            text: state.videos.length + ' of ' + state.total + ' video' + (state.total === 1 ? '' : 's')
          }));
        }
        renderBulkBar();
      }).catch(function (error) {
        clear(gridNode).appendChild(el('div.card.pad', {}, el('p.small', { text: error.message })));
      });
    }

    load();
  };

  /* --- Upload existing file ------------------------------------------------- */

  function uploadDialog(onDone) {
    var fileInput = el('input', { type: 'file', accept: 'video/*' });
    var bar = el('div.upload-progress', { style: { display: 'none' } }, el('i', { style: { width: '0%' } }));
    var status = el('p.hint');

    var dialog = ML.modal({
      title: 'Upload a video',
      body: [
        el('p.small.muted', {}, 'Import an existing MP4, WebM, MOV or MKV file into this workspace.'),
        el('label.field', {}, [el('span', {}, 'Video file'), fileInput]),
        bar, status
      ],
      footer: function (api) {
        return [
          el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
          el('button.btn.primary', {
            type: 'button',
            onclick: function (event) {
              var file = fileInput.files && fileInput.files[0];
              if (!file) { ML.toast('Choose a file first.', 'error'); return; }
              var button = event.target;
              button.disabled = true;
              bar.style.display = '';
              status.textContent = 'Uploading ' + ML.bytes(file.size) + '…';

              buildThumbnail(file).then(function (meta) {
                var form = new FormData();
                form.append('file', file);
                form.append('duration', meta.duration || 0);
                form.append('width', meta.width || 0);
                form.append('height', meta.height || 0);
                if (meta.thumbnail) { form.append('thumbnail_data', meta.thumbnail); }
                if (App.state.currentSpace) { form.append('space_id', App.state.currentSpace); }

                return ML.postForm('upload/file', form, function (ratio) {
                  bar.firstChild.style.width = Math.round(ratio * 100) + '%';
                });
              }).then(function (response) {
                api.close();
                ML.toast('Upload complete', 'success');
                if (onDone) { onDone(); }
                App.go('/video/' + response.uid);
              }).catch(function (error) {
                button.disabled = false;
                status.textContent = error.message;
                status.style.color = 'var(--danger)';
              });
            }
          }, 'Upload')
        ];
      }
    });
    return dialog;
  }

  /** Read duration/size and grab a poster frame from a local file. */
  function buildThumbnail(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var video = document.createElement('video');
      var settled = false;
      var finish = function (meta) {
        if (settled) { return; }
        settled = true;
        URL.revokeObjectURL(url);
        resolve(meta);
      };
      video.preload = 'metadata';
      video.muted = true;
      video.src = url;
      video.onloadeddata = function () {
        try { video.currentTime = Math.min(1.5, (video.duration || 2) / 3); } catch (e) { /* ignore */ }
      };
      video.onseeked = function () {
        var canvas = document.createElement('canvas');
        var scale = Math.min(1, 640 / (video.videoWidth || 640));
        canvas.width = Math.round((video.videoWidth || 640) * scale);
        canvas.height = Math.round((video.videoHeight || 360) * scale);
        try {
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          finish({
            duration: isFinite(video.duration) ? video.duration : 0,
            width: video.videoWidth, height: video.videoHeight,
            thumbnail: canvas.toDataURL('image/jpeg', 0.72)
          });
        } catch (e) {
          finish({ duration: isFinite(video.duration) ? video.duration : 0, width: video.videoWidth, height: video.videoHeight });
        }
      };
      video.onerror = function () { finish({}); };
      setTimeout(function () { finish({}); }, 6000);
    });
  }

  Views.uploadDialog = uploadDialog;

  /* --- Trash ---------------------------------------------------------------- */

  Views.trash = function (root) {
    var listNode = el('div.video-grid');
    clear(root).appendChild(el('div', {}, [
      el('div.page-head', {}, el('div', {}, [
        el('h1', {}, 'Trash'),
        el('p.muted.small', {}, 'Deleted videos stay here until you remove them permanently.')
      ])),
      listNode
    ]));

    function load() {
      ML.loading(listNode);
      ML.get('videos/trash').then(function (response) {
        clear(listNode);
        if (!response.videos.length) {
          listNode.appendChild(el('div', { style: { gridColumn: '1/-1' } },
            ML.emptyState('🗑', 'Trash is empty', 'Deleted videos will appear here.')));
          return;
        }
        response.videos.forEach(function (video) {
          listNode.appendChild(el('div.video-card', {}, [
            el('div.thumb', {}, video.thumbnail
              ? el('img', { src: video.thumbnail, alt: '' })
              : el('div.thumb-fallback', {}, '🎬')),
            el('div.card-meta', {}, [
              el('div.card-title', { text: video.title }),
              el('div.card-sub', {}, el('span', { text: 'Deleted ' + ML.timeAgo(video.updated_at) })),
              el('div.row.mt', {}, [
                el('button.btn.sm', {
                  type: 'button',
                  onclick: function () {
                    ML.post('videos/restore', { uid: video.uid })
                      .then(function () { ML.toast('Restored', 'success'); load(); })
                      .catch(ML.toastError);
                  }
                }, 'Restore'),
                el('button.btn.sm.danger', {
                  type: 'button',
                  onclick: function () {
                    ML.confirm({
                      title: 'Delete permanently?',
                      message: 'The video file and all of its analytics will be erased. This cannot be undone.',
                      danger: true, confirmLabel: 'Delete forever'
                    }).then(function (yes) {
                      if (!yes) { return; }
                      ML.post('videos/purge', { uid: video.uid })
                        .then(function () { ML.toast('Deleted permanently'); load(); App.refreshMe(); })
                        .catch(ML.toastError);
                    });
                  }
                }, 'Delete forever')
              ])
            ])
          ]));
        });
      }).catch(function (error) {
        clear(listNode).appendChild(el('p', { text: error.message }));
      });
    }
    load();
  };

  /* --- Workspace analytics -------------------------------------------------- */

  Views.analytics = function (root) {
    clear(root);
    var body = el('div');
    root.appendChild(el('div', {}, [
      el('div.page-head', {}, el('div', {}, [
        el('h1', {}, 'Analytics'),
        el('p.muted.small', {}, 'How your workspace is being watched.')
      ])),
      body
    ]));
    ML.loading(body);

    ML.get('analytics/overview').then(function (response) {
      var totals = response.totals;
      var daily = dailySeries(response.daily, 30);
      var maxDaily = Math.max.apply(null, daily.map(function (d) { return d.views; }).concat([1]));

      clear(body).appendChild(el('div', {}, [
        el('div.stat-grid', {}, [
          stat('Videos', totals.videos),
          stat('Total views', totals.views),
          stat('Watch time', totals.watch_human),
          stat('Content length', totals.duration_human),
          stat('Storage used', totals.storage_human)
        ]),
        el('div.card.mt-lg', {}, [
          el('div.card-head', {}, el('strong', {}, 'Views — last 30 days')),
          el('div.card-body', {}, [
            el('div.bars', {}, daily.map(function (day) {
              return el('i', {
                style: { height: Math.max(2, (day.views / maxDaily) * 100) + '%', opacity: day.views ? '.9' : '.18' },
                title: day.day + ': ' + day.views + ' views'
              });
            })),
            el('div.row.between.tiny.muted.mt', {}, [
              el('span', { text: daily[0].day }),
              el('span', { text: daily[daily.length - 1].day })
            ])
          ])
        ]),
        el('div.card.mt-lg', {}, [
          el('div.card-head', {}, el('strong', {}, 'Most watched')),
          el('div.table-wrap', {}, el('table.data', {}, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'Video'), el('th', {}, 'Length'), el('th.right', {}, 'Views')
            ])),
            el('tbody', {}, response.top.length
              ? response.top.map(function (video) {
                  return el('tr', {}, [
                    el('td', {}, el('a', {
                      href: '#', onclick: function (event) { event.preventDefault(); App.go('/video/' + video.uid); }
                    }, video.title)),
                    el('td', { text: video.duration }),
                    el('td.right', { text: String(video.views) })
                  ]);
                })
              : el('tr', {}, el('td', { colspan: '3' }, el('span.muted', {}, 'No videos yet.'))))
          ]))
        ])
      ]));
    }).catch(function (error) {
      clear(body).appendChild(el('div.card.pad', {}, el('p', { text: error.message })));
    });
  };

  /**
   * Expand a sparse [{day, views}] series into one entry per day for the last
   * `days` days, so a chart with a single data point still reads as a timeline.
   */
  function dailySeries(rows, days) {
    days = days || 30;
    var byDay = {};
    (rows || []).forEach(function (row) { byDay[row.day] = row.views; });
    var out = [];
    var cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCDate(cursor.getUTCDate() - (days - 1));
    for (var i = 0; i < days; i++) {
      var key = cursor.toISOString().slice(0, 10);
      out.push({ day: key, views: byDay[key] || 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  }

  function stat(label, value, detail) {
    return el('div.stat', {}, [
      el('div.k', { text: label }),
      el('div.v', { text: String(value) }),
      detail ? el('div.d', { text: detail }) : null
    ]);
  }

  Views.stat = stat;
  Views.dailySeries = dailySeries;
  Views.videoCard = videoCard;
})(window, document);
