const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8').replace(/\binit\(\);\s*$/, '');
const html = fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
function chat() {
  const elements = {};
  const document = {getElementById(id){return this.querySelector('#'+id)},querySelector(selector) { return elements[selector] ||= {value:'',hidden:true,textContent:'',innerHTML:'',style:{},scrollHeight:40,getBoundingClientRect(){return {width:300,height:210}},focus(){this.focused=true}}; }};
  const context = vm.createContext({console,Date,URL,document,AbortController});
  vm.runInContext(source, context);
  vm.runInContext(`goPage=page=>S.page=page;toast=text=>testToast=text;`, context);
  return {context,e:selector=>document.querySelector(selector),run:code=>vm.runInContext(code,context),shortcut(dataset){context.testButton={dataset};vm.runInContext('handleChatShortcut(testButton)',context)}};
}
test('chat entry focuses input without sending or inventing records',()=>{
  const c=chat();c.run(`api.post=()=>{throw Error('Must not call API')};sendAgent=()=>{throw Error('Must not send')}`);
  c.shortcut({chatEntry:'record'});
  assert.equal(c.e('#chatInput').value,'');
  assert.equal(c.run('S.messages.length'),0);
  assert.equal(c.e('#chatInput').focused,true);
});

test('shortcuts preserve unfinished text and images',()=>{
  const c=chat();c.e('#chatInput').value='实际吃了一根香蕉';c.run(`S.images=[{data:'picture'}]`);
  for(const dataset of [{chatEntry:'coach'},{chatEntry:'record'},{prompt:'总结今天'}]) {
    c.shortcut(dataset);assert.equal(c.e('#chatInput').value,'实际吃了一根香蕉');assert.equal(c.run('S.images.length'),1);
  }
});

test('analysis shortcut is a draft, not an automatic send',()=>{
  const c=chat();c.run(`api.post=()=>{throw Error('Must not call API')}`);c.shortcut({prompt:'帮我总结一下今天的状态'});
  assert.equal(c.e('#chatInput').value,'帮我总结一下今天的状态');assert.equal(c.run('S.messages.length'),0);
});

test('busy shortcuts do not change an in-flight input',()=>{
  const c=chat();c.e('#chatInput').value='保留草稿';c.run('S.busy=true');c.shortcut({prompt:'替换草稿'});
  assert.equal(c.e('#chatInput').value,'保留草稿');assert.match(c.run('testToast'),/回复完成/);
});
function prepareSend(c) {
  c.run(`S.state={settings:{has_key:true}};S.sessionId='synthetic';renderMessages=()=>{};renderImages=()=>{};setBusy=on=>S.busy=on;loadMessages=async()=>{};loadState=async()=>{};loadSessionsOnly=async()=>{};`);
  c.run(`streamAgent=body=>api.post('/api/agent',body)`);
}

test('food, exercise and weight are sent verbatim without manual categories',async()=>{
  for(const question of ['半碗米饭','刚跑步30分钟','今天体重68.5公斤']) {
    const c=chat();prepareSend(c);c.e('#chatInput').value=question;
    c.run(`api.post=async(path,body)=>{testPath=path;testBody=body}`);await c.run('sendAgent()');
    assert.equal(c.run('testPath'),'/api/agent');assert.equal(c.run('testBody.question'),question);
    assert.equal(c.run('Object.hasOwn(testBody,"recording_intent")'),false);
  }
});

test('send failures retain actual text and photos for retry',async()=>{
  const c=chat();prepareSend(c);c.e('#chatInput').value='跑步10分钟';c.run(`S.images=[{data:'image-data',url:'image-data'}]`);
  c.run(`api.post=async()=>{throw Error('模拟断网')}`);await c.run('sendAgent()');
  assert.equal(c.e('#chatInput').value,'跑步10分钟');assert.equal(c.run('S.images[0].data'),'image-data');assert.equal(c.run('S.messages.length'),0);
});

test('a saved reply is not treated as failed when the session list refresh fails',async()=>{
  const c=chat();prepareSend(c);c.e('#chatInput').value='米饭100g';
  c.run(`api.post=async()=>({reply:'已整理',message_id:7,tool_calls:[]});loadSessionsOnly=async()=>{throw Error('列表刷新失败')}`);
  await c.run('sendAgent()');
  assert.equal(c.e('#chatInput').value,'');
  assert.equal(c.run('S.messages.at(-1).streaming'),false);
  assert.equal(c.run('S.messages.at(-1).content'),'已整理');
  assert.equal(c.e('#chatError').hidden,true);
});

test('today and trends use all logged records without day-complete gate or empty-day zero',()=>{
  const c=chat();c.run(`S.state={display_unit:'kj',today:{has_meals:true,meal_status:'logged',intake:500,target_intake:2000,net:-1000,protein:10,carb:20,fat:3,meals:[],exercises:[]}};
    S.history=[{date:'2026-09-13',has_meals:true,meal_status:'logged',intake:1000,exercise:0},{date:'2026-09-14',has_meals:false,intake:null,exercise:0},{date:'2026-09-15',has_meals:true,meal_status:'logged',intake:500,exercise:0}];renderToday();renderTrend();`);
  assert.match(c.e('#todayStatus').textContent,/自动汇总/);assert.doesNotMatch(c.e('#todayStatus').textContent,/记完|完整/);
  assert.match(c.e('#trendKpis').innerHTML,/750 kJ/);assert.match(c.e('#trendKpis').innerHTML,/2 \/ 3 天/);
  assert.doesNotMatch(c.e('#trendKpis').innerHTML,/完整日/);assert.match(c.e('#predictionValue').textContent,/-1000 kJ/);
});
test('markup has no manual categories or fabricated food and exercise facts',()=>{
  assert.doesNotMatch(html,/data-record-intent|composer-shortcuts|id="recordingIntent"/);
  assert.doesNotMatch(html,/两个鸡蛋|一杯豆浆|我刚快走|完整记录后计算/);
  assert.doesNotMatch(source,/sendAgent\(p\.dataset\.prompt\)/);
});
test('legacy pending complete calls show no action button',()=>{
  const c=chat();const card=c.run(`toolCard({name:'mark_day_complete',status:'pending',arguments:{}},1)`);
  assert.match(card,/停用/);assert.doesNotMatch(card,/<button/);
});
