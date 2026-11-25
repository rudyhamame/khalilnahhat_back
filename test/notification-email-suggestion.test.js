const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createNotificationBodySuggester,registerNotificationSuggestions}=require('../src/notification-email-suggestion');
const response=(body,extra={})=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({body})}]}],...extra})});
function fixture({reply='Hello {{recipientName}},\n\nReset your password: {{actionUrl}}',enabled=true,fetchImpl,provider='openai',env={OPENAI_API_KEY:'test-only'}}={}){
 let request;
 const suggest=createNotificationBodySuggester({configService:{load:async()=>({chat:{enabled,model:'configured-model',provider,maxOutputTokens:1400}})},env,fetchImpl:fetchImpl||(async(url,options)=>{request={url,...JSON.parse(options.body)};return response(reply);})});
 return {suggest,get request(){return request;}};
}
test('suggestion uses configured AI and email metadata, preserving template details without saving or sending',async()=>{
 const f=fixture();const body={subject:'Reset password',body:'Hello {{recipientName}}. Reset here: {{actionUrl}}'};
 assert.deepEqual(await f.suggest('password-reset',body),{body:'Hello {{recipientName}},\n\nReset your password: {{actionUrl}}'});
 assert.equal(f.request.model,'configured-model');assert.equal(f.request.store,false);assert.equal(f.request.url,'https://api.openai.com/v1/responses');
 const context=JSON.parse(f.request.input[0].content);assert.equal(context.event,'Password reset');assert.deepEqual(context.keepDetails,['actionUrl','recipientName']);assert.equal(context.currentBody,body.body);assert.ok(!('to' in context));
});
test('a blank message can be suggested from its event default; unknown events and overlong input are rejected',async()=>{
 const f=fixture();assert.ok((await f.suggest('password-reset',{})).body);
 await assert.rejects(f.suggest('unknown',{}),{status:404});await assert.rejects(f.suggest('password-reset',{body:'x'.repeat(12001)}),{status:400});
 await assert.rejects(f.suggest('password-reset',{to:'other@example.test'}),{status:400});
});
test('AI output must retain all existing details and required tokens, use plain text and stay within limits',async()=>{
 const input={body:'Hello {{recipientName}} {{actionUrl}}'};
 for(const reply of ['Hello {{recipientName}}','Hello {{actionUrl}}','{{actionUrl}} {{recipientName}} {{unknown}}','{{actionUrl}} {{recipientName}} {{broken','<p>{{actionUrl}} {{recipientName}}</p>','```text\n{{actionUrl}} {{recipientName}}\n```','x'.repeat(12001)]){
  await assert.rejects(fixture({reply}).suggest('password-reset',input),{status:502});
 }
});
test('disabled AI, missing provider key, quota errors, invalid JSON and provider failures are actionable',async()=>{
 await assert.rejects(fixture({enabled:false}).suggest('password-reset',{}),{status:503});
 await assert.rejects(fixture({env:{}}).suggest('password-reset',{}),{status:503});
 await assert.rejects(fixture({fetchImpl:async()=>({ok:false,status:429})}).suggest('password-reset',{}),{status:429});
 await assert.rejects(fixture({fetchImpl:async()=>{throw new Error('Timeout');}}).suggest('password-reset',{}),{status:503});
 await assert.rejects(fixture({fetchImpl:async()=>({ok:true,json:async()=>({output:[]})})}).suggest('password-reset',{}),{status:502});
 await assert.rejects(fixture({fetchImpl:async()=>response('Hello {{actionUrl}}',{status:'incomplete'})}).suggest('password-reset',{}),{status:502});
});
test('suggest-body route is admin-only, returns a suggestion, and reports model failures without mutation',async t=>{
 let calls=0;const app=express();app.use(express.json());
 registerNotificationSuggestions(app,{requireAdmin:(req,res,next)=>req.get('authorization')==='Bearer admin'?next():res.sendStatus(403),suggest:async(id,input)=>{calls++;if(id==='fail')throw Object.assign(new Error('Provider limit'),{status:429});assert.equal(input.body,'Draft');return {body:'Suggestion {{actionUrl}}'};}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(id,auth)=>fetch(`http://127.0.0.1:${server.address().port}/api/admin/notifications/emails/${id}/suggest-body`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer admin'}:{})},body:JSON.stringify({body:'Draft'})});
 assert.equal((await call('password-reset')).status,403);assert.equal(calls,0);
 const result=await call('password-reset',true);assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/no-store/);assert.deepEqual(await result.json(),{body:'Suggestion {{actionUrl}}'});
 const failure=await call('fail',true);assert.equal(failure.status,429);assert.deepEqual(await failure.json(),{message:'Provider limit'});
});
