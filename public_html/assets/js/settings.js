/* ==========================================================================
   MyLoom settings — profile, workspace branding, members and admin tools.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var Views = ML.Views = ML.Views || {};

  Views.settings = function (root, params) {
    var section = params.section || 'profile';
    var paneNode = el('div.grow');

    var items = [
      { key: 'profile', label: '👤 Profile' },
      { key: 'workspace', label: '🏢 Workspace' },
      { key: 'members', label: '👥 Members' },
      { key: 'notifications', label: '🔔 Notifications' }
    ];
    if (App.state.me && App.state.me.is_admin) {
      items.push({ key: 'admin', label: '🛠 Instance admin' });
    }

    var nav = el('div.settings-nav', {}, items.map(function (item) {
      return el('button.nav-item' + (section === item.key ? '.active' : ''), {
        type: 'button',
        onclick: function () {
          section = item.key;
          ML.$$('.nav-item', nav).forEach(function (node) { node.classList.remove('active'); });
          this.classList.add('active');
          history.replaceState({}, '', App.href('/settings/' + section));
          renderSection();
        }
      }, item.label);
    }));

    clear(root).appendChild(el('div', {}, [
      el('div.page-head', {}, el('div', {}, [
        el('h1', {}, 'Settings'),
        el('p.muted.small', {}, 'Your account, your workspace and who can use it.')
      ])),
      el('div.settings-layout', {}, [nav, paneNode])
    ]));

    function renderSection() {
      clear(paneNode);
      ({
        profile: profile, workspace: workspace, members: members,
        notifications: notifications, admin: admin
      }[section] || profile)(paneNode);
    }
    renderSection();

    /* --- Profile ----------------------------------------------------------- */

    function profile(node) {
      var me = App.state.me;
      var name = el('input', { type: 'text', value: me.name });
      var timezone = el('select', {}, timezones().map(function (zone) {
        return el('option', { value: zone }, zone);
      }));
      timezone.value = me.timezone || 'UTC';

      var avatarPreview = ML.avatar(me, 'lg');
      var avatarData = null;
      var avatarInput = el('input', {
        type: 'file', accept: 'image/*',
        onchange: function (event) {
          var file = event.target.files[0];
          if (!file) { return; }
          var reader = new FileReader();
          reader.onload = function () {
            avatarData = reader.result;
            var img = el('img.avatar.lg', { src: avatarData, alt: '' });
            avatarPreview.replaceWith(img);
            avatarPreview = img;
          };
          reader.readAsDataURL(file);
        }
      });

      var currentPassword = el('input', { type: 'password', autocomplete: 'current-password' });
      var newPassword = el('input', { type: 'password', autocomplete: 'new-password' });

      node.appendChild(el('div.settings-max', {}, [
        el('div.section', {}, [
          el('h3', {}, 'Your profile'),
          el('div.row.gap-lg.mb', {}, [avatarPreview, el('div.grow', {}, [
            el('label.field', {}, [el('span', {}, 'Profile picture'), avatarInput])
          ])]),
          el('label.field', {}, [el('span', {}, 'Name'), name]),
          el('label.field', {}, [el('span', {}, 'Email'), el('input', { type: 'email', value: me.email, disabled: true })]),
          el('label.field', {}, [el('span', {}, 'Time zone'), timezone]),
          el('button.btn.primary', {
            type: 'button',
            onclick: function (event) {
              var button = event.target;
              button.disabled = true;
              ML.post('auth/profile', {
                name: name.value, timezone: timezone.value, avatar_data: avatarData || ''
              }).then(function () {
                ML.toast('Profile saved', 'success');
                return App.refreshMe();
              }).catch(ML.toastError).then(function () { button.disabled = false; });
            }
          }, 'Save profile')
        ]),
        el('div.section', {}, [
          el('h3', {}, 'Change password'),
          el('label.field', {}, [el('span', {}, 'Current password'), currentPassword]),
          el('label.field', {}, [el('span', {}, 'New password'), newPassword, el('div.hint', {}, 'At least 8 characters.')]),
          el('button.btn', {
            type: 'button',
            onclick: function () {
              ML.post('auth/password', { current_password: currentPassword.value, password: newPassword.value })
                .then(function () {
                  ML.toast('Password updated', 'success');
                  currentPassword.value = '';
                  newPassword.value = '';
                })
                .catch(ML.toastError);
            }
          }, 'Update password')
        ]),
        el('div.section', {}, [
          el('h3', {}, 'Appearance'),
          el('div.btn-group', {}, ['system', 'light', 'dark'].map(function (theme) {
            return el('button.btn' + ((ML.storage('theme') || 'system') === theme ? '.active' : ''), {
              type: 'button',
              onclick: function () {
                ML.storage('theme', theme);
                App.applyTheme();
                renderSection();
              }
            }, theme.charAt(0).toUpperCase() + theme.slice(1));
          }))
        ])
      ]));
    }

    /* --- Workspace / branding ---------------------------------------------- */

    function workspace(node) {
      var ws = App.state.workspace;
      if (!ws) { node.appendChild(el('p', {}, 'No workspace selected.')); return; }
      var canEdit = ws.role === 'owner' || ws.role === 'admin';

      var name = el('input', { type: 'text', value: ws.name, disabled: !canEdit });
      var accent = el('input', { type: 'color', value: ws.accent_color || '#625df5', disabled: !canEdit });
      var hideBranding = el('input', { type: 'checkbox', checked: ws.hide_branding, disabled: !canEdit });
      var ctaLabel = el('input', { type: 'text', value: ws.cta_label || '', placeholder: 'Book a demo', disabled: !canEdit });
      var ctaUrl = el('input', { type: 'url', value: ws.cta_url || '', placeholder: 'https://…', disabled: !canEdit });

      var logoPreview = ws.logo
        ? el('img', { src: ws.logo, alt: '', style: { maxHeight: '44px', borderRadius: '8px' } })
        : el('div.ws-logo', {}, ML.initials(ws.name));
      var logoData = null;
      var removeLogo = false;
      var logoInput = el('input', {
        type: 'file', accept: 'image/*', disabled: !canEdit,
        onchange: function (event) {
          var file = event.target.files[0];
          if (!file) { return; }
          var reader = new FileReader();
          reader.onload = function () {
            logoData = reader.result;
            removeLogo = false;
            var img = el('img', { src: logoData, alt: '', style: { maxHeight: '44px', borderRadius: '8px' } });
            logoPreview.replaceWith(img);
            logoPreview = img;
          };
          reader.readAsDataURL(file);
        }
      });

      node.appendChild(el('div.settings-max', {}, [
        el('div.section', {}, [
          el('h3', {}, 'Workspace'),
          el('p.hint', {}, 'Your role: ' + ws.role + (canEdit ? '' : ' — only owners and admins can change these settings.')),
          el('label.field', {}, [el('span', {}, 'Name'), name]),
          el('div.row.gap-lg.mb', {}, [logoPreview, el('div.grow', {}, [
            el('label.field', {}, [el('span', {}, 'Logo'), logoInput,
              el('div.hint', {}, 'Shown on watch pages and in emails.')])
          ])]),
          ws.logo && canEdit ? el('button.btn.sm', {
            type: 'button',
            onclick: function () { removeLogo = true; logoData = null; ML.toast('Logo will be removed when you save.'); }
          }, 'Remove logo') : null,
          el('label.field.mt', {}, [el('span', {}, 'Accent colour'), el('div.row', {}, [accent,
            el('span.small.muted', {}, 'Used for buttons and the player progress bar.')])])
        ]),
        el('div.section', {}, [
          el('h3', {}, 'Default call to action'),
          el('p.hint', {}, 'Applied to new recordings; each video can override it.'),
          el('label.field', {}, [el('span', {}, 'Button label'), ctaLabel]),
          el('label.field', {}, [el('span', {}, 'Button URL'), ctaUrl]),
          el('label.check', {}, [hideBranding, el('span', {}, ['Hide “Powered by” branding on watch pages',
            el('span.check-sub', {}, 'Your own logo is shown instead.')])])
        ]),
        el('div.section', {}, [
          el('h3', {}, 'Storage'),
          el('p.small', { text: ws.storage_human + ' used by this workspace.' }),
          el('p.hint', {}, 'Recordings live in _storage on your server; free space is limited by your hosting plan.')
        ]),
        canEdit ? el('button.btn.primary', {
          type: 'button',
          onclick: function (event) {
            var button = event.target;
            button.disabled = true;
            ML.post('workspaces/update', {
              name: name.value,
              accent_color: accent.value,
              hide_branding: hideBranding.checked,
              cta_label: ctaLabel.value,
              cta_url: ctaUrl.value,
              logo_data: logoData || '',
              remove_logo: removeLogo
            }).then(function () {
              ML.toast('Workspace saved', 'success');
              return App.refreshMe();
            }).then(function () { renderSection(); })
              .catch(ML.toastError)
              .then(function () { button.disabled = false; });
          }
        }, 'Save workspace') : null,
        el('div.section.mt-lg', {}, [
          el('h3', {}, 'Folders'),
          el('p.hint', {}, 'Folders group videos inside this workspace. You can also manage them '
            + 'from the sidebar.'),
          spacesEditor()
        ])
      ]));
    }

    function spacesEditor() {
      var listNode = el('div.col');
      function render() {
        clear(listNode);
        (App.state.spaces || []).forEach(function (space) {
          listNode.appendChild(el('div.row.between', {}, [
            el('div.row', {}, [
              el('i.space-dot', { style: { background: space.color } }),
              el('span', { text: space.name }),
              el('span.tiny.muted', { text: space.video_count + ' videos' })
            ]),
            el('div.row', {}, [
              el('button.btn.sm.ghost', {
                type: 'button',
                onclick: function () {
                  App.editSpaceDialog(space, render);
                }
              }, 'Rename'),
              el('button.btn.sm.ghost', {
                type: 'button',
                onclick: function () {
                  ML.confirm({
                    title: 'Delete folder “' + space.name + '”?',
                    message: 'Videos inside it move back to the library root; nothing is deleted.',
                    danger: true, confirmLabel: 'Delete folder'
                  }).then(function (yes) {
                    if (!yes) { return; }
                    ML.post('spaces/delete', { id: space.id })
                      .then(function () { return App.loadSpaces(); })
                      .then(render).catch(ML.toastError);
                  });
                }
              }, 'Delete')
            ])
          ]));
        });
        if (!(App.state.spaces || []).length) {
          listNode.appendChild(el('p.small.muted', {}, 'No folders yet.'));
        }
        listNode.appendChild(el('button.btn.sm.mt', {
          type: 'button',
          onclick: function () { App.newSpaceDialog(function () { render(); }); }
        }, '+ New folder'));
      }
      render();
      return listNode;
    }

    /* --- Members ----------------------------------------------------------- */

    function members(node) {
      var body = el('div');
      node.appendChild(el('div', {}, body));
      ML.loading(body);

      ML.get('workspaces/members').then(function (response) {
        var canManage = App.state.workspace &&
          (App.state.workspace.role === 'owner' || App.state.workspace.role === 'admin');

        clear(body).appendChild(el('div', {}, [
          el('div.card', {}, [
            el('div.card-head', {}, [
              el('strong', {}, 'Members (' + response.members.length + ')'),
              canManage ? el('button.btn.sm.primary', { type: 'button', onclick: inviteDialog }, '+ Invite') : null
            ]),
            el('div.table-wrap', {}, el('table.data', {}, [
              el('thead', {}, el('tr', {}, [
                el('th', {}, 'Person'), el('th', {}, 'Role'), el('th.right', {}, 'Videos'), el('th', {}, '')
              ])),
              el('tbody', {}, response.members.map(function (member) {
                var roleSelect = el('select', {
                  style: { width: 'auto' },
                  disabled: !canManage || member.role === 'owner',
                  onchange: function (event) {
                    ML.post('workspaces/member-role', { member_id: member.id, role: event.target.value })
                      .then(function () { ML.toast('Role updated', 'success'); })
                      .catch(ML.toastError);
                  }
                }, ['owner', 'admin', 'member', 'viewer'].map(function (role) {
                  return el('option', { value: role, disabled: role === 'owner' }, role);
                }));
                roleSelect.value = member.role;

                return el('tr', {}, [
                  el('td', {}, el('div.row', {}, [
                    ML.avatar(member, 'sm'),
                    el('div', {}, [
                      el('div', { text: member.name }),
                      el('div.tiny.muted', { text: member.email })
                    ])
                  ])),
                  el('td', {}, roleSelect),
                  el('td.right', { text: String(member.video_count) }),
                  el('td.right', {}, canManage && member.role !== 'owner'
                    ? el('button.btn.sm.danger', {
                        type: 'button',
                        onclick: function () {
                          ML.confirm({
                            title: 'Remove ' + member.name + '?',
                            message: 'Their videos stay in the workspace.', danger: true, confirmLabel: 'Remove'
                          }).then(function (yes) {
                            if (!yes) { return; }
                            ML.post('workspaces/member-remove', { member_id: member.id })
                              .then(function () { renderSection(); })
                              .catch(ML.toastError);
                          });
                        }
                      }, 'Remove')
                    : null)
                ]);
              }))
            ]))
          ]),

          response.invites.length ? el('div.card.mt-lg', {}, [
            el('div.card-head', {}, el('strong', {}, 'Pending invitations')),
            el('div.table-wrap', {}, el('table.data', {}, [
              el('thead', {}, el('tr', {}, [el('th', {}, 'Email'), el('th', {}, 'Role'), el('th', {}, 'Expires'), el('th', {}, '')])),
              el('tbody', {}, response.invites.map(function (invite) {
                return el('tr', {}, [
                  el('td', { text: invite.email }),
                  el('td', { text: invite.role }),
                  el('td', { text: ML.dateLabel(invite.expires_at) }),
                  el('td.right', {}, el('div.row.end', {}, [
                    el('button.btn.sm', { type: 'button', onclick: function () { ML.copy(invite.link); } }, 'Copy link'),
                    el('button.btn.sm.danger', {
                      type: 'button',
                      onclick: function () {
                        ML.post('workspaces/invite-revoke', { invite_id: invite.id })
                          .then(function () { renderSection(); }).catch(ML.toastError);
                      }
                    }, 'Revoke')
                  ]))
                ]);
              }))
            ]))
          ]) : null,

          el('div.card.pad.mt-lg', {}, [
            el('h3', {}, 'Roles'),
            el('ul.small.muted', { style: { paddingLeft: '18px', margin: 0 } }, [
              el('li', {}, 'Owner — full control, cannot be removed.'),
              el('li', {}, 'Admin — manage members, branding and every video.'),
              el('li', {}, 'Member — record, upload and manage their own videos.'),
              el('li', {}, 'Viewer — watch and comment only.')
            ])
          ])
        ]));
      }).catch(function (error) {
        clear(body).appendChild(el('p', { text: error.message }));
      });

      function inviteDialog() {
        var email = el('input', { type: 'email', placeholder: 'teammate@company.com' });
        var role = el('select', {}, [
          el('option', { value: 'member' }, 'Member — can record and share'),
          el('option', { value: 'admin' }, 'Admin — can manage the workspace'),
          el('option', { value: 'viewer' }, 'Viewer — watch and comment only')
        ]);
        ML.modal({
          title: 'Invite someone',
          body: [
            el('label.field', {}, [el('span', {}, 'Email address'), email]),
            el('label.field', {}, [el('span', {}, 'Role'), role]),
            el('p.hint', {}, 'We email them a link. If mail is not configured on your host, copy the link we show you afterwards.')
          ],
          footer: function (api) {
            return [
              el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
              el('button.btn.primary', {
                type: 'button',
                onclick: function () {
                  ML.post('workspaces/invite', { email: email.value, role: role.value })
                    .then(function (response) {
                      api.close();
                      ML.modal({
                        title: 'Invitation created',
                        body: [
                          el('p.small', {}, response.emailed
                            ? 'We emailed the invitation. You can also share this link directly:'
                            : 'Email could not be sent from this server — share this link directly:'),
                          ML.copyField(response.link)
                        ],
                        footer: function (inner) { return el('button.btn.primary', { type: 'button', onclick: inner.close }, 'Done'); }
                      });
                      renderSection();
                    })
                    .catch(ML.toastError);
                }
              }, 'Send invite')
            ];
          }
        });
      }
    }

    /* --- Notifications ----------------------------------------------------- */

    function notifications(node) {
      var me = App.state.me;
      var view = el('input', { type: 'checkbox', checked: me.notify_view });
      var comment = el('input', { type: 'checkbox', checked: me.notify_comment });
      var reaction = el('input', { type: 'checkbox', checked: me.notify_reaction });

      node.appendChild(el('div.settings-max', {}, [
        el('div.section', {}, [
          el('h3', {}, 'Email me when…'),
          el('label.check', {}, [view, el('span', {}, 'Someone watches one of my videos')]),
          el('label.check', {}, [comment, el('span', {}, 'Someone comments on my videos')]),
          el('label.check', {}, [reaction, el('span', {}, 'Someone reacts to my videos')]),
          el('p.hint.mt', {}, 'In-app notifications always appear in the bell menu.'),
          el('button.btn.primary.mt', {
            type: 'button',
            onclick: function () {
              ML.post('auth/profile', {
                notify_view: view.checked, notify_comment: comment.checked, notify_reaction: reaction.checked
              }).then(function () { ML.toast('Preferences saved', 'success'); return App.refreshMe(); })
                .catch(ML.toastError);
            }
          }, 'Save preferences')
        ])
      ]));
    }

    /* --- Instance admin ----------------------------------------------------- */

    function admin(node) {
      var body = el('div');
      node.appendChild(body);
      ML.loading(body);

      ML.get('admin/stats').then(function (stats) {
        var siteName = el('input', { type: 'text', value: stats.settings.site_name });
        var aiKey = el('input', { type: 'password', placeholder: stats.settings.ai_configured ? 'configured — leave blank to keep' : 'sk-…' });
        var aiBase = el('input', { type: 'text', value: stats.settings.ai_base_url });
        var aiModel = el('input', { type: 'text', value: stats.settings.ai_model });

        clear(body).appendChild(el('div.settings-max', {}, [
          el('div.stat-grid.mb', {}, [
            Views.stat('Users', stats.users),
            Views.stat('Workspaces', stats.workspaces),
            Views.stat('Videos', stats.videos),
            Views.stat('Views', stats.views),
            Views.stat('Media stored', stats.storage),
            Views.stat('Disk free', stats.free_space)
          ]),
          el('div.section', {}, [
            el('h3', {}, 'Instance'),
            el('label.field', {}, [el('span', {}, 'Site name'), siteName]),
            el('p.hint', {}, 'PHP ' + stats.php + ' · max upload ' + stats.settings.max_upload_mb + ' MB · '
              + (stats.settings.smtp_host ? 'SMTP via ' + stats.settings.smtp_host : 'mail() for email')),
            el('p.hint', {}, 'Sign-ups and SMTP live in _app/config.local.php.')
          ]),
          el('div.section', {}, [
            el('h3', {}, 'AI summaries (optional)'),
            el('p.hint', {}, 'Point this at any OpenAI-compatible endpoint to generate titles, summaries and chapters '
              + 'from transcripts. Without a key, MyLoom uses a built-in offline summariser.'),
            el('label.field', {}, [el('span', {}, 'API key'), aiKey]),
            el('label.field', {}, [el('span', {}, 'Base URL'), aiBase]),
            el('label.field', {}, [el('span', {}, 'Model'), aiModel]),
            el('button.btn.primary', {
              type: 'button',
              onclick: function () {
                var payload = { site_name: siteName.value, ai_base_url: aiBase.value, ai_model: aiModel.value };
                if (aiKey.value) { payload.ai_api_key = aiKey.value; }
                ML.post('admin/settings', payload)
                  .then(function () { ML.toast('Settings saved', 'success'); })
                  .catch(ML.toastError);
              }
            }, 'Save settings')
          ]),
          el('div.section', {}, [el('h3', {}, 'Users'), usersTable()])
        ]));
      }).catch(function (error) {
        clear(body).appendChild(el('p', { text: error.message }));
      });

      function usersTable() {
        var wrap = el('div');
        ML.get('admin/users').then(function (response) {
          clear(wrap).appendChild(el('div.table-wrap', {}, el('table.data', {}, [
            el('thead', {}, el('tr', {}, [
              el('th', {}, 'Name'), el('th', {}, 'Email'), el('th.right', {}, 'Videos'),
              el('th', {}, 'Last login'), el('th', {}, '')
            ])),
            el('tbody', {}, response.users.map(function (user) {
              return el('tr', { style: Number(user.is_active) ? null : { opacity: '.5' } }, [
                el('td', {}, [user.name, Number(user.is_admin) ? el('span.badge.accent', { style: { marginLeft: '6px' } }, 'admin') : null]),
                el('td', { text: user.email }),
                el('td.right', { text: String(user.videos) }),
                el('td', { text: user.last_login_at ? ML.timeAgo(user.last_login_at) : 'never' }),
                el('td.right', {}, el('button.btn.sm', {
                  type: 'button',
                  onclick: function () {
                    ML.post('admin/user-toggle', { id: user.id })
                      .then(function () { renderSection(); }).catch(ML.toastError);
                  }
                }, Number(user.is_active) ? 'Deactivate' : 'Activate'))
              ]);
            }))
          ])));
        }).catch(function (error) {
          wrap.appendChild(el('p', { text: error.message }));
        });
        return wrap;
      }
    }
  };

  /** A short, useful time-zone list plus whatever the browser reports. */
  function timezones() {
    var common = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'America/Sao_Paulo', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
      'Europe/Moscow', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Karachi',
      'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo',
      'Asia/Seoul', 'Australia/Sydney', 'Pacific/Auckland'];
    try {
      var local = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (local && common.indexOf(local) === -1) { common.unshift(local); }
    } catch (e) { /* ignore */ }
    return common;
  }
})(window, document);
