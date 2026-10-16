// Optional layout regression: requires playwright and an installed browser.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const staticDir = path.join(__dirname,'../static');

test('trend charts keep round points, readable labels and aligned tooltips after resizing',async()=>{
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://fitai.test/**',async route=>{
      const name=path.basename(new URL(route.request().url()).pathname)||'index.html';
      const file=path.join(staticDir,name);
      if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
      let body=fs.readFileSync(file);
      if(name==='app.js')body=Buffer.from(body.toString().replace(/\binit\(\);\s*$/,''));
      await route.fulfill({body,contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':name.endsWith('.svg')?'image/svg+xml':'text/html'});
    });
    await page.goto('http://fitai.test/');
    await page.evaluate(()=>{
      S.state={display_unit:'kcal'};
      S.history=Array.from({length:30},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,weight:72-i*.06+Math.sin(i)*.3,weight_source:'measured',has_meals:i%4!==0,intake:8000+i*23,exercise:500,meal_status:'recorded'}));
      // Render once while hidden, just as initial state loading does.
      renderTrend();bind();goPage('trend');
    });
    for(const [width,height] of [[320,568],[390,844],[844,390],[768,1024],[1024,768],[1440,900],[390,844]]) {
      await page.setViewportSize({width,height});
      for(const range of [7,30]) {
        await page.locator(`#rangeSwitch [data-range="${range}"]`).click();
        await page.waitForFunction(()=>[...document.querySelectorAll('.chart')].every(chart=>{
          const svg=chart.querySelector('svg');return svg && Math.abs(svg.viewBox.baseVal.width-chart.getBoundingClientRect().width)<1;
        }));
        const layout=await page.evaluate(()=>[...document.querySelectorAll('.chart')].map(chart=>{
          const svg=chart.querySelector('svg'),box=svg.getBoundingClientRect(),matrix=svg.getScreenCTM();
          const labels=[...svg.querySelectorAll('text')].map(text=>{const r=text.getBoundingClientRect();return {left:r.left-box.left,right:r.right-box.left,top:r.top-box.top,bottom:r.bottom-box.top};});
          const dot=svg.querySelector('.dot')?.getBoundingClientRect();
          return {id:chart.id,width:box.width,height:box.height,sx:matrix.a,sy:matrix.d,labels,dot:dot?{width:dot.width,height:dot.height}:null,
            fontSize:getComputedStyle(svg.querySelector('.axis-label')).fontSize,overflow:document.querySelector('#page-trend').scrollWidth>document.querySelector('#page-trend').clientWidth};
        }));
        for(const item of layout) {
          assert.ok(Math.abs(item.sx-item.sy)<.001,JSON.stringify(item));
          assert.ok(Math.abs(item.sx-1)<.01,JSON.stringify(item));
          assert.equal(item.overflow,false);assert.equal(item.fontSize,'13px');
          assert.ok(item.height>=210);
          if(item.dot)assert.ok(Math.abs(item.dot.width-item.dot.height)<.1,JSON.stringify(item.dot));
          for(const label of item.labels)assert.ok(label.left>=-1&&label.right<=item.width+1&&label.top>=-1&&label.bottom<=item.height+1,JSON.stringify({item:item.id,label}));
        }
        for(const id of ['weightChart','intakeChart']) {
          const hit=page.locator(`#${id} .chart-hit`).last();await hit.click();
          const tooltip=page.locator(`#${id} .chart-tooltip`);
          assert.equal(await tooltip.isVisible(),true);
          assert.match(await tooltip.textContent(),/2026-09-30/);
          const tip=await tooltip.boundingBox(),chart=await page.locator(`#${id}`).boundingBox();
          assert.ok(tip.x>=chart.x-1&&tip.x+tip.width<=chart.x+chart.width+1);
          assert.ok(tip.y>=chart.y-1&&tip.y+tip.height<=chart.y+chart.height+1);
        }
      }
      if(process.env.UI_SCREENSHOT_DIR && width===390) {
        fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
        for(const id of ['weightChart','intakeChart'])await page.locator(`#${id}`).locator('..').screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,`${id}-mobile.png`)});
      }
      console.log(`Verified charts at ${width}x${height}, 7 and 30 days`);
    }
    await page.evaluate(()=>{S.state.display_unit='kJ';renderTrend();});
    assert.equal(await page.locator('#intakeChart .axis-title').first().textContent(),'kJ');
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
