const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../static/app.js'),'utf8').replace(/\binit\(\);\s*$/, '');
const context = vm.createContext({console,Date,URL});
vm.runInContext(source,context);
function chart(values,type='line') {
  context.points=values.map((value,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,value}));
  context.chartType=type;
  return vm.runInContext('chartFrame(points,chartType)',context);
}
test('weight chart has both axes, weight ticks, units and dates',()=>{
  const html=chart([70.2,70.6,69.9]);
  assert.match(html,/class="chart-axis"/);
  assert.match(html,/>kg<\/text>/);
  assert.match(html,/>日期<\/text>/);
  assert.match(html,/>70\.0<\/text>/);
  assert.match(html,/>09\/01<\/text>/);
  assert.match(html,/>09\/03<\/text>/);
  assert.equal((html.match(/class="chart-hit"/g)||[]).length,3);
  assert.match(html,/aria-label="2026-09-01，70.2 kg"/);
});
test('only actual finite measurements create points and tooltips',()=>{
  const html=chart([70.2,null,NaN,Infinity,69.8]);
  assert.equal((html.match(/class="chart-hit"/g)||[]).length,2);
  assert.match(html,/data-chart-date="2026-09-05" data-chart-value="69.8"/);
  assert.doesNotMatch(html,/data-chart-date="2026-09-02"|NaN|Infinity/);
});
test('single and constant weight readings keep a valid nonzero axis span',()=>{
  for(const values of [[70],[70,70,70],[null,70,null]]){
    const html=chart(values);
    assert.doesNotMatch(html,/NaN|Infinity/);
    assert.match(html,/>70\.0<\/text>/);
    assert.match(html,/data-chart-value="70"/);
  }
});
test('no measurements stays empty, not a fabricated zero-weight chart',()=>{
  const html=chart([null,NaN]);
  assert.match(html,/还没有足够的数据/);
  assert.doesNotMatch(html,/<svg/);
});
test('shared energy chart retains current unit and handles zero intake',()=>{
  vm.runInContext("S.state={display_unit:'kcal'}",context);
  const html=chart([0,null,2300],'bar');
  assert.match(html,/data-chart-value="2300" data-chart-unit="kcal"/);
  assert.match(html,/>0<\/text>/);
  assert.doesNotMatch(chart([0,0],'bar'),/NaN|Infinity/);
});
test('tooltip displays the real value and remains inside the chart edges',()=>{
  const nodes={};
  for(const name of ['.chart-tooltip','.chart-guide','.chart-active'])nodes[name]={style:{},offsetWidth:190,offsetHeight:36,setAttribute(k,v){this[k]=v},removeAttribute(k){delete this[k]}};
  nodes.svg={getBoundingClientRect:()=>({left:20,top:10,width:300,height:210})};
  const root={clientWidth:300,clientHeight:210,querySelector:s=>nodes[s],getBoundingClientRect:()=>({left:20,top:10})};
  context.root=root;
  for(const x of [64,456]){
    context.point={dataset:{chartX:String(x),chartY:'28',chartDate:'2026-09-20',chartValue:'70.2',chartUnit:'kg'}};
    vm.runInContext('showChartPoint(root,point)',context);
    assert.equal(nodes['.chart-tooltip'].textContent,'2026-09-20 · 70.2 kg');
    const left=parseFloat(nodes['.chart-tooltip'].style.left);
    assert.ok(left>=0&&left+190<=300);
    assert.equal(nodes['.chart-active'].cx,x);
  }
});
