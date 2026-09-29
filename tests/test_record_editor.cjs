// Actual frontend editor functions, tested without a browser or production data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
function editor(values) {
  const context = vm.createContext({console, Date, URL});
  vm.runInContext(source, context);
  const fields = {}, status = {textContent:''};
  const row = {querySelector(selector) {
    if(selector === '.scale-status') return status;
    return fields[/data-item="([^"]+)"/.exec(selector)?.[1]] || null;
  }};
  for(const [key,value] of Object.entries(values)) fields[key] = {value:String(value),dataset:{item:key},closest:()=>row};
  context.testRow = row;
  vm.runInContext('editorBases.set(testRow,editorBaseline(testRow))', context);
  return {fields,status,input(key,value){fields[key].value=String(value);context.testEvent={target:fields[key]};vm.runInContext('handleEditorInput(testEvent)',context)}};
}
const meal = {grams:200,kj:800,protein:8,carb:12,fat:10,amount:'1杯'};
test('grams immediately scale all four totals and update amount',()=>{
  const e=editor(meal);e.input('grams',100);
  assert.equal(Number(e.fields.kj.value),400);assert.equal(Number(e.fields.protein.value),4);
  assert.equal(Number(e.fields.carb.value),6);assert.equal(Number(e.fields.fat.value),5);
  assert.equal(e.fields.amount.value,'100g');
});
test('repeated weight edits use a fixed baseline without rounding drift',()=>{
  const e=editor(meal);for(let i=0;i<50;i++){e.input('grams',133.3);e.input('grams',200)}
  for(const key of ['kj','protein','carb','fat']) assert.equal(Number(e.fields[key].value),meal[key]);
});
test('manual nutrient corrections establish the next baseline',()=>{
  const e=editor(meal);e.input('grams',100);e.input('protein',9);e.input('grams',200);
  assert.equal(Number(e.fields.protein.value),18);assert.equal(Number(e.fields.kj.value),880);
});
test('editing any macro immediately recalculates energy with Atwater factors',()=>{
  for(const [field,value,expected] of [['protein',9,727],['carb',20,846],['fat',5,525]]) {
    const e=editor(meal);e.input(field,value);
    assert.equal(Number(e.fields.kj.value),expected);
    assert.match(e.status.textContent,/自动重算能量/);
  }
});
test('an explicitly edited energy value remains authoritative',()=>{
  const e=editor(meal);e.input('kj',999);
  assert.equal(Number(e.fields.kj.value),999);
});
test('zero and invalid grams never yield NaN or Infinity',()=>{
  const e=editor(meal);e.input('grams','');assert.equal(Number(e.fields.kj.value),800);
  e.input('grams',-1);assert.equal(Number(e.fields.kj.value),800);
  e.input('grams',0);assert.equal(Number(e.fields.kj.value),0);
  e.input('grams',200);assert.equal(Number(e.fields.kj.value),800);
  const missing=editor({...meal,grams:0});missing.input('grams',100);
  assert.equal(Number(missing.fields.kj.value),800);assert.match(missing.status.textContent,/无法自动换算/);
});
test('exercise duration and intensity scale the consumption preview',()=>{
  const e=editor({minutes:30,met:6,kj:900});e.input('minutes',60);
  assert.equal(Number(e.fields.kj.value),1800);e.input('met',3);
  assert.equal(Number(e.fields.kj.value),900);
});
test('management previews describe exact targets and changed nutrients',()=>{
  const context=vm.createContext({console,Date,URL});vm.runInContext(source,context);
  context.plan={name:'update_meal',arguments:{id:17,date:'2026-09-15',changes:{grams:100}},before:{id:17,date:'2026-09-15',name:'牛奶',grams:200,amount:'200g',energy_kj:800,protein:8},after:{id:17,date:'2026-09-15',name:'牛奶',grams:100,amount:'100g',energy_kj:400,protein:4}};
  const html=vm.runInContext('editorHtml(plan)',context);
  assert.match(html,/200 → 100/);assert.match(html,/8 → 4/);assert.match(html,/17/);
  vm.runInContext('S.currentTool={call:plan}',context);
  const args=JSON.parse(vm.runInContext('JSON.stringify(readToolArguments())',context));
  assert.equal(args.id,17);assert.deepEqual(args.changes,{grams:100});
});
test('batch and deletion previews distinguish destructive operations',()=>{
  const context=vm.createContext({console,Date,URL});vm.runInContext(source,context);
  context.plan={name:'manage_records',arguments:{operations:[{name:'delete_meal',arguments:{id:18},before:{date:'2026-09-15',name:'错误牛肉',amount:'110g'}},{name:'update_exercise',arguments:{id:19},before:{date:'2026-09-15',type:'跑步',minutes:30},after:{date:'2026-09-15',type:'跑步',minutes:60}}]}};
  const html=vm.runInContext('editorHtml(plan)',context);
  assert.match(html,/删除饮食/);assert.match(html,/7 天内可恢复/);assert.match(html,/错误牛肉/);assert.match(html,/30 → 60/);assert.match(html,/18、19/);
});
function deletionContext(kind,approved=true,fail=false) {
  const elements={};for(const id of ['deleteRecordBtn','confirmToolBtn','undoRecords','toolMask','app-shell','mobile-nav']) elements[id]={disabled:false,hidden:false,innerHTML:''};
  const calls=[];
  const context=vm.createContext({console,Date,URL,confirm:()=>approved,document:{querySelector:s=>elements[s.slice(1)],getElementById:id=>elements[id],body:{classList:{remove(){}}}}});
  vm.runInContext(source,context);
  context.fixture={kind,id:23,original:{date:'2026-01-01',name:kind==='meal'?'测试食物':undefined,type:kind==='exercise'?'快走':undefined,amount:kind==='meal'?'100g':undefined,minutes:kind==='exercise'?30:undefined}};
  context.postMock=async(url,body)=>{calls.push({url,body:JSON.parse(JSON.stringify(body))});if(fail)throw Error('network failed');return {undo:{kind,id:23}}};
  vm.runInContext('S.currentRecord=fixture;api.post=postMock;loadState=async()=>{};toast=()=>{}',context);
  return {context,elements,calls};
}
test('manual food and exercise deletion call the correct API and expose undo',async()=>{
  for(const kind of ['meal','exercise']) {
    const {context,elements,calls}=deletionContext(kind);
    await vm.runInContext('deleteRecord()',context);
    assert.equal(calls[0].url,`/api/${kind}/delete`);
    assert.deepEqual(calls[0].body,{id:23,date:'2026-01-01'});
    assert.match(elements.undoRecords.innerHTML,/撤销删除/);
    assert.equal(elements.toolMask.hidden,true);
    assert.equal(vm.runInContext('S.currentRecord',context),null);
    const button={disabled:false};context.undoButton=button;
    await vm.runInContext(`undoRecord('${kind}',23,undoButton)`,context);
    assert.equal(calls[1].url,'/api/restore');assert.equal(elements.undoRecords.hidden,true);
  }
});
test('cancelling manual deletion does not call any API',async()=>{
  const {context,calls,elements}=deletionContext('meal',false);
  await vm.runInContext('deleteRecord()',context);
  assert.equal(calls.length,0);assert.equal(elements.toolMask.hidden,false);
});
test('failed deletion retains the edit dialog and allows retry',async()=>{
  const {context,elements}=deletionContext('exercise',true,true);
  await vm.runInContext('deleteRecord()',context);
  assert.equal(elements.toolMask.hidden,false);assert.equal(elements.deleteRecordBtn.disabled,false);
  assert.equal(elements.confirmToolBtn.disabled,false);assert.equal(vm.runInContext('undoRecords.length',context),0);
});
