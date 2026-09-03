/* ==========================================================================
   MyLoom app shell — boot, routing, sidebar, auth screens.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;

  var App = window.App = {
    state: {
      me: null, workspace: null, workspaces: [], spaces: [],
      currentSpace: null, unread: 0, siteName: ML.boot.siteName || 'MyLoom'
    }
  };

  var basePath = (ML.boot.basePath || '').replace(/\/$/, '');
  var appRoot = ML.$('#app');
  var contentNode = null;
  var cleanupView = null;

  /* --- Routing ------------------------------------------------------------- */

  App.href = function (path) { return basePath + path; };
  App.fileUrl = function (query) { return basePath + '/file.php?' + query; };

  App.go = function (path, replace) {
    var url = App.href(path);
    if (replace) { history.replaceState({}, '', url); } else { history.pushState({}, '', url); }
    route();
  };

  function currentPath() {
    var path = window.location.pathname;
    if (basePath && path.indexOf(basePath) === 0) { path = path.slice(basePath.length); }
    return '/' + path.replace(/^\/+/, '');
  }

  function queryParam(name) {
    return new URLSearchParams(window.location.search).get(name) || '';
  }

  window.addEventListener('popstate', route);

  // Intercept in-app links so navigation stays client-side.
  document.addEventListener('click', function (event) {
    var anchor = event.target.closest && event.target.closest('a[data-nav]');
    if (!anchor || event.metaKey || event.ctrlKey || event.button !== 0) { return; }
    event.preventDefault();
    App.go(anchor.getAttribute('data-nav'));
  });

  function route() {
    if (cleanupView) { try { cleanupView(); } catch (e) { /* ignore */ } cleanupView = null; }
    var path = currentPath();

    if (!App.state.me) {
      if (path.indexOf('/invite') === 0) { return renderInvite(); }
      if (path.indexOf('/signup') === 0) { return renderAuth('signup'); }
      if (path.indexOf('/forgot') === 0) { return renderAuth('forgot'); }
      if (path.indexOf('/reset') === 0) { return renderAuth('reset'); }
      return renderAuth('login');
    }

    renderShell();
    var match;
    App.state.currentSpace = null;

    if (path === '/' || path === '') {
      setActiveNav('library');
      cleanupView = ML.Views.library(contentNode, { q: queryParam('q') });
    } else if ((match = path.match(/^\/space\/(\d+)/))) {
      App.state.currentSpace = Number(match[1]);
      setActiveNav('space-' + match[1]);
      cleanupView = ML.Views.library(contentNode, { space: match[1] });
    } else if (path.indexOf('/record') === 0) {
      setActiveNav('record');
      cleanupView = ML.Views.record(contentNode);
    } else if ((match = path.match(/^\/video\/([A-Za-z0-9_-]+)/))) {
      setActiveNav('library');
      cleanupView = ML.Views.video(contentNode, {
        uid: match[1], tab: queryParam('tab'), isNew: queryParam('new') === '1'
      });
    } else if (path.indexOf('/analytics') === 0) {
      setActiveNav('analytics');
      cleanupView = ML.Views.analytics(contentNode);
    } else if (path.indexOf('/trash') === 0) {
      setActiveNav('trash');
      cleanupView = ML.Views.trash(contentNode);
    } else if (path.indexOf('/settings') === 0) {
      setActiveNav('settings');
      cleanupView = ML.Views.settings(contentNode, { section: path.split('/')[2] || 'profile' });
    } else if (path.indexOf('/invite') === 0) {
      renderInvite();
    } else {
      clear(contentNode).appendChild(ML.emptyState('🧭', 'Page not found',
        'That address does not exist.',
        el('button.btn.primary', { type: 'button', onclick: function () { App.go('/'); } }, 'Back to library')));
    }
  }

  /* --- Shell --------------------------------------------------------------- */

  var shellBuilt = false;
  var sidebarNode, navNode, topbarNode;

  function renderShell() {
    if (shellBuilt) { return; }
    shellBuilt = true;

    navNode = el('div.nav');
    sidebarNode = el('aside.sidebar', {}, [
      el('div.sidebar-head', {}, workspaceSwitcher()),
      el('div.record-btn', {}, el('button.btn.primary.block', {
        type: 'button', onclick: function () { App.go('/record'); closeSidebar(); }
      }, '⏺ New recording')),
      navNode,
      el('div.sidebar-foot', {}, storageBox())
    ]);

    topbarNode = el('header.topbar', {}, [
      el('button.btn.ghost.icon.mobile-only', {
        type: 'button', 'aria-label': 'Menu',
        onclick: function () { sidebarNode.classList.toggle('open'); toggleScrim(); }
      }, '☰'),
      el('div.searchbox.grow', {}, el('input', {
        type: 'search', placeholder: 'Search your library…',
        onkeydown: function (event) {
          if (event.key === 'Enter') {
            App.go('/?q=' + encodeURIComponent(event.target.value.trim()));
          }
        }
      })),
      notificationBell(),
      userMenu()
    ]);

    contentNode = el('main.content');
    clear(appRoot).appendChild(el('div.shell', {}, [
      sidebarNode,
      el('div.main', {}, [topbarNode, contentNode])
    ]));
    renderNav();
  }

  var scrim = null;
  function toggleScrim() {
    if (sidebarNode.classList.contains('open')) {
      scrim = el('div.sidebar-scrim', { onclick: closeSidebar });
      document.body.appendChild(scrim);
    } else { closeSidebar(); }
  }
  function closeSidebar() {
    sidebarNode.classList.remove('open');
    if (scrim) { scrim.remove(); scrim = null; }
  }

  function workspaceSwitcher() {
    var ws = App.state.workspace;
    var button = el('button.ws-switch', { type: 'button' }, [
      ws && ws.logo
        ? el('img.ws-logo', { src: ws.logo, alt: '' })
        : el('div.ws-logo', {}, ML.initials(ws ? ws.name : App.state.siteName)),
      el('div.grow', {}, [
        el('div.ws-name.truncate', { text: ws ? ws.name : App.state.siteName }),
        el('div.tiny.muted', { text: ws ? ws.role : '' })
      ]),
      el('span.muted', {}, '▾')
    ]);

    var wrap = el('div.dropdown', {}, button);
    button.onclick = function () {
      var open = wrap.querySelector('.dropdown-menu');
      if (open) { open.remove(); return; }
      var menu = el('div.dropdown-menu', {},
        App.state.workspaces.map(function (item) {
          return el('button.dropdown-item', {
            type: 'button',
            onclick: function () {
              ML.post('workspaces/switch', { workspace_id: item.id })
                .then(function () { return App.refreshMe(); })
                .then(function () { shellBuilt = false; route(); })
                .catch(ML.toastError);
            }
          }, [
            item.logo ? el('img.ws-logo', { src: item.logo, alt: '', style: { width: '20px', height: '20px' } })
                      : el('div.ws-logo', { style: { width: '20px', height: '20px', fontSize: '10px' } }, ML.initials(item.name)),
            el('span.grow.truncate', { text: item.name }),
            App.state.workspace && item.id === App.state.workspace.id ? el('span', {}, '✓') : null
          ]);
        }).concat([
          el('div.dropdown-sep'),
          el('button.dropdown-item', {
            type: 'button',
            onclick: function () {
              menu.remove();
              var name = el('input', { type: 'text', placeholder: 'Marketing team' });
              ML.modal({
                title: 'New workspace',
                body: el('label.field', {}, [el('span', {}, 'Workspace name'), name]),
                footer: function (api) {
                  return [
                    el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
                    el('button.btn.primary', {
                      type: 'button',
                      onclick: function () {
                        ML.post('workspaces/create', { name: name.value })
                          .then(function () { api.close(); return App.refreshMe(); })
                          .then(function () { shellBuilt = false; App.go('/'); })
                          .catch(ML.toastError);
                      }
                    }, 'Create')
                  ];
                }
              });
            }
          }, '+ New workspace')
        ]));
      wrap.appendChild(menu);
      setTimeout(function () {
        document.addEventListener('click', function close(event) {
          if (!wrap.contains(event.target)) { menu.remove(); document.removeEventListener('click', close); }
        });
      }, 10);
    };
    return wrap;
  }

  function storageBox() {
    var ws = App.state.workspace;
    if (!ws) { return el('div'); }
    return el('div', {}, [
      el('div.tiny.muted', { text: ws.storage_human + ' stored' }),
      el('div.storage-bar', {}, el('i', { style: { width: '100%', opacity: '.35' } })),
      el('a.tiny.muted', { href: '#', 'data-nav': '/settings/workspace' }, 'Workspace settings')
    ]);
  }

  function renderNav() {
    clear(navNode);
    var items = [
      { key: 'library', label: 'Library', icon: '🎬', path: '/' },
      { key: 'analytics', label: 'Analytics', icon: '📈', path: '/analytics' },
      { key: 'trash', label: 'Trash', icon: '🗑', path: '/trash' }
    ];
    items.forEach(function (item) {
      navNode.appendChild(el('button.nav-item', {
        type: 'button', dataset: { nav: item.key },
        onclick: function () { App.go(item.path); closeSidebar(); }
      }, [el('span.ico', { text: item.icon }), el('span', { text: item.label })]));
    });

    navNode.appendChild(el('div.nav-label', {}, [
      el('span', {}, 'Spaces'),
      el('button.btn.sm.ghost', {
        type: 'button', title: 'New space', style: { padding: '2px 6px' },
        onclick: function () { App.newSpaceDialog(); }
      }, '+')
    ]));

    if (!App.state.spaces.length) {
      navNode.appendChild(el('p.tiny.muted', { style: { padding: '2px 10px' } }, 'No spaces yet.'));
    }
    App.state.spaces.forEach(function (space) {
      navNode.appendChild(el('button.nav-item', {
        type: 'button', dataset: { nav: 'space-' + space.id },
        onclick: function () { App.go('/space/' + space.id); closeSidebar(); }
      }, [
        el('i.space-dot', { style: { background: space.color } }),
        el('span.truncate', { text: space.name }),
        el('span.count', { text: String(space.video_count) })
      ]));
    });

    navNode.appendChild(el('div.nav-label', {}, el('span', {}, 'Account')));
    navNode.appendChild(el('button.nav-item', {
      type: 'button', dataset: { nav: 'settings' },
      onclick: function () { App.go('/settings/profile'); closeSidebar(); }
    }, [el('span.ico', {}, '⚙️'), el('span', {}, 'Settings')]));
  }

  function setActiveNav(key) {
    ML.$$('.nav-item', navNode || document).forEach(function (node) {
      node.classList.toggle('active', node.dataset.nav === key);
    });
  }

  /* --- Notifications ------------------------------------------------------- */

  function notificationBell() {
    var button = el('button.btn.ghost.icon', { type: 'button', title: 'Notifications' }, '🔔');
    var badge = el('span.dot-badge', { style: { display: App.state.unread ? '' : 'none' } });
    var wrap = el('div.dropdown', { style: { position: 'relative' } }, [button, badge]);

    button.onclick = function () {
      var open = wrap.querySelector('.dropdown-menu');
      if (open) { open.remove(); return; }
      var menu = el('div.dropdown-menu.wide', {}, el('p.small.muted', { style: { padding: '10px' } }, 'Loading…'));
      wrap.appendChild(menu);

      ML.get('notifications').then(function (response) {
        clear(menu);
        menu.appendChild(el('div.row.between', { style: { padding: '6px 10px' } }, [
          el('strong.small', {}, 'Notifications'),
          el('button.btn.sm.ghost', {
            type: 'button',
            onclick: function () {
              ML.post('notifications/read', {}).then(function () {
                badge.style.display = 'none';
                App.state.unread = 0;
                menu.remove();
              });
            }
          }, 'Mark all read')
        ]));
        if (!response.notifications.length) {
          menu.appendChild(el('p.small.muted', { style: { padding: '10px' } }, 'Nothing yet.'));
        }
        response.notifications.forEach(function (item) {
          menu.appendChild(el('div.notif' + (item.read ? '' : '.unread'), {
            onclick: function () {
              ML.post('notifications/read', { id: item.id });
              menu.remove();
              if (item.video_uid) { App.go('/video/' + item.video_uid); }
            }
          }, [
            el('span', { text: item.type === 'comment' ? '💬' : (item.type === 'reaction' ? '😀' : '👁') }),
            el('div.grow', {}, [
              el('div.small', { text: item.body }),
              el('div.tiny.muted', { text: ML.timeAgo(item.created_at) })
            ])
          ]));
        });
        badge.style.display = response.unread ? '' : 'none';
      }).catch(function (error) {
        clear(menu).appendChild(el('p.small', { style: { padding: '10px' }, text: error.message }));
      });

      setTimeout(function () {
        document.addEventListener('click', function close(event) {
          if (!wrap.contains(event.target)) { menu.remove(); document.removeEventListener('click', close); }
        });
      }, 10);
    };
    return wrap;
  }

  function userMenu() {
    var button = el('button.btn.ghost', { type: 'button', style: { padding: '4px' } }, ML.avatar(App.state.me, 'sm'));
    var wrap = el('div.dropdown', {}, button);
    button.onclick = function () {
      var open = wrap.querySelector('.dropdown-menu');
      if (open) { open.remove(); return; }
      var menu = el('div.dropdown-menu', {}, [
        el('div', { style: { padding: '8px 11px' } }, [
          el('div.small.strong', { text: App.state.me.name }),
          el('div.tiny.muted', { text: App.state.me.email })
        ]),
        el('div.dropdown-sep'),
        el('button.dropdown-item', { type: 'button', onclick: function () { menu.remove(); App.go('/settings/profile'); } }, '⚙️ Settings'),
        el('button.dropdown-item', {
          type: 'button',
          onclick: function () {
            menu.remove();
            var themes = ['system', 'light', 'dark'];
            var next = themes[(themes.indexOf(ML.storage('theme') || 'system') + 1) % 3];
            ML.storage('theme', next);
            App.applyTheme();
            ML.toast('Theme: ' + next);
          }
        }, '🌓 Toggle theme'),
        el('div.dropdown-sep'),
        el('button.dropdown-item.danger', {
          type: 'button',
          onclick: function () {
            ML.post('auth/logout', {}).then(function () { window.location.href = App.href('/'); });
          }
        }, '↩ Sign out')
      ]);
      wrap.appendChild(menu);
      setTimeout(function () {
        document.addEventListener('click', function close(event) {
          if (!wrap.contains(event.target)) { menu.remove(); document.removeEventListener('click', close); }
        });
      }, 10);
    };
    return wrap;
  }

  /* --- Spaces -------------------------------------------------------------- */

  App.newSpaceDialog = function (onDone) {
    var name = el('input', { type: 'text', placeholder: 'Product demos' });
    var color = el('input', { type: 'color', value: '#625df5' });
    ML.modal({
      title: 'New space',
      body: [
        el('label.field', {}, [el('span', {}, 'Name'), name]),
        el('label.field', {}, [el('span', {}, 'Colour'), color])
      ],
      footer: function (api) {
        return [
          el('button.btn', { type: 'button', onclick: api.close }, 'Cancel'),
          el('button.btn.primary', {
            type: 'button',
            onclick: function () {
              if (!name.value.trim()) { ML.toast('Give it a name.', 'error'); return; }
              ML.post('spaces/create', { name: name.value, color: color.value })
                .then(function () { api.close(); return App.loadSpaces(); })
                .then(function () { renderNav(); if (onDone) { onDone(); } })
                .catch(ML.toastError);
            }
          }, 'Create space')
        ];
      }
    });
  };

  App.loadSpaces = function () {
    return ML.get('spaces').then(function (response) {
      App.state.spaces = response.spaces || [];
      if (navNode) { renderNav(); }
      return App.state.spaces;
    }).catch(function () { return []; });
  };

  /* --- Auth screens -------------------------------------------------------- */

  function renderAuth(mode) {
    var title = { login: 'Welcome back', signup: 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password' }[mode];
    var form = el('form.col');
    var message = el('p.small', { style: { display: 'none' } });

    var email = el('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@company.com' });
    var name = el('input', { type: 'text', required: true, autocomplete: 'name', placeholder: 'Your name' });
    var password = el('input', {
      type: 'password', required: true,
      autocomplete: mode === 'login' ? 'current-password' : 'new-password',
      placeholder: mode === 'signup' || mode === 'reset' ? 'At least 8 characters' : 'Your password'
    });

    if (mode === 'signup') { form.appendChild(field('Name', name)); }
    if (mode !== 'reset') { form.appendChild(field('Email', email)); }
    if (mode !== 'forgot') { form.appendChild(field('Password', password)); }

    var submit = el('button.btn.primary.block.lg', { type: 'submit' },
      { login: 'Sign in', signup: 'Create account', forgot: 'Send reset link', reset: 'Set new password' }[mode]);
    form.appendChild(submit);

    form.onsubmit = function (event) {
      event.preventDefault();
      submit.disabled = true;
      message.style.display = 'none';

      var route = { login: 'auth/login', signup: 'auth/signup', forgot: 'auth/forgot', reset: 'auth/reset' }[mode];
      var payload = { email: email.value, password: password.value, name: name.value };
      if (mode === 'signup') { payload.invite = queryParam('invite'); }
      if (mode === 'reset') { payload.token = queryParam('token'); }

      ML.post(route, payload).then(function () {
        if (mode === 'forgot') {
          submit.disabled = false;
          message.style.display = '';
          message.style.color = 'var(--ok)';
          message.textContent = 'If that email is registered, a reset link is on its way.';
          return;
        }
        return App.refreshMe().then(function () {
          shellBuilt = false;
          App.go('/', true);
        });
      }).catch(function (error) {
        submit.disabled = false;
        message.style.display = '';
        message.style.color = 'var(--danger)';
        message.textContent = error.message;
      });
    };

    var alt;
    if (mode === 'login') {
      alt = el('div.auth-alt', {}, [
        ML.boot.allowSignup ? el('span', {}, ['No account? ', link('Sign up', '/signup')]) : null,
        el('div.mt', {}, link('Forgot your password?', '/forgot'))
      ]);
    } else if (mode === 'signup') {
      alt = el('div.auth-alt', {}, ['Already have an account? ', link('Sign in', '/login')]);
    } else {
      alt = el('div.auth-alt', {}, link('Back to sign in', '/login'));
    }

    clear(appRoot).appendChild(el('div.auth-wrap', {}, [
      el('div.auth-side', {}, [
        el('div.row', { style: { gap: '10px', marginBottom: '30px' } }, [
          el('div.brand-mark', { style: { background: 'rgba(255,255,255,.28)' } }),
          el('strong', { text: App.state.siteName })
        ]),
        el('h2', {}, 'Record your screen. Share a link. See who watched.'),
        el('ul', {}, [
          el('li', {}, 'Screen, camera or both — with a live camera bubble'),
          el('li', {}, 'Unlimited length: chunks stream straight to your own server'),
          el('li', {}, 'Password-protected links, expiry dates and view caps'),
          el('li', {}, 'Viewer analytics, engagement graphs and CSV export'),
          el('li', {}, 'Timestamped comments, reactions and auto captions'),
          el('li', {}, 'Your data stays on your hosting — no per-seat fees')
        ])
      ]),
      el('div.auth-main', {}, el('div.auth-card', {}, [
        el('div.brand', {}, [el('div.brand-mark'), el('span', { text: App.state.siteName })]),
        el('h1', { text: title }),
        el('p.muted.small', {
          text: mode === 'forgot' ? 'We will email you a link to choose a new one.' : ''
        }),
        message,
        form,
        alt
      ]))
    ]));

    function field(label, input) {
      return el('label.field', {}, [el('span', { text: label }), input]);
    }
    function link(text, path) {
      return el('a', { href: App.href(path), 'data-nav': path }, text);
    }
  }

  /* --- Invite acceptance ---------------------------------------------------- */

  function renderInvite() {
    var token = queryParam('token');
    clear(appRoot);
    var card = el('div.auth-card');
    appRoot.appendChild(el('div.auth-main', { style: { minHeight: '100vh' } }, card));
    ML.loading(card);

    ML.get('workspaces/invite-info', { token: token }).then(function (info) {
      clear(card).appendChild(el('div', {}, [
        el('div.brand', {}, [el('div.brand-mark'), el('span', { text: App.state.siteName })]),
        el('h1', { text: 'Join ' + info.workspace }),
        el('p.muted', { text: info.inviter + ' invited ' + info.email + ' to collaborate.' }),
        info.signed_in
          ? el('button.btn.primary.block.lg.mt', {
              type: 'button',
              onclick: function () {
                ML.post('auth/accept-invite', { token: token })
                  .then(function () { return App.refreshMe(); })
                  .then(function () { shellBuilt = false; App.go('/'); })
                  .catch(ML.toastError);
              }
            }, 'Accept invitation')
          : el('div.mt', {}, [
              el('a.btn.primary.block.lg', { href: App.href('/signup?invite=' + encodeURIComponent(token)) }, 'Create an account'),
              el('p.auth-alt', {}, ['Already have an account? ', el('a', { href: App.href('/login') }, 'Sign in first')])
            ])
      ]));
    }).catch(function (error) {
      clear(card).appendChild(ML.emptyState('✉️', 'Invitation unavailable', error.message,
        el('a.btn', { href: App.href('/') }, 'Go to ' + App.state.siteName)));
    });
  }

  /* --- Theme --------------------------------------------------------------- */

  App.applyTheme = function () {
    var theme = ML.storage('theme') || 'system';
    if (theme === 'system') { document.documentElement.removeAttribute('data-theme'); }
    else { document.documentElement.setAttribute('data-theme', theme); }
  };

  /* --- Boot ---------------------------------------------------------------- */

  /**
   * Reload the session payload. Spaces are refetched in the same pass so that
   * signing in, switching workspace and saving settings all leave the sidebar
   * consistent with the workspace we are actually in.
   */
  App.refreshMe = function () {
    return ML.get('auth/me').then(function (data) {
      ML.setCsrf(data.csrf);
      App.state.me = data.user;
      App.state.workspace = data.workspace;
      App.state.workspaces = data.workspaces || [];
      App.state.unread = data.unread || 0;
      App.state.siteName = data.site_name || App.state.siteName;
      document.title = App.state.siteName;
      if (!data.user) {
        App.state.spaces = [];
        return data;
      }
      return App.loadSpaces().then(function () { return data; });
    });
  };

  App.applyTheme();
  App.refreshMe().then(route).catch(function (error) {
    clear(appRoot).appendChild(el('div.empty-state.tall', {}, [
      el('div.empty-icon', {}, '⚠️'),
      el('h1', {}, 'MyLoom could not start'),
      el('p', { text: error.message }),
      el('p.small.muted', {}, 'If you have just uploaded the files, open install.php to finish setup.'),
      el('a.btn.primary', { href: App.href('/install.php') }, 'Open the installer')
    ]));
  });
})(window, document);
