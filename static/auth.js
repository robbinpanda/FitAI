'use strict';
let registering = false, mode = 'local', registrationOpen = false;
const el = id => document.getElementById(id);
function updateForm() {
  el('authTitle').textContent = registering ? '创建你的账号' : '欢迎回来';
  el('submitAuth').textContent = registering ? '注册并登录' : '登录';
  el('toggleAuth').textContent = registering ? '已有账号？登录' : '没有账号？注册';
  el('confirmField').hidden = !registering;
  el('confirmPassword').required = registering;
  el('password').autocomplete = registering ? 'new-password' : 'current-password';
  el('inviteField').hidden = !registering || mode !== 'server';
  el('invite').required = registering && mode === 'server';
  el('authError').textContent = '';
}
el('toggleAuth').addEventListener('click', () => { registering = !registering; updateForm(); });
el('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (registering && el('password').value !== el('confirmPassword').value) {
    el('authError').textContent = '两次输入的密码不一致'; return;
  }
  el('submitAuth').disabled = el('toggleAuth').disabled = true;
  el('authError').textContent = '';
  try {
    const res = await fetch('/api/auth/' + (registering ? 'register' : 'login'), {
      method:'POST', headers:{'Content-Type':'application/json','X-FitAI-Auth':'1'},
      body:JSON.stringify({username:el('username').value.trim(), password:el('password').value, invite:el('invite').value})
    });
    const result = await res.json();
    if (!res.ok) throw Error(result.error || '请求失败，请稍后重试');
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('fitai-account'); channel.postMessage('changed'); channel.close();
    }
    location.replace('/index.html');
  } catch(error) { el('authError').textContent = error.message; }
  finally { el('submitAuth').disabled = false; el('toggleAuth').disabled = !registrationOpen; }
});
async function bootAuth() {
  try {
    const res = await fetch('/api/auth/status', {cache:'no-store'});
    const state = await res.json();
    if (!res.ok) throw Error(state.error || '无法连接服务器');
    if (state.user) { location.replace('/index.html'); return; }
    mode = state.mode; registrationOpen = state.registration_open;
    registering = registrationOpen && new URLSearchParams(location.search).get('mode') === 'register';
    updateForm();
    el('modeHint').textContent = mode === 'server' ? '服务器版 · 邀请注册' : '本地版 · 无需邀请码';
    el('registrationHint').textContent = registrationOpen ? (mode === 'server' ? '注册需要管理员提供的邀请码，名额有限。' : '记录保存在这台电脑，每个账号独立存储。') : '当前注册未开放，请联系管理员。';
    el('submitAuth').disabled = false; el('toggleAuth').disabled = !registrationOpen;
  } catch(error) { el('authError').textContent = error.message + '；请刷新重试。'; }
}
bootAuth();
