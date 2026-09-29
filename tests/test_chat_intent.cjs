const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8').replace(/\binit\(\);\s*$/, '');
const html = fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
function chat() {
  const elements = {};
  const document = {querySelector(selector) { return elements[selector] ||= {value:'',hidden:true,textContent:'',innerHTML:'',style:{},scrollHeight:40,focus(){this.focused=true}}; }};
  const context = vm.createContext({console,Date,URL,document,AbortController});
  vm.runInContext(source, context);
  vm.runInContext(`goPage=page=>S.page=page;toast=text=>testToast=text;`, context);
  return {context,e:selector=>document.querySelector(selector),run:code=>vm.runInContext(code,context),shortcut(dataset){context.testButton={dataset};vm.runInContext('handleChatShortcut(testButton)',context)}};
}
test('record entries select intent only: no example, message, API or record',()=>{
  for (const intent of ['meal','exercise']) {
    const c=chat();c.run(`api.post=()=>{throw Error('Must not call API')};sendAgent=()=>{throw Error('Must not send')}`);
    c.shortcut({recordIntent:intent});
    assert.equal(c.run('S.recordingIntent'),intent);
    assert.equal(c.e('#chatInput').value,'');
    assert.equal(c.run('S.messages.length'),0);
    assert.equal(c.e('#recordingIntent').hidden,false);
    assert.equal(c.e('#chatInput').focused,true);
    assert.match(c.e('#chatInput').placeholder,intent==='meal'?/吃了什么/:/做了什么/);
  }
});
test('all shortcuts preserve unfinished text and images',()=>{
  const c=chat();c.e('#chatInput').value='实际吃了一根香蕉';c.run(`S.images=[{data:'picture'}]`);
  for(const dataset of [{recordIntent:'meal'},{recordIntent:'exercise'},{chatEntry:'coach'},{chatEntry:'record'},{prompt:'总结今天'}]) {
    c.shortcut(dataset);assert.equal(c.e('#chatInput').value,'实际吃了一根香蕉');assert.equal(c.run('S.images.length'),1);
  }
});
test('analysis shortcut is a draft, not an automatic send',()=>{
  const c=chat();c.run(`api.post=()=>{throw Error('Must not call API')}`);c.shortcut({prompt:'帮我总结一下今天的状态'});
  assert.equal(c.e('#chatInput').value,'帮我总结一下今天的状态');assert.equal(c.run('S.messages.length'),0);
});
test('coach entry and exit return to normal chat without making up a question',()=>{
  const c=chat();c.shortcut({recordIntent:'meal'});c.shortcut({chatEntry:'coach'});
  assert.equal(c.run('S.recordingIntent'),'');assert.equal(c.e('#recordingIntent').hidden,true);assert.equal(c.e('#chatInput').value,'');
  c.shortcut({recordIntent:'exercise'});c.run(`selectRecordingIntent('')`);assert.equal(c.run('S.recordingIntent'),'');
});
test('busy shortcuts cannot retarget an in-flight input',()=>{
  const c=chat();c.shortcut({recordIntent:'meal'});c.run('S.busy=true');c.shortcut({recordIntent:'exercise'});
  assert.equal(c.run('S.recordingIntent'),'meal');assert.match(c.run('testToast'),/回复完成/);
});
function prepareSend(c) {
  c.run(`S.state={settings:{has_key:true}};S.sessionId='synthetic';renderMessages=()=>{};renderImages=()=>{};setBusy=on=>S.busy=on;loadMessages=async()=>{};loadState=async()=>{};loadSessionsOnly=async()=>{};`);
  c.run(`streamAgent=body=>api.post('/api/agent',body)`);
}
test('only explicit send transmits actual input and separate intent; intent resets on success',async()=>{
  const c=chat();prepareSend(c);c.shortcut({recordIntent:'meal'});c.e('#chatInput').value='半碗米饭';
  c.run(`api.post=async(path,body)=>{testPath=path;testBody=body}`);await c.run('sendAgent()');
  assert.equal(c.run('testPath'),'/api/agent');assert.equal(c.run('testBody.question'),'半碗米饭');assert.equal(c.run('testBody.recording_intent'),'meal');
  assert.equal(c.run('S.recordingIntent'),'');assert.equal(c.e('#recordingIntent').hidden,true);
});
test('send failures retain both actual input and intent for retry',async()=>{
  const c=chat();prepareSend(c);c.shortcut({recordIntent:'exercise'});c.e('#chatInput').value='跑步10分钟';
  c.run(`api.post=async()=>{throw Error('模拟断网')}`);await c.run('sendAgent()');
  assert.equal(c.e('#chatInput').value,'跑步10分钟');assert.equal(c.run('S.recordingIntent'),'exercise');assert.equal(c.run('S.messages.length'),0);
});
test('a saved reply is not treated as failed when the session list refresh fails',async()=>{
  const c=chat();prepareSend(c);c.shortcut({recordIntent:'meal'});c.e('#chatInput').value='米饭100g';
  c.run(`api.post=async()=>({reply:'已整理',message_id:7,tool_calls:[]});loadSessionsOnly=async()=>{throw Error('列表刷新失败')}`);
  await c.run('sendAgent()');
  assert.equal(c.e('#chatInput').value,'');
  assert.equal(c.run('S.recordingIntent'),'');
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
test('markup has intent entries and no fabricated food or exercise facts',()=>{
  assert.match(html,/data-record-intent="meal"/);assert.match(html,/data-record-intent="exercise"/);
  assert.doesNotMatch(html,/两个鸡蛋|一杯豆浆|我刚快走|完整记录后计算/);
  assert.doesNotMatch(source,/sendAgent\(p\.dataset\.prompt\)/);
});
test('legacy pending complete calls show no action button',()=>{
  const c=chat();const card=c.run(`toolCard({name:'mark_day_complete',status:'pending',arguments:{}},1)`);
  assert.match(card,/停用/);assert.doesNotMatch(card,/<button/);
});
