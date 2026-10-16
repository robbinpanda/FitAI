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
const demoPasta = document.getElementById('demoPasta');
const demoConfirm = document.getElementById('confirmFoodDemo');
demoPasta.addEventListener('change', () => {
  const ratio = Number(demoPasta.value) / 150;
  document.getElementById('pastaEnergy').textContent = Math.round(221 * ratio) + ' kcal';
  document.getElementById('foodTotal').textContent = Math.round(315 + 221 * ratio) + ' kcal';
  const fmt = n => Number(n.toFixed(1));
  document.getElementById('foodMacros').textContent = `蛋白质 ${fmt(29 + 8 * ratio)} g · 碳水 ${fmt(7 + 45 * ratio)} g · 脂肪 ${fmt(19 + ratio)} g`;
  document.getElementById('foodDemoStatus').textContent = '已更新估算，确认后再记录。';
  demoConfirm.textContent = '确认示例'; demoConfirm.disabled = false;
});
demoConfirm.addEventListener('click', () => {
  document.getElementById('foodDemoStatus').textContent = '演示完成。登录后即可保存自己的餐食记录。';
  demoConfirm.textContent = '已确认 ✓'; demoConfirm.disabled = true;
});

// Mobile: show the sticky sign-up bar once the hero call-to-action scrolls away.
const mobileCta = document.querySelector('.mobile-cta');
const heroActions = document.querySelector('.hero-actions');
if (mobileCta && heroActions && 'IntersectionObserver' in window) {
  new IntersectionObserver(([entry]) => mobileCta.classList.toggle('show', !entry.isIntersecting && entry.boundingClientRect.top < 0)).observe(heroActions);
}

// Anonymous photo trial: image is downscaled in the browser, sent once, never stored.
const trialFile = document.getElementById('trialFile');
const trialStatus = document.getElementById('trialStatus');
function shrinkImage(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取这张图片，请换一张 JPG 或 PNG')); };
    img.src = url;
  });
}
function cell(tag, text, extra) {
  const el = document.createElement(tag); el.textContent = text;
  if (extra) { const small = document.createElement('small'); small.textContent = extra; el.append(small); }
  return el;
}
function setTrialStatus(text, error) { trialStatus.textContent = text; trialStatus.classList.toggle('error', !!error); }
trialFile?.addEventListener('change', async () => {
  const file = trialFile.files[0];
  trialFile.value = '';
  if (!file) return;
  trialFile.disabled = true;
  setTrialStatus('AI 正在识别这一餐，通常需要几秒…');
  try {
    const image = await shrinkImage(file);
    const response = await fetch('/api/trial/photo', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-FitAI-Auth': '1'}, body: JSON.stringify({image})});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '识别失败，请稍后再试');
    document.getElementById('trialImage').src = image;
    document.getElementById('trialPreview').hidden = false;
    const rows = document.getElementById('foodRows');
    rows.replaceChildren(...data.items.map(item => {
      const tr = document.createElement('tr');
      tr.append(cell('th', item.name), cell('td', item.amount), cell('td', item.kcal + ' kcal'));
      tr.firstChild.scope = 'row';
      return tr;
    }));
    const t = data.total;
    document.getElementById('foodTotal').textContent = t.kcal + ' kcal';
    document.getElementById('foodMacros').textContent = `蛋白质 ${t.protein} g · 碳水 ${t.carb} g · 脂肪 ${t.fat} g`;
    document.getElementById('foodBadge').textContent = 'AI 估算 · 仅供参考';
    document.getElementById('foodDemoStatus').textContent = '注册后可以调整份量并保存到每日记录。';
    demoConfirm.textContent = '注册保存'; demoConfirm.disabled = false;
    demoConfirm.onclick = () => { location.href = document.querySelector('[data-start]').href; };
    setTrialStatus(`识别完成。今天还可以再试 ${data.remaining} 次。`);
    document.querySelector('.food-output').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) {
    setTrialStatus(error.message, true);
  } finally {
    trialFile.disabled = false;
  }
});
