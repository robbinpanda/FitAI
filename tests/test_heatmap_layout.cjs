const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const staticDir=path.join(__dirname,'../static');

test('monthly heatmap counts records, changes months, handles races and fits phone font sizes',async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:393,height:852},hasTouch:true,reducedMotion:'reduce'});
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
      window.heatRequests=[];
      api.get=async url=>{
        heatRequests.push(url);
        const end=new URL(url,location.href).searchParams.get('end'),month=end.slice(0,7);
        const days=heatmapMonthInfo(month).days;
        return {history:Array.from({length:days},(_,i)=>({date:`${month}-${String(i+1).padStart(2,'0')}`,record_counts:{meal:i%4,exercise:i%3===0?1:0,weight:i%2}}))};
      };
      S.state={display_unit:'kcal'};bind();goPage('trend');
    });
    await page.waitForFunction(()=>H.loaded===H.month);
    assert.equal(await page.locator('#heatmapNext').isDisabled(),true);
    const current=await page.evaluate(()=>TODAY.slice(0,7));
    const future=page.locator('.heatmap-day:disabled');
    assert.equal(await future.count(),await page.evaluate(()=>heatmapMonthInfo(H.month).days-Number(TODAY.slice(8))));
    await page.evaluate(()=>{H.month='2024-02';H.selected=null;loadHeatmap()});
    await page.waitForFunction(()=>H.loaded==='2024-02');
    assert.equal(await page.locator('.heatmap-day').count(),29);
    assert.equal(await page.locator('.heatmap-grid>span').count(),3);
    assert.equal(await page.locator('[data-heatmap-date="2024-02-04"]').getAttribute('data-level'),'4');
    await page.locator('[data-heatmap-date="2024-02-04"]').click();
    assert.match(await page.locator('#heatmapDetail').textContent(),/饮食 3 条 \/ 运动 1 条 \/ 体重 1 条/);
    assert.equal(await page.locator('[data-heatmap-date="2024-02-04"]').getAttribute('aria-pressed'),'true');
    const summary=await page.locator('#heatmapSummary').textContent();assert.match(summary,/本月已记录 \d+ 天 · 共 \d+ 条/);
    await page.locator('#rangeSwitch [data-range="7"]').click();
    assert.equal(await page.locator('#heatmapSummary').textContent(),summary);
    for(const [width,height] of [[320,568],[393,852],[430,932],[844,390],[1280,800]]){
      await page.setViewportSize({width,height});
      for(const size of ['standard','large','xlarge']){
        await page.evaluate(size=>window.AppAppearance.set(size),size);
        await page.locator('.consistency-card').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('.consistency-card').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,`${width} ${size}`);
        const cell=await page.locator('.heatmap-day').first().boundingBox();
        assert.ok(Math.abs(cell.width-cell.height)<1);assert.ok(cell.width>=24);
      }
    }
    await page.setViewportSize({width:393,height:852});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#sidebar')).visibility==='hidden');
    if(process.env.UI_SCREENSHOT_DIR){
      fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
      await page.locator('.consistency-card').screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'monthly-heatmap.png')});
    }
    await page.evaluate(()=>{H.month='2024-01';loadHeatmap()});
    await page.waitForFunction(()=>H.loaded==='2024-01');
    await page.locator('#heatmapPrev').click();
    await page.waitForFunction(()=>H.loaded==='2023-12');
    assert.equal(await page.locator('.heatmap-day').count(),31);
    await page.locator('#heatmapNext').click();
    await page.waitForFunction(()=>H.loaded==='2024-01');
    // A late response from an older navigation cannot replace the visible month.
    await page.evaluate(async()=>{
      const original=api.get;let release;
      api.get=url=>url.includes('2024-03')?new Promise(resolve=>release=resolve):original(url);
      H.month='2024-03';loadHeatmap();H.month='2024-04';await loadHeatmap();
      release({history:[]});await Promise.resolve();api.get=original;
    });
    assert.equal(await page.evaluate(()=>H.loaded),'2024-04');
    assert.match(await page.locator('#heatmapMonth').textContent(),/2024 年 4 月/);
    // Failure must offer retry, not silently claim no records.
    await page.evaluate(async()=>{
      window.originalHeatGet=api.get;api.get=async()=>{throw Error('offline')};
      H.month='2024-05';await loadHeatmap();
    });
    assert.match(await page.locator('#monthHeatmap').textContent(),/加载失败/);
    assert.equal(await page.locator('#heatmapSummary').textContent(),'');
    await page.evaluate(()=>api.get=async()=>({history:[]}));
    await page.locator('[data-heatmap-retry]').click();
    await page.waitForFunction(()=>H.loaded==='2024-05');
    assert.equal(await page.locator('#heatmapSummary').textContent(),'本月已记录 0 天 · 共 0 条');
    await page.evaluate(month=>{api.get=originalHeatGet;H.month=month;loadHeatmap()},current);
    await page.waitForFunction(()=>H.loaded===TODAY.slice(0,7));
    await page.evaluate(()=>changeHeatmapMonth(1));
    assert.equal(await page.evaluate(()=>H.month),current);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
