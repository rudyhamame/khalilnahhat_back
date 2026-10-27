const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {defaults,configSchema,createAiConfiguration,registerAiConfiguration,publicPolicy,providerEstimate}=require('./ai-configuration');
const UUID='f26bdf9f-ffb1-4ef1-8478-16c97f02d444';
function fixture(){
 let saved=null;const usage=new Map(),access=[];
 const clone=value=>structuredClone(value);
 const store={
  getConfig:async()=>clone(saved),
  saveConfig:async(value,owner)=>{if((saved?.value.revision||0)!==value.revision)return null;saved={value:{...clone(value),revision:value.revision+1},updatedBy:owner};return clone(saved);},
  reserve:async(item)=>{const old=usage.get(item._id);if(old&&old.state!=='failed')return null;usage.set(item._id,{...clone(item),createdAt:new Date()});return clone(item);},
  complete:async(id,value)=>{const item=usage.get(id);if(!item||item.state!=='pending')return null;Object.assign(item,clone(value),{state:'completed'});return clone(item);},
  fail:async(id)=>{const item=usage.get(id);if(item?.state==='pending')Object.assign(item,{state:'failed',billingStatus:'included',customerCents:0});},
  updateMetrics:async(id,metrics)=>{usage.get(id).metrics=metrics;},
  listUsage:async()=>clone([...usage.values()]),
  billing:async(id,owner,body)=>{const item=usage.get(id);if(!item||item.state!=='completed'||!(body.status==='paid'?['invoiced']:['unbilled','invoiced']).includes(item.billingStatus))return null;Object.assign(item,{billingStatus:body.status,reference:body.reference,updatedBy:owner});return clone(item);},
 };
 const service=createAiConfiguration({store,env:{OPENAI_API_KEY:'never-expose-this'},fetchImpl:async url=>{access.push(url);return new Response(null,{status:200});}});
 return {service,store,usage,access};
}
test('default policy preserves model choices, includes AI, and keeps provider/customer currencies separate',()=>{
 const config=defaults({});assert.equal(configSchema.safeParse(config).success,true);assert.equal(config.voice.model,'gpt-realtime-2.1-mini');assert.equal(config.customerPricing.policy,'included');assert.equal(config.customerPricing.currency,'CAD');
 assert.equal(publicPolicy(config).chat.providerRates,undefined);assert.equal(providerEstimate(config,'voice',{}),null);
 assert.equal(providerEstimate(config,'chat',{inputTokens:1000000,cachedInputTokens:500000,outputTokens:1000000}),0.7125);
});
test('configuration persists, validates mode capabilities, checks access, and rejects stale writes',async()=>{
 const {service,access}=fixture();const first=await service.load();first.chat.model='gpt-5.6-luna';first.chat.maxOutputTokens=3000;
 const saved=await service.save(first,'admin');assert.equal(saved.revision,1);assert.equal((await service.load()).chat.model,'gpt-5.6-luna');assert.equal(access.length,2);
 await assert.rejects(service.save(first,'another-admin'),{status:409});
 const bad={...saved,chat:{...saved.chat,model:'gpt-realtime-2.1'}};await assert.rejects(service.save(bad,'admin'),{status:400});
 await assert.rejects(service.save({...saved,OPENAI_API_KEY:'exfiltrate'},'admin'),{status:400});
});
test('inaccessible models cannot be saved',async()=>{
 const {store}=fixture();const service=createAiConfiguration({store,env:{OPENAI_API_KEY:'private'},fetchImpl:async()=>new Response('private provider details',{status:403})});
 await assert.rejects(service.save(defaults({}),'admin'),error=>error.status===400&&!error.message.includes('private'));
 assert.equal((await service.load()).revision,0);
});
test('paid usage requires current price acceptance and duplicate completions cannot bill twice',async()=>{
 const {service}=fixture();const config=defaults({});config.customerPricing={policy:'manual_invoice',currency:'CAD',chatReplyCents:125,voiceSessionCents:250};const saved=await service.save(config,'admin');
 const request={owner:'alice',mode:'chat',config:saved,requestId:UUID};
 await assert.rejects(service.reserve(request),{status:402});await assert.rejects(service.reserve({...request,pricingConsentRevision:0}),{status:402});
 const ticket=await service.reserve({...request,pricingConsentRevision:saved.revision});
 await service.complete(ticket,{inputTokens:100,outputTokens:50});
 await assert.rejects(service.reserve({...request,pricingConsentRevision:saved.revision}),{status:409});
 let rows=await service.listUsage();assert.equal(rows.length,1);assert.equal(rows[0].customerCents,125);assert.equal(rows[0].billingStatus,'unbilled');
 const bob=await service.reserve({...request,owner:'bob',pricingConsentRevision:saved.revision});await service.complete(bob,{},false);
 rows=await service.listUsage();assert.equal(rows[1].customerCents,0);assert.equal(rows[1].billingStatus,'included');
});
test('failed requests may retry without charging; existing sessions keep their accepted fee',async()=>{
 const {service}=fixture();const config=defaults({});config.customerPricing.policy='manual_invoice';config.customerPricing.voiceSessionCents=250;const saved=await service.save(config,'admin');
 const request={owner:'alice',mode:'voice',config:saved,requestId:UUID,pricingConsentRevision:saved.revision};const first=await service.reserve(request);await service.fail(first);
 const retry=await service.reserve(request);const changed=structuredClone(saved);changed.customerPricing.voiceSessionCents=999;await service.save(changed,'admin');
 await service.complete(retry,{connectionMs:100});const rows=await service.listUsage();assert.equal(rows.length,1);assert.equal(rows[0].customerCents,250);
});
test('billing transitions require an invoice before payment and cannot record payment twice',async()=>{
 const {service}=fixture();const config=defaults({});config.customerPricing.policy='manual_invoice';config.customerPricing.chatReplyCents=100;const saved=await service.save(config,'admin');
 const ticket=await service.reserve({owner:'alice',mode:'chat',config:saved,requestId:UUID,pricingConsentRevision:1});await service.complete(ticket,{});
 await assert.rejects(service.billing(ticket.id,'admin',{status:'paid',reference:'bank-1',paymentMethod:'etransfer'}),{status:409});
 await service.billing(ticket.id,'admin',{status:'invoiced',reference:'invoice-1'});
 await assert.rejects(service.billing(ticket.id,'admin',{status:'paid',reference:'bank-1'}),{status:400});
 await service.billing(ticket.id,'admin',{status:'paid',reference:'bank-1',paymentMethod:'etransfer'});
 await assert.rejects(service.billing(ticket.id,'admin',{status:'paid',reference:'bank-1',paymentMethod:'etransfer'}),{status:409});
 await assert.rejects(service.billing(ticket.id,'admin',{status:'void',reference:'silently undo payment'}),{status:409});
});
test('admin configuration and usage routes reject customers and expose no provider key',async t=>{
 const {service}=fixture();const app=express();app.use(express.json());const requireAdmin=(req,res,next)=>{if(req.headers.authorization!=='Bearer admin')return res.status(403).json({message:'Admin required'});req.user={_id:'admin'};next();};registerAiConfiguration(app,{requireAdmin,service});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}/api/ai-booking/admin`;
 for(const path of ['/config','/usage'])assert.equal((await fetch(base+path,{headers:{Authorization:'Bearer customer'}})).status,403);
 const get=await fetch(base+'/config',{headers:{Authorization:'Bearer admin'}});assert.equal(get.status,200);assert.doesNotMatch(await get.text(),/never-expose-this|OPENAI_API_KEY/);
 const save=await fetch(base+'/config',{method:'PUT',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:JSON.stringify(defaults({}))});assert.equal(save.status,200);assert.equal((await save.json()).item.revision,1);
});
