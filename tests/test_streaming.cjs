const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../static/app.js'),'utf8').replace(/\binit\(\);\s*$/, '');
function client(response) {
  const context = vm.createContext({console,Date,URL,TextDecoder,AbortController,
    fetch:async(url,options)=>{context.request={url,options};return response;}});
  vm.runInContext(source,context);
  context.events=[];
  return {context,run:()=>vm.runInContext("streamAgent({question:'测试'},(kind,data)=>events.push({kind,data}),new AbortController().signal)",context)};
}
function response(text, chunkSize=1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(controller){
    for(let i=0;i<bytes.length;i+=chunkSize)controller.enqueue(bytes.slice(i,i+chunkSize));
    controller.close();
  }}),{headers:{'content-type':'text/event-stream'}});
}
test('SSE handles split UTF-8, CRLF, multiple frames and final result',async()=>{
  const c=client(response('event: reply\r\ndata: {"text":"半碗米饭 🥣"}\r\n\r\nevent: done\ndata: {"ok":true,"reply":"完成"}\n\n'));
  const result=await c.run();
  assert.equal(result.reply,'完成');
  assert.equal(c.context.events[0].data.text,'半碗米饭 🥣');
  assert.equal(JSON.parse(c.context.request.options.body).stream,true);
  assert.ok(c.context.request.options.signal);
});
test('stream error after partial text rejects instead of reporting success',async()=>{
  const c=client(response('event: reply\ndata: {"text":"暂存"}\n\nevent: error\ndata: {"error":"校验失败"}\n\n',17));
  await assert.rejects(c.run(),/校验失败/);
});
test('EOF without done never counts as a completed record',async()=>{
  const c=client(response('event: reply\ndata: {"text":"未完成"}\n\n'));
  await assert.rejects(c.run(),/连接已中断/);
});
test('regular preflight HTTP errors retain their useful error message',async()=>{
  const c=client(new Response('{"error":"请配置模型"}',{status:400,headers:{'content-type':'application/json'}}));
  await assert.rejects(c.run(),/请配置模型/);
});
test('older JSON servers remain compatible',async()=>{
  const c=client(new Response('{"ok":true,"reply":"兼容回复"}',{headers:{'content-type':'application/json'}}));
  assert.equal((await c.run()).reply,'兼容回复');
});
