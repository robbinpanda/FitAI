const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8').replace(/\binit\(\);\s*$/, '');
function client(fetch = async()=>{}) {
  const elements = {};
  const context = vm.createContext({Date,URL,console,fetch,location:{replace(url){context.redirect=url}},
    document:{querySelector(s){return elements[s] ||= {innerHTML:''}}}});
  vm.runInContext(source,context);
  return {context,elements,run:code=>vm.runInContext(code,context)};
}
test('imported tool name and status cannot inject HTML or attributes',()=>{
  const c=client();
  c.context.call={name:'<img src=x onerror=alert(1)>',status:'"><img src=x>',id:'" onclick="bad',arguments:{}};
  const html=c.run('toolCard(call, 1)');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('tool-state pending'));
});
test('imported session ids and titles are escaped in session list',()=>{
  const c=client();
  c.context.session={id:'" onclick="bad',title:'<img src=x>'};
  c.run('S.sessions=[session];renderSessions()');
  const html=c.elements['#sessionList'].innerHTML;
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('data-session="&quot; onclick=&quot;bad"'));
});
test('expired API sessions redirect to authentication and reject stale writes',async()=>{
  const c=client(async()=>({status:401,ok:false,json:async()=>({error:'请先登录'})}));
  await assert.rejects(c.run("api.post('/api/weight',{weight:70})"),/登录已失效/);
  assert.equal(c.context.redirect,'/auth.html');
});

test('removing personal model and search keys uses clear and refreshes default state',async()=>{
  const c=client();
  c.run(`var calls=[], tabs=[], messages=[];
    api.post=async(path,body)=>calls.push({path,body});
    loadState=async()=>{S.state={settings:{has_key:true,has_tavily_key:true}}};
    openSettings=tab=>tabs.push(tab); toast=message=>messages.push(message);`);
  await c.run("clearOwnKey('model')");
  await c.run("clearSearchKey()");
  assert.equal(c.run('JSON.stringify(calls)'),JSON.stringify([
    {path:'/api/settings',body:{api_key_action:'clear'}},
    {path:'/api/settings',body:{tavily_api_key_action:'clear'}}]));
  assert.equal(c.run('JSON.stringify(tabs)'),JSON.stringify(['model','search']));
  assert.equal(c.run("messages.every(x=>x.includes('默认'))"),true);
});

test('saving a weight plan does not overwrite model or search settings',async()=>{
  const c=client();
  c.run(`var calls=[];
    document.querySelectorAll=()=>[];
    api.post=async(path,body)=>calls.push({path,body});
    loadState=async()=>{}; openSettings=()=>{}; toast=()=>{};
    $('.settings-tabs button.active').dataset={tab:'plan'};
    $('#profileGender').value='female'; $('#profileAge').value='30';
    $('#profileHeight').value='165'; $('#profileStart').value='70';
    $('#profileTarget').value='64.5'; $('#profileWeekly').value='0.25';
    $('#profileActivity').value='1.35';`);
  await c.run('saveSettings()');
  assert.equal(c.run('calls.length'),1);
  assert.equal(c.run('calls[0].path'),'/api/profile');
  assert.equal(c.run('calls[0].body.target_weight'),64.5);
  assert.equal(c.run('calls[0].body.weekly_loss'),0.25);
  assert.equal(c.elements['#accountFeedback'].textContent,'修改已保存。');
  assert.equal(c.elements['#saveSettingsBtn'].disabled,false);
});

test('failed plan save keeps the form editable and reports the error',async()=>{
  const c=client();
  c.run(`document.querySelectorAll=()=>[]; api.post=async()=>{throw new Error('连接失败')}; toast=()=>{};
    $('.settings-tabs button.active').dataset={tab:'plan'};
    $('#profileTarget').value='64.5';`);
  await c.run('saveSettings()');
  assert.equal(c.elements['#profileTarget'].value,'64.5');
  assert.equal(c.elements['#accountFeedback'].textContent,'连接失败');
  assert.equal(c.elements['#saveSettingsBtn'].disabled,false);
});
