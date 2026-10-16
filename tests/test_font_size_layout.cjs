// NODE_PATH must include Playwright; only local assets and synthetic data are used.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const staticDir=path.join(__dirname,'../static');

test('font choices enlarge actual content, persist, and fit narrow phone pages',async()=>{
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
  try{
    for(const [width,height] of [[320,568],[393,852],[430,932],[844,390],[1280,800]]){
      const page=await browser.newPage({viewport:{width,height},hasTouch:true,reducedMotion:'reduce'});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('http://fitai.test/**',async route=>{
        const name=path.basename(new URL(route.request().url()).pathname)||'index.html',file=path.join(staticDir,name);
        if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
        let body=fs.readFileSync(file);
        if(name==='app.js')body=Buffer.from(body.toString().replace(/\binit\(\);\s*$/,''));
        await route.fulfill({body,contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':name.endsWith('.svg')?'image/svg+xml':'text/html'});
      });
      await page.goto('http://fitai.test/');
      await page.evaluate(()=>{
        bind();updateDateHeader();S.username='阅读测试';
        S.state={display_unit:'kcal',settings:{has_key:true},today:{profile:{},meals:[],exercises:[]}};
        S.messages=[{id:1,role:'user',content:'早上吃了两片面包和一杯牛奶。'},{id:2,role:'assistant',content:'我已整理好这顿早餐。请核对份量，确认后再保存。',tool_calls:[{id:'font-meal',name:'log_meal',status:'pending',arguments:{date:'2026-10-16',meal_type:'早餐',items:[{name:'全麦面包',amount:'两片',grams:70,kj:750,protein:6,carb:30,fat:4},{name:'牛奶',amount:'一杯',grams:250,kj:640,protein:8,carb:12,fat:8}]}}]}];
        renderMessages();$('#chatInput').value='尚未发送的草稿';
        api.post=async()=>{throw Error('Font changes must not call business APIs')};
        openSettings('appearance');
      });
      assert.equal(await page.locator('.composer-shortcuts,[data-record-intent]').count(),0);
      for(const [choice,expected] of [['standard',15],['large',18],['xlarge',21]]){
        await page.locator(`[data-font-choice="${choice}"]`).click();
        assert.equal(await page.locator(`[data-font-choice="${choice}"]`).getAttribute('aria-pressed'),'true');
        assert.equal(await page.locator('#accountSavebar').isVisible(),false);
        assert.match(await page.locator('#fontSizeStatus').textContent(),/已应用并保存/);
        assert.equal(await page.locator('.message-text').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),expected);
        assert.equal(await page.locator('.font-preview-text').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),expected);
        assert.equal(await page.locator('#chatInput').inputValue(),'尚未发送的草稿');
        for(const tab of ['profile','plan','model','search','data','security','appearance']){
          await page.evaluate(tab=>selectSettingsTab(tab),tab);
          const overflow=await page.locator('.account-panel').evaluate(el=>el.scrollWidth>el.clientWidth+1);
          assert.equal(overflow,false,`${width} ${choice} ${tab}`);
        }
        await page.evaluate(()=>{goPage('chat');$('#chatInput').value='尚未发送的草稿';resizeInput()});
        const sizes=await page.evaluate(()=>{
          const composer=$('.composer').getBoundingClientRect(),nav=$('.mobile-nav').getBoundingClientRect();
          const button=$('#sendBtn'),r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return {overflow:document.documentElement.scrollWidth>innerWidth,composerBottom:composer.bottom,navTop:nav.top,buttonHit:hit===button||button.contains(hit),cardOverflow:$('.tool-card').scrollWidth>$('.tool-card').clientWidth+1};
        });
        assert.equal(sizes.overflow,false,`${width} ${choice}`);assert.equal(sizes.cardOverflow,false);
        assert.ok(sizes.buttonHit);if(width<=1100)assert.ok(sizes.composerBottom<=sizes.navTop);
        if(width===393&&choice==='xlarge'&&process.env.UI_SCREENSHOT_DIR){
          fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
          await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'chat-extra-large.png')});
        }
        // Confirmation remains reachable with enlarged labels and input text.
        await page.evaluate(()=>openTool(2,'font-meal'));
        await page.locator('#confirmToolBtn').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#confirmToolBtn').isVisible(),true);
        assert.equal(await page.locator('.tool-modal').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
        await page.locator('[data-close="toolMask"]').click();
        await page.evaluate(()=>openSettings('appearance'));
      }
      if(width===393&&process.env.UI_SCREENSHOT_DIR){
        await page.locator('#settingsTitle').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'font-size-settings.png')});
      }
      await page.reload();
      assert.equal(await page.evaluate(()=>window.AppAppearance.get()),'xlarge');
      assert.equal(await page.locator('html').getAttribute('data-font-size'),'xlarge');
      await page.evaluate(()=>{bind();selectSettingsTab('appearance')});
      assert.equal(await page.locator('[data-font-choice="xlarge"]').getAttribute('aria-pressed'),'true');
      assert.deepEqual(errors,[]);
      await page.close();console.log(`Font settings verified at ${width}x${height}`);
    }
  }finally{await browser.close()}
});
