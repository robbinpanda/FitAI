"use strict";
// Installable web app: service worker + "add to home screen" prompt on phones.
(() => {
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const iosSafari = ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|MicroMessenger|QQ\//.test(ua);
  const wechat = /MicroMessenger/.test(ua);
  const phone = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  let deferred = null;

  const store = {
    get() { try { return Number(localStorage.getItem('jjf-install-dismissed') || 0); } catch { return 0; } },
    set() { try { localStorage.setItem('jjf-install-dismissed', String(Date.now())); } catch {} },
  };
  const hint = () => wechat ? '点右上角 ··· 选择「在浏览器打开」，再添加到主屏幕'
    : iosSafari ? '点底部分享按钮，选择「添加到主屏幕」' : '';

  async function install(button) {
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice.catch(() => null);
      deferred = null;
      if (choice?.outcome === 'accepted') hide();
      return;
    }
    const text = hint();
    if (text && button) button.textContent = text;
  }

  // Buttons on the landing page: <button data-install hidden>.
  const buttons = [...document.querySelectorAll('[data-install]')];
  buttons.forEach(button => button.addEventListener('click', () => install(button)));
  const showButtons = () => buttons.forEach(button => { button.hidden = false; });
  if (iosSafari || wechat) showButtons();

  // Inside the app: a dismissible bar, at most once every 14 days.
  let bar = null;
  function hide() { bar?.remove(); bar = null; buttons.forEach(button => { button.hidden = true; }); }
  function showBar() {
    if (!document.body.dataset.installBar || !phone || bar || Date.now() - store.get() < 14 * 864e5) return;
    const style = document.createElement('style');
    style.textContent = '.jjf-install{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:999;display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:16px;background:#fff;color:#202020;border:1px solid #e7e7e5;box-shadow:0 12px 32px #4933212a;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}'
      + '.jjf-install img{width:36px;height:36px;border-radius:9px}.jjf-install p{flex:1;margin:0}.jjf-install small{display:block;color:#717174;font-size:12px}'
      + '.jjf-install button{border:0;border-radius:99px;padding:8px 14px;font:inherit;cursor:pointer}.jjf-install .go{background:#bd4c2c;color:#fff;font-weight:600}.jjf-install .x{background:none;color:#717174;padding:8px}';
    bar = document.createElement('div');
    bar.className = 'jjf-install';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', '添加到主屏幕');
    bar.innerHTML = '<img src="/icon-192.png?v=4" alt=""><p>添加到手机桌面<small></small></p><button class="go" type="button">添加</button><button class="x" type="button" aria-label="关闭">✕</button>';
    bar.querySelector('small').textContent = deferred ? '像 App 一样打开，记录更快' : hint();
    if (!deferred) bar.querySelector('.go').remove();
    bar.querySelector('.go')?.addEventListener('click', () => install());
    bar.querySelector('.x').addEventListener('click', () => { store.set(); hide(); });
    document.head.append(style);
    document.body.append(bar);
  }

  addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferred = event;
    showButtons();
    setTimeout(showBar, 4000);
  });
  addEventListener('appinstalled', hide);
  if (iosSafari || wechat) setTimeout(showBar, 4000);
})();
