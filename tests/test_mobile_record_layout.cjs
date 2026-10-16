// Optional browser regression: NODE_PATH must include playwright; uses synthetic data only.
// Run: node --test tests/test_mobile_record_layout.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const staticDir = path.join(__dirname, '../static');

test('long meal dialogs keep actions reachable across mobile sizes and keyboard changes', async () => {
  const browser = await chromium.launch({headless:true, channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge'});
  try {
    for (const [width,height] of [[320,568],[390,844],[844,390],[1280,800]]) {
      const page = await browser.newPage({viewport:{width,height}, hasTouch:true,reducedMotion:'reduce'});
      await page.addInitScript(() => {
        // Model keyboard resize/pan events without relying on a headless OS keyboard.
        const viewport = new EventTarget();
        Object.assign(viewport, {height:innerHeight,offsetTop:0,scale:1});
        Object.defineProperty(window,'visualViewport',{value:viewport});
      });
      await page.route('http://fitai.test/**', async route => {
        const name = path.basename(new URL(route.request().url()).pathname) || 'index.html';
        const file = path.join(staticDir,name);
        if (!fs.existsSync(file)) return route.fulfill({status:404,body:''});
        let body = fs.readFileSync(file);
        if(name==='app.js') body=Buffer.from(body.toString().replace(/\binit\(\);\s*$/, ''));
        await route.fulfill({body,contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':name.endsWith('.svg')?'image/svg+xml':'text/html'});
      });
      await page.goto('http://fitai.test/');
      await page.evaluate(() => {
        bind();
        const items=Array.from({length:8},(_,i)=>({name:`测试食物 ${i+1}`,grams:100,amount:'100g',kj:500,protein:10,carb:15,fat:3}));
        S.messages=[{id:1,tool_calls:[{id:'meal-test',name:'log_meal',arguments:{date:'2026-10-04',meal_type:'午餐',items}}]}];
        S.sessionId=1;
        window.savedCalls=[];
        api.post=async(url,body)=>{window.savedCalls.push({url,body});return {};};
        loadMessages=async()=>{};loadState=async()=>{};toast=()=>{};
        openTool(1,'meal-test');
      });
      await page.locator('.tool-modal').evaluate(el=>el.getAnimations().forEach(a=>a.finish()));
      async function assertReachable() {
        const result=await page.evaluate(()=>{
          const button=document.querySelector('#confirmToolBtn'),r=button.getBoundingClientRect();
          const modal=document.querySelector('.tool-modal').getBoundingClientRect();
          const content=document.querySelector('.tool-modal-content');
          const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return {top:r.top,bottom:r.bottom,height:r.height,visibleTop:visualViewport.offsetTop,visibleBottom:visualViewport.offsetTop+visualViewport.height,
            hit:button===hit||button.contains(hit),modalTop:modal.top,modalBottom:modal.bottom,
            overflow:content.scrollHeight>content.clientHeight,horizontal:content.scrollWidth>content.clientWidth};
        });
        assert.ok(result.top>=result.visibleTop && result.bottom<=result.visibleBottom,JSON.stringify(result));
        assert.ok(result.modalTop>=result.visibleTop && result.modalBottom<=result.visibleBottom,JSON.stringify(result));
        assert.ok(result.height>=44 && result.hit,JSON.stringify(result));
        assert.ok(result.overflow);assert.equal(result.horizontal,false);
      }
      await assertReachable();
      const content=page.locator('.tool-modal-content');
      // Desktop engines have no Safari toolbar. Model its expanded svh while
      // visualViewport still reports the larger height, then delayed updates.
      if (width<=844) {
        const safeHeight=height-110;
        await page.evaluate(safeHeight=>{
          document.documentElement.style.setProperty('--modal-safe-height',`${safeHeight}px`);
          const toolbar=document.createElement('div');toolbar.id='safari-toolbar-fixture';
          Object.assign(toolbar.style,{position:'fixed',left:'0',right:'0',top:`${safeHeight}px`,bottom:'0',zIndex:'9999',background:'#ddd'});
          toolbar.textContent='Safari 地址栏（模拟）';document.body.append(toolbar);
        },safeHeight);
        async function assertAboveToolbar() {
          await assertReachable();
          const box=await page.locator('.tool-modal').boundingBox();
          assert.ok(box.y+box.height<=safeHeight,`Dialog overlaps Safari toolbar: ${JSON.stringify(box)}`);
          await page.locator('#confirmToolBtn').click({trial:true});
        }
        await assertAboveToolbar();
        await content.evaluate(el=>{el.scrollTop=el.scrollHeight;});
        await assertAboveToolbar();
        for (const reportedHeight of [safeHeight,height,safeHeight]) {
          await page.evaluate(reportedHeight=>{
            visualViewport.height=reportedHeight;visualViewport.dispatchEvent(new Event('resize'));
          },reportedHeight);
          await assertAboveToolbar();
        }
        await page.evaluate(()=>{
          document.querySelector('#safari-toolbar-fixture').remove();
          document.documentElement.style.removeProperty('--modal-safe-height');
          visualViewport.height=innerHeight;visualViewport.dispatchEvent(new Event('resize'));
        });
        await content.evaluate(el=>{el.scrollTop=0;});
      }
      await content.hover();await page.mouse.wheel(0,600);
      await page.waitForFunction(()=>document.querySelector('.tool-modal-content').scrollTop>0);
      await assertReachable();
      await content.evaluate(el=>{el.scrollTop=el.scrollHeight;});
      const lastInput=page.locator('#toolEditor input').last();
      await lastInput.fill('5');
      await assertReachable();
      await page.evaluate(()=>{
        visualViewport.height=260;visualViewport.offsetTop=30;
        visualViewport.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('scroll'));
      });
      await assertReachable();
      await lastInput.focus();
      await page.waitForFunction(()=>{
        const field=document.activeElement.getBoundingClientRect();
        const content=document.querySelector('.tool-modal-content').getBoundingClientRect();
        return field.top>=content.top && field.bottom<=content.bottom;
      });
      await assertReachable();
      await page.locator('#confirmToolBtn').click();
      const calls=await page.evaluate(()=>window.savedCalls);
      assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/agent/tool');
      assert.equal(calls[0].body.arguments.items.length,8);
      assert.equal(await page.locator('#toolMask').isVisible(),false);
      await page.evaluate(()=>{
        visualViewport.height=innerHeight;visualViewport.offsetTop=0;visualViewport.dispatchEvent(new Event('resize'));
        openTool(1,'meal-test');
      });
      assert.equal(await content.evaluate(el=>el.scrollTop),0);
      await assertReachable();
      if (process.env.UI_SCREENSHOT_DIR && width===390) {
        fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'mobile-meal-dialog.png')});
      }
      // Existing-record mode has a third action, which must fit or wrap on narrow screens.
      await page.evaluate(()=>{document.querySelector('#deleteRecordBtn').hidden=false;});
      await assertReachable();
      await page.locator('[data-close="toolMask"]').click();
      assert.equal(await page.locator('#toolMask').isVisible(),false);
      await page.close();
      console.log(`Verified ${width}x${height}: 8 foods, scroll, simulated Safari toolbar, keyboard, confirm, reopen, close`);
    }
  } finally {await browser.close();}
});
