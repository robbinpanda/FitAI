'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const TODAY = new Date().toLocaleDateString('sv-SE');
const S = { date: TODAY, page: 'chat', token: '', state: null, history: [], sessions: [], sessionId: null, messages: [], images: [], range: 14, busy: false, currentTool: null, currentRecord: null, recordingIntent: '' };
const pageMeta = { chat: ['私人减脂助手', '和 渐渐飞 聊聊'], today: ['每日快照', '今日概要'], trend: ['长期变化', '趋势'] };
const undoRecords = [];

function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function round(v, d = 0) { const p = 10 ** d; return Math.round(num(v) * p) / p; }
function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }
function isoDate(d) { return d.toLocaleDateString('sv-SE'); }
function dayObj(value = S.date) { return new Date(`${value}T12:00:00`); }
function unit() { return (S.state?.display_unit || 'kcal').toLowerCase() === 'kj' ? 'kJ' : 'kcal'; }
function energy(kj, digits = 0) { return kj == null ? null : round(unit() === 'kcal' ? num(kj) / 4.184 : num(kj), digits); }
function energyText(kj, digits = 0) { const value = energy(kj, digits); return value == null ? '—' : `${value} ${unit()}`; }

const api = {
  async get(path) {
    const res = await fetch(path, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.replace('/auth.html'); throw new Error('登录已失效'); }
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  },
  async post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FitAI-Token': S.token }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.replace('/auth.html'); throw new Error('登录已失效'); }
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }
};

let toastTimer;
let streamController = null;
let followChat = true;
let chatPaintPending = false;
function chatAtBottom() { const el = $('#messageScroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 90; }
function scheduleChatPaint() {
  if (chatPaintPending) return;
  chatPaintPending = true;
  requestAnimationFrame(() => {
    chatPaintPending = false;
    const el = $('#streamText');
    if (el) el.textContent = S.messages.find(m => m.streaming)?.content || '';
    if (followChat) scrollChat();
  });
}

async function streamAgent(body, onEvent, signal) {
  const response = await fetch('/api/agent', {method:'POST', signal,
    headers:{'Content-Type':'application/json','X-FitAI-Token':S.token}, body:JSON.stringify({...body,stream:true})});
  if (response.status === 401) { location.replace('/auth.html'); throw new Error('登录已失效'); }
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result = null;
  try {
    while (true) {
      const {value,done} = await reader.read();
      buffer += decoder.decode(value, {stream:!done});
      buffer = buffer.replace(/\r\n/g,'\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2);
        const lines = frame.split('\n');
        const kind = lines.find(l=>l.startsWith('event:'))?.slice(6).trim();
        const raw = lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (kind === 'error') throw new Error(data.error || '生成失败，请重试');
        if (kind === 'done') result = data;
        else onEvent(kind,data);
      }
      if (result) { await reader.cancel(); return result; }
      if (done) break;
    }
    throw new Error('连接已中断，回复尚未完成，请重试');
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
function toast(text) { const el = $('#toast'); el.textContent = text; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2800); }
function setBusy(on) {
  S.busy = on;
  $('#sendBtn').disabled = on; $('#stopBtn').hidden = !on; $('#sendBtn').hidden = on;
  $('#searchToggle').disabled = on; $('#cancelRecordingIntent').disabled = on; $('#typing').hidden = !on;
  $('#chatInput').disabled = on; $('#imageBtn').disabled = on;
  $('#messages').setAttribute('aria-busy', String(on));
  if (on) { $('#typing em').textContent = '正在理解你的输入…'; followChat = true; scrollChat(); }
}
let modalReturnFocus = null;
function openMask(id) {
  modalReturnFocus = document.activeElement;
  const el = document.getElementById(id); el.hidden = false; document.body.classList.add('modal-open');
  $('.app-shell').inert = true; $('.mobile-nav').inert = true;
  el.querySelector('button,input,select,textarea')?.focus();
}
function closeMask(id) {
  const el = document.getElementById(id); el.hidden = true; document.body.classList.remove('modal-open');
  $('.app-shell').inert = false; $('.mobile-nav').inert = false;
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
}

function updateDateHeader() {
  const d = dayObj(); const today = dayObj(TODAY); const diff = Math.round((d - today) / 86400000);
  $('#dateLabel').textContent = diff === 0 ? '今天' : diff === -1 ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`;
  $('#weekLabel').textContent = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
  $('#dateInput').value = S.date;
  $('#nextDate').disabled = S.date >= TODAY;
}

function goPage(page) {
  S.page = page;
  $$('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  $$('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('#pageEyebrow').textContent = pageMeta[page][0]; $('#pageTitle').textContent = pageMeta[page][1];
  $('#sidebar').classList.remove('open');
  if (page === 'today') renderToday();
  if (page === 'trend') renderTrend();
}

async function setDate(value) {
  if (S.busy) { toast('请先停止生成，再切换日期'); return; }
  if (!value || value > TODAY) return;
  S.date = value; updateDateHeader();
  await loadState();
}

async function loadState() {
  try {
    const [state, hist] = await Promise.all([api.get(`/api/state?date=${encodeURIComponent(S.date)}`), api.get(`/api/history?days=30&end=${encodeURIComponent(S.date)}`)]);
    S.state = state; S.token = state.session_token; S.history = hist.history || [];
    $('#unitLabel').textContent = unit();
    $('#setupHint').hidden = !!state.settings?.has_key;
    $('#aiStatus').textContent = state.settings?.has_key ? (state.settings.text_model || 'AI 已连接') : '尚未配置模型';
    $('#searchToggle').checked = !!state.settings?.search_ready;
    $('#aiDot').classList.toggle('ready', !!state.settings?.has_key);
    const p = state.today?.profile || {};
    $('#profileTitle').textContent = p.target_weight ? `目标 ${round(p.target_weight, 1)} kg` : '个人档案';
    $('#profileSub').textContent = state.settings?.has_key ? `AI · ${state.settings.text_model}` : '点击配置 AI 模型';
    renderToday(); renderTrend();
  } catch (e) { toast(e.message); }
}

function statusText(t) { return t === 'none' ? '未记录' : '已记录'; }
function renderToday() {
  const t = S.state?.today; if (!t) return;
  const u = unit(); const has = !!t.has_meals; const intake = has ? energy(t.intake) : null; const target = energy(t.target_intake);
  $('#intakeUnit').textContent = u; $('#intakeValue').textContent = intake ?? '—'; $('#mealStatusBadge').textContent = statusText(t.meal_status);
  $('#todayStatus').textContent = has ? '已自动汇总你录入的饮食和运动，随时补充或修改即可。' : '还没有饮食记录，直接告诉 渐渐飞 你吃了什么。';
  $('#energyCaption').textContent = has ? `今日目标约 ${target} ${u}` : '记录饮食后显示目标进度';
  $('#targetValue').textContent = `目标 ${target ?? '—'} ${u}`;
  const pct = has && t.target_intake ? Math.min(115, num(t.intake) / num(t.target_intake) * 100) : 0;
  $('#energyProgress').style.width = `${Math.min(100, pct)}%`;
  const left = has ? num(t.target_intake) - num(t.intake) : null;
  $('#remainingValue').textContent = left == null ? '—' : `${left >= 0 ? '' : '超 '}${Math.abs(energy(left))}`;
  $('#remainingSub').textContent = left == null ? '等待记录' : `${u} · ${left >= 0 ? '仍可安排' : '超过目标'}`;
  $('#exerciseValue').textContent = t.exercise ? `${energy(t.exercise)}` : '—'; $('#exerciseSub').textContent = t.exercise ? `${u} · ${round(t.exercise_minutes)} 分钟` : '今天还没有运动';
  $('#weightValue').textContent = t.weight != null ? `${round(t.weight, 1)} kg` : '—'; $('#weightSub').textContent = t.weight_date ? `${t.weight_date} 实测` : '还没有称重';
  const gap = t.net; $('#predictionValue').textContent = gap == null ? '—' : `${gap > 0 ? '+' : ''}${energyText(gap)}`;
  $('#predictionSub').textContent = gap == null ? '等待饮食记录' : '已录入摄入 − 估计消耗，非全天结论';
  const macros = [
    ['蛋白质', t.protein, t.macro_targets?.protein_g, '#e46549'],
    ['碳水', t.carb, t.macro_targets?.carb_g, '#d4a64f'],
    ['脂肪', t.fat, t.macro_targets?.fat_g, '#706382']
  ];
  $('#macroRows').innerHTML = macros.map(([name, value, goal, color]) => `<div class="macro-row"><span>${name}</span><div class="macro-bar"><i style="width:${Math.min(100, goal ? num(value) / num(goal) * 100 : 0)}%;background:${color}"></i></div><b>${round(value, 1)} / ${round(goal, 0)} g</b></div>`).join('');
  const logs = [];
  (t.meals || []).forEach(m => logs.push(`<div class="log-item"><span class="log-dot">${esc((m.meal_type || '食')[0])}</span><span><b>${esc(m.name)}</b><small>${esc(m.meal_type)} · ${esc(m.amount || `${m.grams || 0}g`)}</small></span><strong>${energyText(m.energy_kj ?? m.kcal)}</strong><button class="record-edit" data-edit-kind="meal" data-edit-id="${m.id}" aria-label="编辑饮食：${esc(m.name)}">编辑</button></div>`));
  (t.exercises || []).forEach(e => logs.push(`<div class="log-item exercise"><span class="log-dot">动</span><span><b>${esc(e.type)}</b><small>${round(e.minutes)} 分钟${e.met ? ` · MET ${e.met}` : ''}</small></span><strong>−${energyText(e.energy_kj ?? e.kcal)}</strong><button class="record-edit" data-edit-kind="exercise" data-edit-id="${e.id}" aria-label="编辑运动：${esc(e.type)}">编辑</button></div>`));
  $('#todayLogs').innerHTML = logs.length ? logs.join('') : '<div class="empty-state">今天还没有记录<br>在对话里说“我吃了…”或“我运动了…”即可开始</div>';
}

function chartFrame(points, type) {
  const W = 480, H = 250, L = 64, R = 24, T = 28, B = 48, innerW = W - L - R, innerH = H - T - B;
  const valid = points.map((p,i) => ({...p,i})).filter(p => Number.isFinite(p.value));
  if (!valid.length) return '<div class="empty-state">还没有足够的数据</div>';
  const valueUnit = type === 'line' ? 'kg' : unit();
  const values = valid.map(p => p.value), min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * .15, .3);
  let lo = type === 'bar' ? 0 : Math.max(0, min - padding), hi = type === 'bar' ? Math.max(1,max) : max + padding;
  const rough = (hi - lo) / 4, magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1,2,2.5,5,10].find(n => n * magnitude >= rough) * magnitude;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const ticks = Math.round((hi-lo)/step);
  const x = i => L + (points.length === 1 ? innerW / 2 : i * innerW / (points.length - 1));
  const y = v => T + (hi - v) / (hi - lo) * innerH;
  const tickText = v => type === 'line' ? v.toFixed(step < .1 ? 2 : 1) : String(round(v, step < 1 ? 1 : 0));
  const grids = Array.from({length:ticks+1},(_,i) => {
    const value = lo + step*i, cy = y(value);
    return `<line class="grid" x1="${L}" y1="${cy}" x2="${W-R}" y2="${cy}"/><text class="axis-label" x="${L-10}" y="${cy+4}" text-anchor="end">${tickText(value)}</text>`;
  }).join('');
  const labels = points.map((p,i) => (i === 0 || i === points.length - 1 || i === Math.floor((points.length-1)/2)) ? `<text class="axis-label" x="${x(i)}" y="${H-B+22}" text-anchor="middle">${esc(p.date.slice(5).replace('-','/'))}</text>` : '').join('');
  const axes = `<path class="chart-axis" d="M ${L} ${T} V ${H-B} H ${W-R}"/><text class="axis-title" x="${L-10}" y="14" text-anchor="end">${esc(valueUnit)}</text><text class="axis-title" x="${W-R}" y="${H-3}" text-anchor="end">日期</text>`;
  let marks = '';
  if (type === 'bar') { const bw = Math.min(32,innerW / Math.max(points.length, 1) * .56); marks = valid.map(p => `<rect class="bar" x="${x(p.i)-bw/2}" y="${y(p.value)}" width="${bw}" height="${T+innerH-y(p.value)}" rx="${Math.min(4,bw/2)}"/>`).join(''); }
  else { const path = valid.map((p,j) => `${j?'L':'M'} ${x(p.i)} ${y(p.value)}`).join(' '); const area = `${path} L ${x(valid.at(-1).i)} ${T+innerH} L ${x(valid[0].i)} ${T+innerH} Z`; marks = `<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e46549" stop-opacity=".2"/><stop offset="1" stop-color="#e46549" stop-opacity="0"/></linearGradient></defs><path class="area" d="${area}"/><path class="line" d="${path}"/>${valid.map(p => `<circle class="dot" cx="${x(p.i)}" cy="${y(p.value)}" r="4"/>`).join('')}`; }
  const hits = valid.map((p,i) => {
    const left = i ? (x(valid[i-1].i)+x(p.i))/2 : L;
    const right = i < valid.length-1 ? (x(p.i)+x(valid[i+1].i))/2 : W-R;
    return `<g class="chart-hit" role="button" tabindex="0" aria-label="${esc(p.date)}，${round(p.value,1)} ${esc(valueUnit)}" data-chart-date="${esc(p.date)}" data-chart-value="${round(p.value,1)}" data-chart-unit="${esc(valueUnit)}" data-chart-x="${x(p.i)}" data-chart-y="${y(p.value)}"><rect x="${left}" y="${T}" width="${right-left}" height="${innerH}"/></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="group" aria-label="${type==='line'?'体重':'已记录能量摄入'}趋势，横轴日期，纵轴${esc(valueUnit)}。悬停、点击或使用方向键查看记录。">${grids}${axes}${marks}${labels}<line class="chart-guide" y1="${T}" y2="${H-B}" hidden/><circle class="chart-active" r="6" hidden/>${hits}</svg><div class="chart-tooltip" role="status" hidden></div>`;
}

function showChartPoint(chart, point) {
  if (!point) return;
  const tooltip = $('.chart-tooltip',chart), svg = $('svg',chart);
  const x = Number(point.dataset.chartX), y = Number(point.dataset.chartY);
  tooltip.textContent = `${point.dataset.chartDate} · ${point.dataset.chartValue} ${point.dataset.chartUnit}`;
  tooltip.hidden = false;
  const guide = $('.chart-guide',chart), dot = $('.chart-active',chart);
  guide.setAttribute('x1',x); guide.setAttribute('x2',x); guide.hidden = false; guide.removeAttribute('hidden');
  dot.setAttribute('cx',x); dot.setAttribute('cy',y); dot.removeAttribute('hidden');
  const box = svg.getBoundingClientRect(), parent = chart.getBoundingClientRect();
  const px = box.left-parent.left+x/480*box.width, py = box.top-parent.top+y/250*box.height;
  tooltip.style.left = `${Math.max(0,Math.min(chart.clientWidth-tooltip.offsetWidth,px-tooltip.offsetWidth/2))}px`;
  tooltip.style.top = `${Math.max(0,Math.min(chart.clientHeight-tooltip.offsetHeight,py > tooltip.offsetHeight+14 ? py-tooltip.offsetHeight-12 : py+14))}px`;
}
function hideChartPoint(chart) {
  for (const el of $$('.chart-tooltip,.chart-guide,.chart-active',chart)) el.setAttribute('hidden','');
}
function bindChart(chart) {
  const show = event => showChartPoint(chart,event.target.closest('[data-chart-date]'));
  chart.addEventListener('pointermove',show); chart.addEventListener('click',show); chart.addEventListener('focusin',show);
  chart.addEventListener('pointerleave',()=>hideChartPoint(chart));
  chart.addEventListener('focusout',event=>{if(!chart.contains(event.relatedTarget))hideChartPoint(chart)});
  chart.addEventListener('keydown',event=>{
    const points = $$('[data-chart-date]',chart), index = points.indexOf(event.target);
    if(index<0)return;
    if(event.key==='Escape'){hideChartPoint(chart);event.target.blur();return;}
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();
      const next = event.key==='Home'?0:event.key==='End'?points.length-1:Math.max(0,Math.min(points.length-1,index+(event.key==='ArrowRight'?1:-1)));
      points[next].focus();
    } else if(event.key==='Enter'||event.key===' '){event.preventDefault();show(event);}
  });
}

function renderTrend() {
  const rows = (S.history || []).slice(-S.range); if (!rows.length) return;
  const measured = rows.filter(r => r.weight_source === 'measured' && r.weight != null); const logged = rows.filter(r => r.has_meals);
  const delta = measured.length > 1 ? round(measured.at(-1).weight - measured[0].weight, 1) : null;
  const avgIntake = logged.length ? logged.reduce((s,r) => s + num(r.intake), 0) / logged.length : null;
  const avgExercise = rows.reduce((s,r) => s + num(r.exercise), 0) / rows.length;
  const cards = [
    ['体重变化', delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta} kg`, measured.length > 1 ? `${measured[0].date.slice(5)} → ${measured.at(-1).date.slice(5)}` : '至少需要两次实测'],
    ['饮食记录', `${logged.length} / ${rows.length} 天`, '有录入饮食的天数'],
    ['日均已记录摄入', avgIntake == null ? '—' : energyText(avgIntake), logged.length ? `按 ${logged.length} 个有记录日计算，不含空白日` : '暂无饮食记录'],
    ['日均运动', energyText(avgExercise), `近 ${rows.length} 个自然日`]
  ];
  $('#trendKpis').innerHTML = cards.map(c => `<article class="trend-kpi panel"><span>${c[0]}</span><strong>${c[1]}</strong><small>${c[2]}</small></article>`).join('');
  $('#weightChart').innerHTML = chartFrame(rows.map(r => ({ date:r.date, value:r.weight_source === 'measured' && r.weight != null ? num(r.weight,NaN) : null })), 'line');
  $('#intakeChart').innerHTML = chartFrame(rows.map(r => ({ date:r.date, value:r.has_meals ? energy(r.intake,1) : null })), 'bar'); $('#chartUnit').textContent = unit();
  $('#dayDots').innerHTML = rows.map(r => `<div class="day-dot"><i class="${r.has_meals ? 'logged' : ''}" title="${esc(r.date)} · ${statusText(r.meal_status)}"></i><small>${r.date.slice(8)}</small></div>`).join('');
}

async function loadSessions(selectLatest = false) {
  const data = await api.get('/api/coach/sessions'); S.sessions = data.sessions || [];
  if (!S.sessions.length) { await createSession(); return; }
  if (!S.sessionId || selectLatest || !S.sessions.some(x => x.id === S.sessionId)) S.sessionId = S.sessions[0].id;
  renderSessions(); await loadMessages();
}
function renderSessions() { $('#sessionList').innerHTML = S.sessions.slice(0,8).map(s => `<button class="${s.id === S.sessionId ? 'active' : ''}" data-session="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title || '新对话')}</button>`).join(''); }
async function createSession() { if(S.busy){toast('请先停止生成，再新建对话');return;} selectRecordingIntent(''); try { const data = await api.post('/api/coach/session/create', { date: S.date, title: '新对话' }); S.sessionId = data.session.id; await loadSessions(); goPage('chat'); $('#chatInput').focus(); } catch (e) { toast(e.message); } }
async function loadMessages() { if (!S.sessionId) return; try { const data = await api.get(`/api/coach/session?id=${encodeURIComponent(S.sessionId)}`); S.messages = data.messages || []; renderMessages(); } catch (e) { toast(e.message); } }

function richText(text) { return esc(text).replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/(^|\n)[-•]\s+/g,'$1<span class="bullet">• </span>').replace(/\n/g,'<br>'); }
function toolSummary(call) {
  const a = call.arguments || {};
  if (call.name==='manage_records') return (a.operations||[]).flatMap((op,i)=>[[`${i+1}. ${toolName(op.name)}`,op.arguments?.date||''],...toolSummary(op)]);
  if (call.before) {
    const before=call.before,after=call.after;
    const label=before.name||before.type||'体重';
    const rows=[[label,`${before.date} · ${before.amount|| (before.minutes!=null?`${before.minutes} 分钟`:before.weight!=null?`${before.weight} kg`:'')}`]];
    if(call.name.startsWith('delete_')) return [...rows,['操作','删除（7 天内可恢复）']];
    if(call.name==='restore_record')return [...rows,['操作','恢复已删除记录']];
    const fields={name:'名称',type:'项目',date:'日期',meal_type:'餐次',amount:'份量',grams:'克重 g',energy_kj:`能量 ${unit()}`,protein:'蛋白质 g',carb:'碳水 g',fat:'脂肪 g',minutes:'时长 分钟',met:'MET',weight:'体重 kg',note:'备注'};
    for(const [key,title] of Object.entries(fields)) if(after&&after[key]!==before[key]&&after[key]!=null) rows.push([title,key==='energy_kj'?`${energy(before[key],1)} → ${energy(after[key],1)}`:`${before[key]??'—'} → ${after[key]}`]);
    return rows;
  }
  if (call.name === 'log_meal') return (a.items || []).map(x => [x.name, `${x.amount || `${x.grams}g`} · ${energyText(x.energy_kj ?? x.kj ?? x.kcal)}`]);
  if (call.name === 'log_exercise') return (a.items || []).map(x => [x.type, `${round(x.minutes)} 分钟 · ${energyText(x.energy_kj ?? x.kj ?? x.kcal)}`]);
  if (call.name === 'log_weight') return [['体重', `${a.weight} kg`]];
  return [['状态', '此旧版工具已停用，无需完成今日记录']];
}
function toolName(name) { return ({ log_meal:'记录饮食', log_exercise:'记录运动', log_weight:'记录体重', update_meal:'修改饮食',update_exercise:'修改运动',update_weight:'修改体重',delete_meal:'删除饮食',delete_exercise:'删除运动',delete_weight:'删除体重',restore_record:'恢复记录',manage_records:'批量管理记录' })[name] || name; }
function toolCard(call, messageId) {
  if (call.name === 'mark_day_complete') return '<div class="tool-card"><div class="tool-lines">旧版完成标记已停用；已有记录自动汇总，无需操作。</div></div>';
  const status = ['pending','confirmed','rejected'].includes(call.status) ? call.status : 'pending'; const statusName = ({pending:'待确认',confirmed:isManagementCall(call)?'已完成':'已记录',rejected:'已取消'})[status] || status;
  return `<div class="tool-card"><div class="tool-card-head"><span class="tool-symbol">${call.name === 'log_exercise' ? '动' : call.name === 'log_weight' ? '重' : '记'}</span><div><b>${esc(toolName(call.name))}</b><small>${esc(call.arguments?.date || S.date)}</small></div><span class="tool-state ${status}">${statusName}</span></div><div class="tool-lines">${toolSummary(call).map(x => `<div class="tool-line"><span>${esc(x[0])}</span><b>${esc(x[1])}</b></div>`).join('')}</div>${status === 'pending' ? `<div class="tool-card-actions"><button class="confirm" data-tool-open="${esc(call.id)}" data-message="${messageId}">查看并确认</button><button class="reject" data-tool-reject="${esc(call.id)}" data-message="${messageId}">不记录</button></div>` : ''}</div>`;
}
function searchSources(data) {
  if (!data) return '';
  const sources = (data.sources || []).filter(x => { try { const u = new URL(x.url); return ['http:','https:'].includes(u.protocol) && !u.username; } catch { return false; } });
  return `<div class="search-sources"><span class="search-caption">↗ ${sources.length ? '联网参考来源' : '搜索未找到可用来源'}</span>${sources.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">[${esc(x.id)}] ${esc(x.title)} <small>${esc((x.retrieved_at || '').slice(0,16).replace('T',' '))}</small></a>`).join('')}${(data.errors || []).map(x => `<p class="search-warning">${esc(x)}</p>`).join('')}</div>`;
}
function renderMessages() {
  $('#welcome').hidden = S.messages.length > 0;
  $('#messages').innerHTML = S.messages.map(m => `<article class="message ${esc(m.role)}">${m.role === 'assistant' ? '<span class="message-avatar"><img src="/logo.svg" alt="渐渐飞" width="29" height="29"></span>' : ''}<div class="message-body">${m.image_urls?.length ? `<div class="message-images">${m.image_urls.map(u => `<img src="${esc(u)}" alt="用户上传图片">`).join('')}</div>` : ''}<div class="message-text">${richText(m.content)}</div>${searchSources(m.search_data)}${(m.tool_calls || []).map(c => toolCard(c,m.id)).join('')}<small class="message-time">${esc((m.created_at || '').slice(11,16))}</small></div></article>`).join('');
  const streaming = S.messages.find(m => m.streaming);
  if (streaming) {
    const text = $('#messages .message:last-child .message-text');
    text.id = 'streamText';
    text.textContent = streaming.content;
    $('#messages .message:last-child').classList.add('streaming');
  }
  if (!S.messages.length) $('#messageScroll').scrollTop = 0;
  else if (followChat) scrollChat();
}
function scrollChat() { requestAnimationFrame(() => { const el = $('#messageScroll'); el.scrollTop = el.scrollHeight; }); }

async function sendAgent() {
  if (S.busy) return; const input = $('#chatInput'); const question = input.value.trim(); if (!question && !S.images.length) return;
  if (!S.state?.settings?.has_key) { openSettings('model'); toast('先配置一个 AI 模型即可开始对话'); return; }
  const recordingIntent = S.recordingIntent;
  if (!S.sessionId) await createSession();
  const optimistic = { role:'user', content:question || '请看这些图片', image_urls:S.images.map(x => x.url), created_at:TODAY+'T'+new Date().toLocaleTimeString('sv-SE') };
  const draft = {role:'assistant',content:'',streaming:true};
  followChat = true;
  S.messages.push(optimistic,draft); renderMessages(); const images = S.images.map(x => x.data); input.value = ''; resizeInput(); S.images = []; renderImages(); setBusy(true);
  $('#chatError').hidden = true;
  streamController = new AbortController();
  try {
    const result = await streamAgent({ session_id:S.sessionId, date:S.date, question, images, recording_intent:recordingIntent }, (kind,data) => {
      if (kind === 'reply') { draft.content = data.text || ''; scheduleChatPaint(); }
      if (kind === 'status') $('#typing em').textContent = data.text;
    }, streamController.signal);
    Object.assign(draft, {streaming:false, content:result?.reply || '', id:result?.message_id,
      tool_calls:result?.tool_calls || [], search_data:result?.search_data});
    renderMessages();
    selectRecordingIntent('');
    await Promise.all([loadMessages(), loadState(), loadSessionsOnly().catch(()=>toast('回复已保存，对话列表刷新失败，请稍后刷新'))]);
  } catch (e) {
    S.messages = S.messages.filter(x => x !== optimistic && x !== draft);
    input.value = question; selectRecordingIntent(recordingIntent); S.images = images.map(data => ({ data, url:data, name:'待重试图片' }));
    resizeInput(); renderImages(); renderMessages();
    $('#chatErrorText').textContent = e.name === 'AbortError' ? '已停止等待，输入已恢复。' : `${e.message}。输入已保留，可重试。`;
    $('#chatError').hidden = false;
    // Reconcile a response committed just before a disconnect; never auto-resend.
    await loadMessages();
  }
  finally { streamController = null; setBusy(false); input.focus(); }
}
async function loadSessionsOnly() { const data = await api.get('/api/coach/sessions'); S.sessions = data.sessions || []; renderSessions(); }

function openTool(messageId, callId) {
  if (S.busy) { toast('请先停止生成，再确认记录'); return; }
  const message = S.messages.find(m => m.id === Number(messageId)); const call = message?.tool_calls?.find(c => c.id === callId); if (!call) return;
  S.currentTool = { messageId:Number(messageId), call:JSON.parse(JSON.stringify(call)) };
  S.currentRecord = null;
  $('#deleteRecordBtn').hidden=true;
  $('#confirmToolBtn').textContent='确认记录'; $('#rejectToolBtn').textContent='不记录'; $('#editorEyebrow').textContent='核对并保存';
  $('#toolTitle').textContent = `确认${toolName(call.name)}`; $('#toolLead').textContent = '你可以先校正内容。点击确认后才会写入本地记录。';
  if(isManagementCall(call)) { $('#toolLead').textContent='请核对目标记录与修改内容。确认后才执行；删除的记录 7 天内可恢复，批量操作全部成功才提交。'; $('#confirmToolBtn').textContent=call.name.startsWith('delete_')?'确认删除':'确认执行'; $('#rejectToolBtn').textContent='取消操作'; }
  $('#toolEditor').innerHTML = searchSources(message.search_data) + editorHtml(call); initEditorScaling(); openMask('toolMask');
}
function openRecord(kind, id) {
  const list = kind === 'meal' ? S.state?.today?.meals : S.state?.today?.exercises;
  const record = list?.find(x => x.id === Number(id)); if (!record) { toast('记录已变化，请刷新后重试'); return; }
  const call = {name:kind === 'meal' ? 'log_meal' : 'log_exercise', arguments:{date:record.date || S.date, meal_type:record.meal_type, items:[JSON.parse(JSON.stringify(record))]}};
  S.currentRecord={kind,id:record.id,original:JSON.parse(JSON.stringify(record))}; S.currentTool={call};
  $('#toolTitle').textContent=kind === 'meal' ? '编辑饮食记录' : '编辑运动记录'; $('#editorEyebrow').textContent='EDIT RECORD';
  $('#toolLead').textContent=kind === 'meal' ? '修改克重会等比例更新热量与营养；也可以直接修正数值。保存后更新概要和趋势，不新增记录。' : '修改项目、时长、强度或消耗。保存后更新原记录，不新增记录。';
  $('#confirmToolBtn').textContent='保存修改'; $('#rejectToolBtn').textContent='取消';
  $('#deleteRecordBtn').hidden=false; $('#deleteRecordBtn').disabled=false;
  $('#toolEditor').innerHTML=editorHtml(call); initEditorScaling(); openMask('toolMask');
}
const editorBases = new WeakMap();
const editorCorrections = new WeakSet();
function scaledNutrition(base, grams) {
  if (!(base.grams > 0) || !Number.isFinite(grams) || grams < 0) return null;
  const ratio=grams/base.grams;
  return Object.fromEntries(['kj','protein','carb','fat'].map(k=>[k,base[k]*ratio]));
}
function macroEnergy(row) {
  const values=['protein','carb','fat'].map(k=>$(`[data-item="${k}"]`,row));
  if(values.some(input=>!input||String(input.value).trim()===''||!Number.isFinite(Number(input.value))||Number(input.value)<0)) return null;
  return Number(values[0].value)*17+Number(values[1].value)*17+Number(values[2].value)*37;
}
function editorBaseline(row) {
  return Object.fromEntries(['grams','kj','protein','carb','fat','minutes','met'].map(k=>[k,num($(`[data-item="${k}"]`,row)?.value)]));
}
function initEditorScaling() {
  $$('.editor-item',$('#toolEditor')).forEach(row=>{
    let baseline=editorBaseline(row);
    const item=S.currentTool?.call.arguments?.items?.[num(row.dataset.index)];
    if(item?.base_grams>0&&['base_kj','base_protein','base_carb','base_fat'].every(k=>item[k]!=null)) {
      const stored={grams:num(item.base_grams),kj:num(item.base_kj),protein:num(item.base_protein),carb:num(item.base_carb),fat:num(item.base_fat)};
      const expected=scaledNutrition(stored,baseline.grams);
      if(expected&&Object.keys(expected).every(k=>Math.abs(expected[k]-baseline[k])<=.15)) baseline={...baseline,...stored};
    }
    editorBases.set(row,baseline);
    if ($('[data-item="grams"]',row)) row.insertAdjacentHTML('beforeend','<p class="editor-note scale-status">克重变化时四项等比例换算；修改蛋白质、碳水或脂肪时，能量按三者自动重算。</p>');
  });
}
function handleEditorInput(event) {
  const input=event.target, row=input.closest('.editor-item'); if (!row || !input.dataset.item) return;
  const key=input.dataset.item, value=Number(input.value); if (input.value.trim()==='' || !Number.isFinite(value) || value<0) return;
  const base=editorBases.get(row)||editorBaseline(row);
  if (key==='grams') {
    const totals=scaledNutrition(base,value),status=$('.scale-status',row);
    if (!totals) { if(status)status.textContent='原克重缺失或为 0，无法自动换算；请填写克重及营养值后再调整。'; return; }
    for(const [field,total] of Object.entries(totals)) $(`[data-item="${field}"]`,row).value=round(total,2);
    $('[data-item="amount"]',row).value=`${value}g`;
    if(status)status.textContent=`已按 ${round(value/base.grams,3)} 倍换算热量与营养。`;
  } else if (['protein','carb','fat'].includes(key)) {
    const kj=macroEnergy(row),status=$('.scale-status',row);
    if(kj!==null) {
      $('[data-item="kj"]',row).value=round(kj,2);
      if(status)status.textContent='已根据蛋白质、碳水和脂肪自动重算能量。';
    }
    editorCorrections.add(row);
    editorBases.set(row,editorBaseline(row));
  } else if (key==='kj') {
    editorCorrections.add(row);
    editorBases.set(row,editorBaseline(row));
  } else if (['minutes','met'].includes(key)) {
    const minutes=num($('[data-item="minutes"]',row)?.value),met=num($('[data-item="met"]',row)?.value);
    if(base.minutes>0) $('[data-item="kj"]',row).value=round(base.kj*minutes/base.minutes*(base.met>0&&met>0?met/base.met:1),2);
  }
}
async function saveRecord() {
  const ctx=S.currentRecord,btn=$('#confirmToolBtn'); if(!ctx)return;
  if(btn.disabled||$('#deleteRecordBtn').disabled)return;
  for(const input of $$('#toolEditor input[type="number"]')) {
    if(input.value.trim()===''||!Number.isFinite(Number(input.value))||Number(input.value)<0) { toast('请填写有效的非负数值');input.focus();return; }
  }
  btn.disabled=true; $('#deleteRecordBtn').disabled=true;
  try {
    const args=readToolArguments(),item=args.items[0],original=ctx.original;
    await api.post(`/api/${ctx.kind}/update`,{...item,id:ctx.id,date:args.date,...(ctx.kind==='meal'?{meal_type:args.meal_type,energy_mode:'scaled',item_source:original.item_source||original.source||'manual',scale_nutrients:false}:{note:original.note||'',source:original.source||'manual',energy_mode:original.energy_mode||'manual'})});
    closeMask('toolMask');S.currentRecord=null;S.currentTool=null;await loadState();toast('记录已更新');
  }catch(e){toast(e.message)}finally{btn.disabled=false;$('#deleteRecordBtn').disabled=false}
}
async function deleteRecord() {
  const ctx=S.currentRecord,btn=$('#deleteRecordBtn'),save=$('#confirmToolBtn');
  if(!ctx||btn.disabled||save.disabled)return;
  const original=ctx.original,label=original.name||original.type,recordDate=original.date||S.date;
  if(!confirm(`确认删除 ${recordDate} 的“${label}”（${original.amount||(original.minutes!=null?`${original.minutes} 分钟`:'')}）？\n只删除这一条记录，未保存的编辑不会提交。删除后可撤销。`))return;
  btn.disabled=true;save.disabled=true;
  try {
    const result=await api.post(`/api/${ctx.kind}/delete`,{id:ctx.id,date:recordDate});
    undoRecords.push({...result.undo,date:recordDate,label});if(undoRecords.length>5)undoRecords.shift();renderUndoRecords();
    closeMask('toolMask');S.currentRecord=null;S.currentTool=null;await loadState();toast('记录已删除，可在记录列表下方撤销');
  }catch(e){toast(e.message)}finally{btn.disabled=false;save.disabled=false}
}
function renderUndoRecords() {
  const box=$('#undoRecords');box.hidden=!undoRecords.length;
  box.innerHTML=undoRecords.map(x=>`<div class="undo-record"><span>已删除 ${esc(x.date)} · ${esc(x.label)}</span><button class="text-button" data-undo-kind="${esc(x.kind)}" data-undo-id="${x.id}">撤销删除</button></div>`).join('');
}
async function undoRecord(kind,id,button) {
  const entry=undoRecords.find(x=>x.kind===kind&&x.id===Number(id));if(!entry||button.disabled)return;button.disabled=true;
  try{await api.post('/api/restore',{kind:entry.kind,id:entry.id,date:entry.date});undoRecords.splice(undoRecords.indexOf(entry),1);renderUndoRecords();await loadState();toast('记录已恢复')}catch(e){toast(e.message);button.disabled=false}
}
function commonFields(a, extra = '') { return `<div class="editor-row"><label class="editor-field"><span>记录日期</span><input data-field="date" type="date" max="${TODAY}" value="${esc(a.date || S.date)}"></label>${extra}</div>`; }
function isManagementCall(call) {return ['update_meal','update_exercise','update_weight','delete_meal','delete_exercise','delete_weight','restore_record','manage_records'].includes(call.name)}
function editorHtml(call) {
  const a = call.arguments || {};
  if(isManagementCall(call)) return `<div class="management-preview">${toolSummary(call).map(([label,value])=>`<div class="management-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}<p class="editor-note">目标记录 ID：${call.name==='manage_records'?(a.operations||[]).map(x=>x.arguments?.id).filter(Boolean).map(esc).join('、'):esc(a.id)}。这些修改尚未执行；内容不正确请取消，再告诉 Agent 如何调整。</p></div>`;
  if (call.name === 'log_meal') return commonFields(a, `<label class="editor-field"><span>餐次</span><select data-field="meal_type">${['早餐','午餐','晚餐','加餐','其他'].map(x => `<option ${x===a.meal_type?'selected':''}>${x}</option>`).join('')}</select></label>`) + (a.items || []).map((x,i) => `<div class="editor-item" data-index="${i}"><div class="editor-item-head"><b>${esc(x.name)}</b><small>${x.from_label?'包装标签':x.note?.includes('本地库')?'成分表核算':'AI 估算'}</small></div><p class="estimate-note">${esc(x.note || '请核对实际吃下的份量；照片与描述均可能存在估算误差。')}</p><div class="editor-row"><label class="editor-field"><span>名称</span><input data-item="name" value="${esc(x.name)}"></label><label class="editor-field"><span>份量</span><input data-item="amount" value="${esc(x.amount || '')}"></label></div><div class="nutrient-grid"><label><span>克重 g</span><input type="number" data-item="grams" value="${num(x.grams)}"></label><label><span>能量 kJ</span><input type="number" data-item="kj" value="${num(x.energy_kj ?? x.kj ?? x.kcal)}"></label><label><span>蛋白质 g</span><input type="number" data-item="protein" value="${num(x.protein)}"></label><label><span>碳水 g</span><input type="number" data-item="carb" value="${num(x.carb)}"></label><label><span>脂肪 g</span><input type="number" data-item="fat" value="${num(x.fat)}"></label></div></div>`).join('');
  if (call.name === 'log_exercise') return commonFields(a) + (a.items || []).map((x,i) => `<div class="editor-item" data-index="${i}"><div class="editor-item-head"><b>${esc(x.type)}</b><small>按体重与强度估算</small></div><div class="editor-row"><label class="editor-field"><span>项目</span><input data-item="type" value="${esc(x.type)}"></label><label class="editor-field"><span>时长（分钟）</span><input type="number" data-item="minutes" value="${num(x.minutes)}"></label></div><div class="nutrient-grid"><label><span>MET</span><input type="number" step="0.1" data-item="met" value="${num(x.met)}"></label><label><span>消耗 kJ</span><input type="number" data-item="kj" value="${num(x.energy_kj ?? x.kj ?? x.kcal)}"></label></div></div>`).join('');
  if (call.name === 'log_weight') return commonFields(a) + `<div class="editor-row"><label class="editor-field"><span>体重（kg）</span><input data-field="weight" type="number" step="0.1" value="${num(a.weight)}"></label><label class="editor-field"><span>备注</span><input data-field="note" value="${esc(a.note || '')}"></label></div>`;
  return '<p class="editor-note">该旧版工具已停用，无需额外完成记录。</p>';
}
function readToolArguments() {
  if(isManagementCall(S.currentTool.call)) return JSON.parse(JSON.stringify(S.currentTool.call.arguments));
  const call = S.currentTool.call; const root = $('#toolEditor'); const args = { date:$('[data-field="date"]',root).value };
  if (call.name === 'log_meal') { args.meal_type = $('[data-field="meal_type"]',root).value; args.items = $$('.editor-item',root).map(row => ({ name:$('[data-item="name"]',row).value.trim(), amount:$('[data-item="amount"]',row).value.trim(), grams:num($('[data-item="grams"]',row).value), kj:num($('[data-item="kj"]',row).value), protein:num($('[data-item="protein"]',row).value), carb:num($('[data-item="carb"]',row).value), fat:num($('[data-item="fat"]',row).value), confidence:call.arguments.items[num(row.dataset.index)]?.confidence ?? null, from_label:!!call.arguments.items[num(row.dataset.index)]?.from_label, note:call.arguments.items[num(row.dataset.index)]?.note || '', nutrition_edited:editorCorrections.has(row) })); }
  else if (call.name === 'log_exercise') args.items = $$('.editor-item',root).map(row => ({ type:$('[data-item="type"]',row).value.trim(), minutes:num($('[data-item="minutes"]',row).value), met:num($('[data-item="met"]',row).value), kj:num($('[data-item="kj"]',row).value), confidence:call.arguments.items[num(row.dataset.index)]?.confidence ?? null }));
  else if (call.name === 'log_weight') { args.weight = num($('[data-field="weight"]',root).value); args.note = $('[data-field="note"]',root).value.trim(); }
  else throw new Error('该旧版工具已停用，请刷新页面');
  return args;
}
async function decideTool(decision, direct = null) {
  if (S.busy) { toast('请先停止生成，再处理记录'); return; }
  if(S.currentRecord&&!direct) { if(decision==='confirm')return saveRecord();closeMask('toolMask');S.currentRecord=null;S.currentTool=null;return; }
  const ctx = direct || S.currentTool; if (!ctx) return; const btn = decision === 'confirm' ? $('#confirmToolBtn') : $('#rejectToolBtn'); btn.disabled = true;
  try { await api.post('/api/agent/tool', { session_id:S.sessionId, message_id:ctx.messageId, call_id:ctx.call.id, decision, ...(decision === 'confirm' ? {arguments:readToolArguments()} : {}) }); closeMask('toolMask'); S.currentTool = null; await Promise.all([loadMessages(),loadState()]); toast(decision === 'confirm' ? isManagementCall(ctx.call)?'记录操作已完成':'已写入记录' : '已取消这条操作'); }
  catch(e) { toast(e.message); } finally { btn.disabled = false; }
}

function selectRecordingIntent(intent) {
  S.recordingIntent = ['meal','exercise','weight'].includes(intent) ? intent : '';
  const hints = {meal:'饮食记录：告诉我吃了什么和大致份量，也可以上传照片',exercise:'运动记录：告诉我做了什么、多久和大致强度',weight:'体重记录：输入本次称重数值'};
  $('#recordingIntent').hidden = !S.recordingIntent;
  $('#recordingIntentText').textContent = hints[S.recordingIntent] || '';
  $('#chatInput').placeholder = hints[S.recordingIntent] || '告诉我你吃了什么、做了什么，或问任何减脂问题…';
}
function handleChatShortcut(button) {
  if (S.busy) { toast('请等当前回复完成后再切换'); return; }
  goPage('chat');
  selectRecordingIntent(button.dataset.recordIntent || '');
  const input = $('#chatInput');
  // Opening an entry never sends a message or replaces an unfinished draft.
  if (button.dataset.prompt && !input.value.trim() && !S.images.length) input.value = button.dataset.prompt;
  resizeInput(); input.focus();
}
function resizeInput() { const el = $('#chatInput'); el.style.height = 'auto'; el.style.height = `${Math.min(150, el.scrollHeight)}px`; }
async function addImages(files) {
  if(S.busy)return;
  if(S.images.length>=4){toast('一次最多添加 4 张图片');return;}
  const total=S.images.reduce((n,x)=>n+x.data.length,0);
  if([...files].reduce((n,x)=>n+x.size,0)*4/3+total>12*1024*1024){toast('图片合计不能超过 12 MB，请压缩后上传');return;}
  for (const file of [...files].slice(0, 4 - S.images.length)) { if (!file.type.startsWith('image/')) continue; const data = await fileToDataUrl(file); S.images.push({ data, url:data, name:file.name }); }
  renderImages();
}
function fileToDataUrl(file) { return new Promise((resolve,reject) => { const r=new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(file); }); }
function renderImages() { const box=$('#imageStrip'); box.hidden=!S.images.length; box.innerHTML=S.images.map((x,i)=>`<div class="image-thumb"><img src="${x.url}" alt="${esc(x.name)}"><button data-remove-image="${i}">×</button></div>`).join(''); }

function openSettings(tab = 'profile') {
  const s=S.state?.settings||{}, p=S.state?.today?.profile||{};
  $('#profileGender').value=p.gender||'male'; $('#profileAge').value=p.age||''; $('#profileHeight').value=p.height||''; $('#profileStart').value=p.start_weight||S.state?.today?.weight||''; $('#profileTarget').value=p.target_weight||''; $('#profileWeekly').value=String(p.weekly_loss ?? .5); $('#profileActivity').value=String(p.activity||1.2);
  $('#modelBase').value=s.base_url||''; $('#modelName').value=s.text_model||''; $('#modelKey').value=''; $('#modelKey').placeholder=s.key_source==='shared'?'正在使用站点默认 API；填写可改用自己的':s.has_key?`已保存 ${s.api_key_masked}`:'输入 API Key'; $('#visionEnabled').checked=!!s.vision_enabled; $('#testModelStatus').textContent='';
  $('#tavilyKey').value=''; $('#tavilyKey').placeholder=s.tavily_key_source==='shared'?'正在使用站点默认搜索 API':s.has_tavily_key?`已保存 ${s.tavily_api_key_masked}（留空保留）`:'tvly-…'; $('#searchEnabled').checked=!!s.search_enabled; $('#testSearchStatus').textContent='';
  selectSettingsTab(tab); openMask('settingsMask');
}
function selectSettingsTab(tab) { $$('.settings-tabs button').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab)); $$('.settings-pane').forEach(x=>x.classList.toggle('active',x.dataset.pane===tab)); }
async function saveSettings() {
  const btn=$('#saveSettingsBtn'); btn.disabled=true;
  try { if ($('.settings-tabs button.active')?.dataset.tab === 'profile') await api.post('/api/profile',{gender:$('#profileGender').value,age:num($('#profileAge').value),height:num($('#profileHeight').value),start_weight:$('#profileStart').value ? num($('#profileStart').value) : null,target_weight:num($('#profileTarget').value),weekly_loss:num($('#profileWeekly').value),activity:num($('#profileActivity').value),completed:true}); const key=$('#modelKey').value.trim(), searchKey=$('#tavilyKey').value.trim(); await api.post('/api/settings',{base_url:$('#modelBase').value.trim(),text_model:$('#modelName').value.trim(),api_key:key,api_key_action:key?'replace':'keep',vision_enabled:$('#visionEnabled').checked,vision_api_key_action:'keep',tavily_api_key:searchKey,tavily_api_key_action:searchKey?'replace':'keep',search_enabled:$('#searchEnabled').checked}); $('#modelKey').value=''; $('#tavilyKey').value=''; await loadState(); closeMask('settingsMask'); toast('设置已保存'); }
  catch(e){toast(e.message)} finally{btn.disabled=false}
}
async function testModel(){const el=$('#testModelStatus');el.textContent='正在测试…';try{const key=$('#modelKey').value.trim();const r=await api.post('/api/test_key',{base_url:$('#modelBase').value.trim(),model:$('#modelName').value.trim(),api_key:key});el.textContent=`连接成功 · ${r.model}`}catch(e){el.textContent=e.message}}
async function testSearch(){const el=$('#testSearchStatus'),btn=$('#testSearchBtn');btn.disabled=true;el.textContent='正在连接 Tavily…';try{const r=await api.post('/api/test_search',{tavily_api_key:$('#tavilyKey').value.trim()});el.textContent=`${r.message} · ${r.result_count} 条来源`}catch(e){el.textContent=e.message}finally{btn.disabled=false}}
async function toggleSearch(){const el=$('#searchToggle');if(S.busy){el.checked=!!S.state?.settings?.search_ready;return}if(el.checked&&!S.state?.settings?.has_tavily_key){el.checked=false;openSettings('search');toast('先填写 Tavily API Key');return}el.disabled=true;try{await api.post('/api/settings',{search_enabled:el.checked});await loadState();toast(el.checked?'联网搜索已开启':'联网搜索已关闭')}catch(e){el.checked=!!S.state?.settings?.search_ready;toast(e.message)}finally{el.disabled=false}}
async function clearOwnKey(kind){
  const search=kind==='search', action=search?'tavily_api_key_action':'api_key_action';
  try{await api.post('/api/settings',{[action]:'clear'});await loadState();openSettings(search?'search':'model');toast((search?S.state.settings.has_tavily_key:S.state.settings.has_key)?'个人 Key 已删除，已恢复站点默认 API':'个人 Key 已删除，当前没有站点默认 API')}catch(e){toast(e.message)}
}
async function clearSearchKey(){return clearOwnKey('search')}

async function exportData(){try{const data=await api.get('/api/export');const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`渐渐飞-backup-${TODAY}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}catch(e){toast(e.message)}}
async function importData(file){if(!file)return;try{const data=JSON.parse(await file.text());await api.post('/api/import',data);await Promise.all([loadState(),loadSessions(true)]);toast('备份已恢复')}catch(e){toast(e.message)}}

function bind() {
  bindChart($('#weightChart')); bindChart($('#intakeChart'));
  document.addEventListener('keydown',event=>{
    const mask=$('.modal-mask:not([hidden])');
    if(!mask||event.key!=='Tab')return;
    const controls=$$('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]',mask).filter(el=>el.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });
  $('#stopBtn').onclick=()=>streamController?.abort();
  $('#retryBtn').onclick=()=>sendAgent();
  $('#dismissErrorBtn').onclick=()=>$('#chatError').hidden=true;
  $('#jumpLatest').onclick=()=>{followChat=true;scrollChat();};
  $('#messageScroll').addEventListener('scroll',()=>{followChat=chatAtBottom();$('#jumpLatest').hidden=followChat;},{passive:true});
  $('#setupModelBtn').onclick=()=>openSettings('model');

  $$('[data-page]').forEach(x=>x.addEventListener('click',()=>goPage(x.dataset.page)));
  $('#menuBtn').onclick=()=>$('#sidebar').classList.toggle('open'); $('#settingsBtn').onclick=()=>openSettings(); $('#settingsTopBtn').onclick=()=>openSettings(); $('#newChatBtn').onclick=createSession;
  $('#prevDate').onclick=()=>{const d=dayObj();d.setDate(d.getDate()-1);setDate(isoDate(d))}; $('#nextDate').onclick=()=>{const d=dayObj();d.setDate(d.getDate()+1);setDate(isoDate(d))}; $('#dateButton').onclick=()=>{const el=$('#dateInput'); if(el.showPicker)el.showPicker();else el.click()}; $('#dateInput').onchange=e=>setDate(e.target.value);
  $('#unitBtn').onclick=async()=>{const next=unit()==='kcal'?'kJ':'kcal';try{await api.post('/api/prefs',{display_unit:next});S.state.display_unit=next;$('#unitLabel').textContent=next;renderToday();renderTrend()}catch(e){toast(e.message)}};
  $('#cancelRecordingIntent').onclick=()=>selectRecordingIntent('');
  $('#sendBtn').onclick=()=>sendAgent(); $('#chatInput').addEventListener('input',resizeInput); $('#chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();sendAgent()}});
  $('#imageBtn').onclick=()=>$('#imageInput').click(); $('#imageInput').onchange=e=>{addImages(e.target.files);e.target.value=''}; $('#composer').addEventListener('dragover',e=>{e.preventDefault()}); $('#composer').addEventListener('drop',e=>{e.preventDefault();addImages(e.dataTransfer.files)});
  document.addEventListener('paste',e=>{if(S.page==='chat'&&e.clipboardData?.files?.length)addImages(e.clipboardData.files)});
  document.addEventListener('click',e=>{const p=e.target.closest('[data-prompt],[data-record-intent],[data-chat-entry]');if(p)handleChatShortcut(p); const s=e.target.closest('[data-session]');if(s){if(S.busy){toast('请先停止生成，再切换对话');return;}followChat=true;selectRecordingIntent('');S.sessionId=s.dataset.session;renderSessions();loadMessages();goPage('chat')} const rem=e.target.closest('[data-remove-image]');if(rem){S.images.splice(Number(rem.dataset.removeImage),1);renderImages()} const open=e.target.closest('[data-tool-open]');if(open)openTool(open.dataset.message,open.dataset.toolOpen);const rej=e.target.closest('[data-tool-reject]');if(rej){const m=S.messages.find(x=>x.id===Number(rej.dataset.message));const c=m?.tool_calls?.find(x=>x.id===rej.dataset.toolReject);if(c)decideTool('reject',{messageId:Number(rej.dataset.message),call:c})} const close=e.target.closest('[data-close]');if(close)closeMask(close.dataset.close)});
  $('#confirmToolBtn').onclick=()=>decideTool('confirm'); $('#rejectToolBtn').onclick=()=>decideTool('reject');
  $$('.modal-mask').forEach(m=>m.addEventListener('mousedown',e=>{if(e.target===m)closeMask(m.id)})); document.addEventListener('keydown',e=>{if(e.key==='Escape')$$('.modal-mask:not([hidden])').forEach(m=>closeMask(m.id));if(!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!e.ctrlKey&&!e.metaKey&&['1','2','3'].includes(e.key))goPage(['chat','today','trend'][Number(e.key)-1])});
  $$('.settings-tabs button').forEach(x=>x.onclick=()=>selectSettingsTab(x.dataset.tab)); $('#saveSettingsBtn').onclick=saveSettings; $('#testModelBtn').onclick=testModel; $('#clearModelKeyBtn').onclick=()=>clearOwnKey('model'); $('#exportBtn').onclick=exportData; $('#importInput').onchange=e=>{importData(e.target.files[0]);e.target.value=''};
  $('#testSearchBtn').onclick=testSearch; $('#clearSearchKeyBtn').onclick=clearSearchKey; $('#searchToggle').onchange=toggleSearch;
  $('#todayLogs').addEventListener('click',e=>{const btn=e.target.closest('[data-edit-id]');if(btn)openRecord(btn.dataset.editKind,btn.dataset.editId)});
  $('#toolEditor').addEventListener('input',handleEditorInput);
  $('#deleteRecordBtn').onclick=deleteRecord;
  $('#undoRecords').addEventListener('click',e=>{const btn=e.target.closest('[data-undo-id]');if(btn)undoRecord(btn.dataset.undoKind,btn.dataset.undoId,btn)});
  $$('#rangeSwitch button').forEach(x=>x.onclick=()=>{S.range=Number(x.dataset.range);$$('#rangeSwitch button').forEach(b=>b.classList.toggle('active',b===x));renderTrend()});
}

async function init(){
  try {
    const auth = await api.get('/api/auth/status');
    if (!auth.user) { location.replace('/auth.html'); return; }
    S.token = auth.session_token;
    const account = $('#accountBtn');
    account.textContent = auth.user.username + ' · 切换';
    account.addEventListener('click', () => openMask('accountMask'));
    $('#logoutConfirm').addEventListener('click', async () => {
      try {
        if (streamController) streamController.abort();
        await api.post('/api/auth/logout', {});
        if (typeof BroadcastChannel !== 'undefined') {
          const channel = new BroadcastChannel('fitai-account'); channel.postMessage('changed'); channel.close();
        }
        location.replace('/auth.html');
      } catch(e) { toast(e.message); }
    });
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('fitai-account');
      channel.onmessage = () => location.reload();
    }
    window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
    window.addEventListener('focus', async () => {
      try { const current = await api.get('/api/auth/status');
        if (current.session_token !== S.token) location.reload();
      } catch(e) { toast(e.message); }
    });
    bind();updateDateHeader();await loadState();await loadSessions();
    if(S.state?.needs_setup)openSettings('profile');
  } catch(e) { toast(e.message); }
}
init();
