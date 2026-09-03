/* ==========================================================================
   MyLoom comments — timestamped comments, threaded replies and reactions.
   Shared by the owner-facing video page and the public watch page.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var ML = window.ML;
  var el = ML.el, clear = ML.clear;
  var EMOJI = ['👍', '❤️', '😂', '🎉', '👏', '😮', '🔥', '💡', '✅', '🙏'];

  /**
   * CommentsPanel(container, options)
   *   options: { uid, token, player, canManage, allowComments, allowReactions,
   *              signedIn, onCount(n) }
   */
  function CommentsPanel(container, options) {
    options = options || {};
    var listNode = el('div.comment-list');
    var composerNode = el('div.composer');
    var pendingTime = null;
    var replyTo = null;
    var data = { comments: [], reactions: [] };

    function query(extra) {
      var params = extra || {};
      if (options.token) { params.token = options.token; } else { params.uid = options.uid; }
      return params;
    }

    /* --- Composer --------------------------------------------------------- */

    var textarea = el('textarea', {
      rows: 2,
      placeholder: 'Add a comment…',
      onkeydown: function (event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { submit(); }
      }
    });
    var guestName = el('input', {
      type: 'text', placeholder: 'Your name',
      value: ML.storage('guestName') || '',
      style: { marginBottom: '8px' }
    });
    var stampBtn = el('button.btn.sm', {
      type: 'button',
      title: 'Attach the current playback time',
      onclick: function () {
        if (!options.player) { return; }
        pendingTime = pendingTime === null ? options.player.currentTime() : null;
        renderComposerMeta();
      }
    }, '⏱ Timestamp');
    var stampLabel = el('span.tiny.muted');
    var replyLabel = el('span.tiny.muted');

    function renderComposerMeta() {
      stampLabel.textContent = pendingTime === null ? '' : 'at ' + ML.duration(pendingTime);
      stampBtn.classList.toggle('active', pendingTime !== null);
      replyLabel.textContent = replyTo ? 'replying to ' + (replyTo.author.name || 'comment') : '';
    }

    function submit() {
      var body = textarea.value.trim();
      if (!body) { return; }
      var payload = query({ body: body, parent_id: replyTo ? replyTo.id : 0 });
      if (pendingTime !== null) { payload.at_time = pendingTime; }
      if (!options.signedIn) {
        payload.guest_name = guestName.value.trim() || 'Guest';
        ML.storage('guestName', payload.guest_name);
      }
      textarea.disabled = true;
      ML.post('comments/create', payload)
        .then(function () {
          textarea.value = '';
          pendingTime = null;
          replyTo = null;
          renderComposerMeta();
          return load();
        })
        .catch(ML.toastError)
        .then(function () { textarea.disabled = false; textarea.focus(); });
    }

    function buildComposer() {
      clear(composerNode);
      if (!options.allowComments) {
        composerNode.appendChild(el('p.small.muted', { text: 'Comments are turned off for this video.' }));
        return;
      }
      if (!options.signedIn) { composerNode.appendChild(guestName); }
      composerNode.appendChild(textarea);
      composerNode.appendChild(el('div.row.between.mt', {}, [
        el('div.row', {}, [options.player ? stampBtn : null, stampLabel, replyLabel]),
        el('button.btn.primary.sm', { type: 'button', onclick: submit }, 'Comment')
      ]));
    }

    /* --- Rendering -------------------------------------------------------- */

    function renderComment(comment, isReply) {
      var tools = el('div.comment-tools');
      if (options.allowComments) {
        tools.appendChild(el('button', {
          type: 'button',
          onclick: function () {
            replyTo = comment;
            renderComposerMeta();
            textarea.focus();
          }
        }, 'Reply'));
      }
      if (options.allowReactions) {
        tools.appendChild(el('button', {
          type: 'button',
          onclick: function (event) { openEmojiPicker(event.target, comment.id); }
        }, 'React'));
      }
      if (comment.can_delete) {
        tools.appendChild(el('button', {
          type: 'button',
          onclick: function () {
            ML.confirm({ title: 'Delete comment?', message: 'This cannot be undone.', danger: true, confirmLabel: 'Delete' })
              .then(function (yes) {
                if (yes) { ML.post('comments/delete', { id: comment.id }).then(load).catch(ML.toastError); }
              });
          }
        }, 'Delete'));
      }
      if (options.canManage) {
        tools.appendChild(el('button', {
          type: 'button',
          onclick: function () { ML.post('comments/resolve', { id: comment.id }).then(load).catch(ML.toastError); }
        }, comment.is_resolved ? 'Unresolve' : 'Resolve'));
      }

      var reactionBar = el('div.reaction-bar', { style: { marginTop: '6px' } },
        (comment.reactions || []).map(function (reaction) {
          return el('button', {
            type: 'button',
            onclick: function () { react(reaction.emoji, comment.id); }
          }, [reaction.emoji, el('span.tiny', { text: String(reaction.count) })]);
        }));

      return el('div.comment' + (isReply ? '.reply' : ''), {
        style: comment.is_resolved ? { opacity: '.55' } : null
      }, [
        ML.avatar(comment.author, 'sm'),
        el('div.comment-body', {}, [
          el('div.comment-head', {}, [
            el('span.name', { text: comment.author.name }),
            comment.at_time !== null ? el('span.ts-chip', {
              title: 'Jump to this moment',
              onclick: function () {
                if (options.player) { options.player.seek(comment.at_time); options.player.play(); }
              }
            }, ML.duration(comment.at_time)) : null,
            el('time', { text: ML.timeAgo(comment.created_at), title: ML.dateTimeLabel(comment.created_at) }),
            comment.is_resolved ? el('span.badge.ok', {}, 'Resolved') : null
          ]),
          el('div.comment-text', { text: comment.body }),
          reactionBar.childNodes.length ? reactionBar : null,
          tools
        ])
      ]);
    }

    function render() {
      clear(listNode);
      var roots = data.comments.filter(function (c) { return !c.parent_id; });
      if (!roots.length) {
        listNode.appendChild(el('p.small.muted', { text: 'No comments yet. Be the first to leave one.' }));
      }
      roots.forEach(function (comment) {
        listNode.appendChild(renderComment(comment, false));
        data.comments
          .filter(function (c) { return c.parent_id === comment.id; })
          .forEach(function (reply) { listNode.appendChild(renderComment(reply, true)); });
      });

      if (options.player) {
        options.player.setMarkers(
          data.comments.filter(function (c) { return c.at_time !== null; })
            .map(function (c) { return { time: c.at_time, label: c.author.name + ': ' + c.body.slice(0, 40) }; })
            .concat(data.reactions.map(function (r) { return { time: r.at_time, label: r.emoji }; }))
        );
      }
      if (options.onCount) { options.onCount(data.comments.length); }
    }

    /* --- Reactions -------------------------------------------------------- */

    function react(emoji, commentId) {
      var payload = query({ emoji: emoji });
      if (commentId) { payload.comment_id = commentId; }
      else if (options.player) { payload.at_time = options.player.currentTime(); }
      return ML.post('comments/react', payload)
        .then(function () {
          if (!commentId && options.player) { options.player.floatEmoji(emoji); }
          return load();
        })
        .catch(ML.toastError);
    }

    function openEmojiPicker(anchor, commentId) {
      var existing = document.querySelector('.emoji-pop');
      if (existing) { existing.remove(); }
      var pop = el('div.dropdown-menu.emoji-pop', { style: { position: 'fixed', zIndex: '7000' } },
        el('div.emoji-picker', {}, EMOJI.map(function (emoji) {
          return el('button', {
            type: 'button',
            onclick: function () { pop.remove(); react(emoji, commentId); }
          }, emoji);
        })));
      document.body.appendChild(pop);
      var rect = anchor.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(window.innerWidth - 230, rect.left)) + 'px';
      pop.style.top = (rect.bottom + 6) + 'px';
      setTimeout(function () {
        document.addEventListener('click', function close(event) {
          if (!pop.contains(event.target)) { pop.remove(); document.removeEventListener('click', close); }
        });
      }, 10);
    }

    /* --- Loading ---------------------------------------------------------- */

    function load() {
      return ML.get('comments', query())
        .then(function (response) {
          data.comments = response.comments || [];
          data.reactions = response.reactions || [];
          render();
          return data;
        })
        .catch(function (error) {
          clear(listNode).appendChild(el('p.small.muted', { text: error.message }));
        });
    }

    /* --- Mount ------------------------------------------------------------ */

    var reactionRow = options.allowReactions
      ? el('div.emoji-picker', { style: { marginBottom: '10px' } }, EMOJI.slice(0, 6).map(function (emoji) {
          return el('button', {
            type: 'button', title: 'React at the current moment',
            onclick: function () { react(emoji, null); }
          }, emoji);
        }))
      : null;

    clear(container);
    container.appendChild(el('div', {}, [reactionRow, composerNode, el('hr'), listNode]));
    buildComposer();
    load();

    return {
      reload: load,
      react: react,
      setPlayer: function (player) { options.player = player; render(); }
    };
  }

  ML.CommentsPanel = CommentsPanel;
  ML.EMOJI = EMOJI;
})(window, document);
