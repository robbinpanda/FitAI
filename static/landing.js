"use strict";
const lines = {
  14: 'M45 54L84 69L122 61L160 87L198 80L236 97L274 87L312 114L350 106L388 119L426 110L464 122L502 111L536 118',
  30: 'M45 43L63 53L80 48L98 64L116 58L134 78L152 69L170 89L188 80L206 74L224 91L242 85L260 103L278 96L296 90L314 110L332 103L350 120L368 114L386 108L404 125L422 119L440 135L458 126L476 120L494 133L512 127L536 135'
};
document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => {
  const days = button.dataset.range, thirty = days === '30';
  document.querySelectorAll('[data-range]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
  document.getElementById('chartLine').setAttribute('d', lines[days]);
  document.getElementById('chartArea').setAttribute('d', lines[days] + 'V194H45Z');
  document.getElementById('chartDot').setAttribute('cy', thirty ? '135' : '118');
  document.getElementById('chartMid').textContent = thirty ? '第 15 天' : '第 7 天';
  document.getElementById('chartEnd').textContent = '第 ' + days + ' 天';
  document.getElementById('demoWeight').textContent = thirty ? '68.1' : '68.4';
  document.getElementById('demoChange').textContent = thirty ? '较起点 −1.7 kg' : '较起点 −1.2 kg';
  document.getElementById('chartTitle').textContent = days + ' 天体重波动示例，不代表减重承诺';
}));
// Only check login state; previews never request personal records or call AI.
fetch('/api/auth/status', {cache:'no-store'}).then(response => response.ok ? response.json() : null).then(state => {
  if (!state?.user) return;
  const login = document.getElementById('loginLink'); login.textContent = '我的记录'; login.href = '/index.html';
  const register = document.getElementById('registerLink'); register.textContent = '进入应用 ↗'; register.href = '/index.html';
  document.querySelectorAll('[data-start]').forEach(link => { link.href = '/index.html'; });
}).catch(() => {});

// Interactive product preview: no upload, API request or personal record is created.
const demoRice = document.getElementById('demoRice');
const demoConfirm = document.getElementById('confirmFoodDemo');
demoRice.addEventListener('change', () => {
  const ratio = Number(demoRice.value) / 150;
  document.getElementById('riceEnergy').textContent = Math.round(201 * ratio) + ' kcal';
  document.getElementById('foodTotal').textContent = Math.round(319 + 201 * ratio) + ' kcal';
  const fmt = n => Number(n.toFixed(1));
  document.getElementById('foodMacros').textContent = `蛋白质 ${fmt(34 + 4 * ratio)} g · 碳水 ${fmt(12 + 44 * ratio)} g · 脂肪 ${fmt(15 + ratio)} g`;
  document.getElementById('foodDemoStatus').textContent = '已更新估算，确认后再记录。';
  demoConfirm.textContent = '确认示例'; demoConfirm.disabled = false;
});
demoConfirm.addEventListener('click', () => {
  document.getElementById('foodDemoStatus').textContent = '演示完成。登录后即可保存自己的餐食记录。';
  demoConfirm.textContent = '已确认 ✓'; demoConfirm.disabled = true;
});
