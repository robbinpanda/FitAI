// NODE_PATH must include Playwright. Uses only synthetic, locally routed content.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const staticDir = path.join(__dirname, '../static');

test('mobile shell keeps readable controls clear of safe areas and scrollable content', async () => {
  const browser = await chromium.launch({headless:true, channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge'});
  try {
    for (const [width,height,safeTop,safeBottom] of [[320,568,0,0],[393,852,59,34],[430,932,59,34],[844,390,0,21],[980,1700,0,0],[1280,800,0,0]]) {
      const page = await browser.newPage({viewport:{width,height},hasTouch:true,reducedMotion:'reduce'});
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
      await page.evaluate(({safeTop,safeBottom})=>{
        document.documentElement.style.setProperty('--app-safe-top',`${safeTop}px`);
        document.documentElement.style.setProperty('--app-safe-bottom',`${safeBottom}px`);
        bind();updateDateHeader();
        S.messages=[
          {id:1,role:'user',content:'今天早饭吃了两片面包、一杯牛奶。',created_at:'2026-10-16 08:30'},
          {id:2,role:'assistant',content:'我来帮你整理这顿早餐。\n\n面包两片，牛奶一杯。你可以补充份量，我会整理成记录，核对后再保存。',created_at:'2026-10-16 08:30'},
          {id:3,role:'user',content:'下午准备去散步半小时。',created_at:'2026-10-16 14:00'},
          {id:4,role:'assistant',content:'好的，等你走完告诉我，我再帮你整理运动记录。',created_at:'2026-10-16 14:00'}
        ];
        renderMessages();document.querySelector('#aiStatus').textContent='AI 已连接';
      },{safeTop,safeBottom});
      if(width<=1100){
        const layout=await page.evaluate(()=>{
          const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
          const css=s=>getComputedStyle(document.querySelector(s));
          const hit=s=>{const el=document.querySelector(s),r=el.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el===h||el.contains(h)};
          return {header:rect('.topbar'),nav:rect('.mobile-nav'),composer:rect('.composer-wrap'),scroll:rect('.message-scroll'),
            navFont:parseFloat(css('.mobile-nav span').fontSize),navIcon:rect('.mobile-nav svg').width,
            hiddenSidebar:css('.sidebar').visibility==='hidden',blur:css('.mobile-nav').backdropFilter,
            overflow:document.documentElement.scrollWidth>innerWidth,
            hits:['#menuBtn','#topNewChatBtn','#dateButton','#unitBtn','#chatInput','#sendBtn','.mobile-nav button'].every(hit),
            touchTargets:[...document.querySelectorAll('.composer-shortcuts button,.mobile-nav button')].every(el=>el.getBoundingClientRect().height>=44)};
        });
        assert.ok(layout.header.top>=safeTop,JSON.stringify(layout));
        assert.ok(layout.nav.bottom<=height-safeBottom-8,JSON.stringify(layout));
        assert.ok(layout.composer.bottom<=layout.nav.top,JSON.stringify(layout));
        assert.ok(layout.scroll.bottom<=layout.composer.top+1,JSON.stringify(layout));
        assert.ok(layout.scroll.height>=40,JSON.stringify(layout));
        assert.ok(layout.navFont>=13&&layout.navIcon>=26,JSON.stringify(layout));
        assert.equal(layout.blur,'none');assert.ok(layout.hiddenSidebar);
        assert.equal(layout.overflow,false);assert.ok(layout.hits);assert.ok(layout.touchTargets);
        await page.locator('#menuBtn').click();
        assert.equal(await page.locator('#sidebar').isVisible(),true);
        await page.locator('#menuBackdrop').click({position:{x:5,y:100}});
        assert.equal(await page.locator('#sidebar').isVisible(),false);
        if(width===393&&process.env.UI_SCREENSHOT_DIR){
          fs.mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
          await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'mobile-shell-393.png')});
        }
        // All remaining pages must scroll above the navigation, too.
        for(const name of ['today','trend','account']){
          await page.evaluate(name=>goPage(name),name);
          assert.equal(await page.locator('#topNewChatBtn').isVisible(),false);
          const bounds=await page.evaluate(name=>({page:document.querySelector(`#page-${name}`).getBoundingClientRect().bottom,nav:document.querySelector('.mobile-nav').getBoundingClientRect().top}),name);
          assert.ok(bounds.page<=bounds.nav,JSON.stringify(bounds));
        }
      }else{
        assert.equal(await page.locator('.mobile-nav').isVisible(),false);
        assert.equal(await page.locator('#sidebar').isVisible(),true);
      }
      await page.evaluate(()=>goPage('chat'));
      const newButton=page.locator('#topNewChatBtn');
      const buttonRect=await newButton.boundingBox(),headerRect=await page.locator('.topbar').boundingBox();
      assert.ok(buttonRect.height>=44&&buttonRect.y>=headerRect.y&&buttonRect.y+buttonRect.height<=headerRect.y+headerRect.height);
      await page.evaluate(()=>{
        window.created=[];
        S.sessionId='old-session';
        S.sessions=[{id:'old-session',title:'已有记录'}];
        api.post=async(url,body)=>{
          window.created.push({url,body});
          return {session:{id:'new-session'}};
        };
        api.get=async url=>url==='/api/coach/sessions'?{sessions:[{id:'new-session',title:'新对话'},...S.sessions]}:{messages:[]};
        S.busy=true;
      });
      await newButton.click();
      assert.equal(await page.evaluate(()=>window.created.length),0);
      await page.evaluate(()=>{S.busy=false});
      await newButton.click();
      await page.waitForFunction(()=>S.sessionId==='new-session'&&document.activeElement.id==='chatInput');
      const result=await page.evaluate(()=>({calls:window.created,messages:S.messages,sessions:S.sessions,sidebarOpen:document.querySelector('#sidebar').classList.contains('open')}));
      assert.equal(result.calls.length,1);
      assert.equal(result.calls[0].url,'/api/coach/session/create');
      assert.deepEqual(result.messages,[]);
      assert.ok(result.sessions.some(s=>s.id==='old-session'));
      assert.equal(result.sidebarOpen,false);
      assert.deepEqual(errors,[]);
      console.log(`Verified shell ${width}x${height}, safe areas ${safeTop}/${safeBottom}`);
      await page.close();
    }
  }finally{await browser.close();}
});
