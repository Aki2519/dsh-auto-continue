window.__ModuleLoader__.load({ id: 'dsh-auto-continue', factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  /**
   * dsh-auto-continue web client half: poll the host's
   * /api/auto-continue/status endpoint after boot; when the host resumed an
   * unfinished session, surface a visible banner with an "open session"
   * action (plus a system notification when the browser allows it).
   * Zero runtime dependencies: plain DOM + fetch only.
   */
  var name = 'dsh-auto-continue';
  var inject = ['sessions'];

  var POLL_INTERVAL_MS = 2000;
  var POLL_TRIES = 20;
  var BANNER_TTL_MS = 30000;
  var banner = null;

  function closeBanner() {
    if (banner !== null) {
      banner.remove();
      banner = null;
    }
  }

  function showBanner(ctx, sessionId, extraCount) {
    closeBanner();
    var root = document.createElement('div');
    root.style.cssText = [
      'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:99999', 'display:flex', 'align-items:center', 'gap:12px',
      'padding:10px 14px', 'border-radius:10px',
      'background:rgba(13,30,58,0.96)', 'color:#e8f1ff',
      'font:13px/1.5 system-ui,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,0.35)',
      'max-width:min(92vw,560px)',
    ].join(';');

    var text = document.createElement('span');
    text.textContent = '已自动恢复上次未完成的任务（会话 ' + sessionId.slice(0, 22)
      + '…' + (extraCount > 0 ? '，另有 ' + extraCount + ' 个未完成' : '')
      + '），agent 正在后台继续执行';
    text.style.flex = '1';

    var open = document.createElement('button');
    open.textContent = '打开会话';
    open.style.cssText = [
      'border:0', 'border-radius:6px', 'padding:5px 12px', 'cursor:pointer',
      'background:#4d8fd4', 'color:#fff', 'font:inherit', 'white-space:nowrap',
    ].join(';');
    open.addEventListener('click', function () {
      try {
        ctx.sessions.open(sessionId);
      } catch (error) {
        /* navigation is best-effort */
      }
      closeBanner();
    });

    var close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭');
    close.style.cssText = [
      'border:0', 'background:none', 'color:#9fb4d6', 'cursor:pointer',
      'font:16px/1 sans-serif', 'padding:2px 6px',
    ].join(';');
    close.addEventListener('click', closeBanner);

    root.append(text, open, close);
    document.body.appendChild(root);
    banner = root;
    setTimeout(closeBanner, BANNER_TTL_MS);
  }

  function apply(ctx) {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > POLL_TRIES) {
        clearInterval(timer);
        return;
      }
      var rows;
      fetch('/api/auto-continue/status')
        .then(function (response) {
          if (!response.ok) throw new Error('status not ready');
          return response.json();
        })
        .then(function (data) {
          rows = data.resumed;
          clearInterval(timer);
          if (!Array.isArray(rows) || rows.length === 0) return;
          showBanner(ctx, rows[0].sessionId, rows.length - 1);
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              new Notification('任务已自动恢复', {
                body: '会话 ' + rows[0].sessionId + ' 的未完成任务已由 dsh-auto-continue 恢复，agent 正在后台继续。',
              });
            } catch (error) {
              /* notification is best-effort */
            }
          }
        })
        .catch(function () {
          /* keep polling */
        });
    }, POLL_INTERVAL_MS);
  }

  module.exports = { name: name, inject: inject, apply: apply };
  return module.exports;
}});
