const {test}=require('node:test');
const assert=require('node:assert/strict');
const {replyPrefix,consumeResponseStream}=require('./ai-booking-stream');
test('partial JSON replies preserve escaped quotes, newlines, and Unicode without exposing patch data',()=>{
 const reply='Hello "there"\nمرحبا 🎉',text=JSON.stringify({reply,orderPatch:[{path:'event.type',value:'wedding'}]});
 for(let i=0;i<=text.length;i++)assert.ok(reply.startsWith(replyPrefix(text.slice(0,i))));
 assert.equal(replyPrefix(text),reply);assert.equal(replyPrefix('{"orderPatch":[]'), '');
 assert.equal(replyPrefix('{"reply":"Hi\\u06'),'Hi');assert.equal(replyPrefix('{"reply":"Hi\\u0627'),'Hiا');
});
test('SSE parsing survives arbitrary UTF-8 chunks and CRLF boundaries',async()=>{
 const reply='مرحبا 🎉';const events=[{type:'response.output_text.delta',delta:JSON.stringify({reply,orderPatch:[]})},{type:'response.completed',response:{status:'completed',output:[]}}];
 const bytes=new TextEncoder().encode(events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join(''));
 const body=new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}});
 let streamed='';const response=await consumeResponseStream(body,delta=>{streamed+=delta;});
 assert.equal(streamed,reply);assert.equal(response.status,'completed');
});
