"use strict";
const meals = {
  lunch: {name: '鸡胸肉时蔬饭', calories: 520, protein: 38, carb: 56, fat: 16},
  breakfast: {name: '燕麦 · 鸡蛋 · 牛奶', calories: 410, protein: 24, carb: 47, fat: 14}
};
document.querySelectorAll('[data-meal]').forEach(button => button.addEventListener('click', () => {
  const meal = meals[button.dataset.meal];
  document.querySelectorAll('[data-meal]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
  document.getElementById('demoMeal').textContent = meal.name;
  document.getElementById('demoCalories').textContent = meal.calories + ' kcal';
  document.getElementById('demoMacros').textContent = `蛋白质 ${meal.protein} g　碳水 ${meal.carb} g　脂肪 ${meal.fat} g`;
  for (const [field, factor] of [['protein', 4], ['carb', 4], ['fat', 9]]) document.getElementById(field + 'Bar').style.flexGrow = meal[field] * factor;
}));
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
  document.getElementById('demoChange').textContent = thirty ? '较示例起点 −1.7 kg' : '较示例起点 −1.2 kg';
  document.getElementById('chartTitle').textContent = days + ' 天体重波动示例，不代表减重承诺';
}));
// Only check login state; previews never request personal records or call AI.
fetch('/api/auth/status', {cache:'no-store'}).then(response => response.ok ? response.json() : null).then(state => {
  if (!state?.user) return;
  const login = document.getElementById('loginLink'); login.textContent = '我的记录'; login.href = '/index.html';
  const register = document.getElementById('registerLink'); register.textContent = '进入应用 ↗'; register.href = '/index.html';
  document.querySelectorAll('[data-start]').forEach(link => { link.href = '/index.html'; });
}).catch(() => {});
