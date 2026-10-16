const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../static/appearance.js'),'utf8');

test('font preference restores valid choices, rejects bad values and survives blocked storage',()=>{
  for(const saved of ['standard','large','xlarge','invalid',null]) {
    let written;
    const context = vm.createContext({window:{},document:{documentElement:{dataset:{}}},localStorage:{getItem:()=>saved,setItem:(key,value)=>{written={key,value}}}});
    vm.runInContext(source,context);
    assert.equal(context.window.AppAppearance.get(),['large','xlarge'].includes(saved)?saved:'standard');
    assert.equal(context.window.AppAppearance.set('xlarge'),true);
    assert.equal(context.document.documentElement.dataset.fontSize,'xlarge');
    assert.equal(written.key,'paipaiji-font-size');assert.equal(written.value,'xlarge');
  }
  const context=vm.createContext({window:{},document:{documentElement:{dataset:{}}},localStorage:{getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}}});
  vm.runInContext(source,context);
  assert.equal(context.window.AppAppearance.get(),'standard');
  assert.equal(context.window.AppAppearance.set('large'),false);
  assert.equal(context.document.documentElement.dataset.fontSize,'large');
});
