const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const core=require('../src/event-order');
const {registerEventDrafts}=require('../src/event-drafts');
const {registerBookingConversations}=require('../src/booking-conversations');
const {registerServiceRequestSubmission}=require('../src/service-request-submission');

async function fixture(t){
 const drafts=new Map(),conversations=new Map(),requests=[],retired=new Set();let notifications=0;
 const owner='qa-client',app=express();app.use(express.json());
 const auth=(req,res,next)=>{if(!req.headers.authorization)return res.sendStatus(401);req.authUser={_id:req.headers.authorization,firstName:'Booking',lastName:'QA TEST ONLY',email:'booking-qa@example.invalid',username:'booking-qa'};next();};
 const conversationStore={list:async id=>[...conversations.values()].filter(row=>row.owner===id),get:async(id,draftId)=>conversations.get(id+draftId)||null,append:async(id,draftId,messages)=>{if(retired.has(id+draftId))throw Object.assign(Error('Deleted'),{status:409});const key=id+draftId,old=conversations.get(key)||{_id:draftId,owner:id,messages:[]};for(const message of messages)if(!old.messages.some(row=>row.id===message.id))old.messages.push({...message,createdAt:new Date()});conversations.set(key,old);return {id:draftId};}};
 const draftStore={get:async id=>drafts.get(id)||null,put:async(id,version,order,draftId)=>{const old=drafts.get(id);if(retired.has(id+draftId)||(old?old.version!==version||old.draftId!==draftId:version!==0))return null;const next={draftId,order,version:version+1};drafts.set(id,next);return next;},remove:async(id,version,draftId)=>{const old=drafts.get(id);if(!old||old.version!==version||old.draftId!==draftId)return false;return drafts.delete(id);}};
 registerEventDrafts(app,{requireAuth:auth,store:draftStore,retireDraft:async(id,draftId)=>retired.add(id+draftId),removeConversation:async(id,draftId)=>conversations.delete(id+draftId)});
 registerBookingConversations(app,{requireAuth:auth,store:conversationStore});
 registerServiceRequestSubmission(app,{requireAuth:auth,ServiceRequest:{init:async()=>{},findOne:query=>({select:async()=>requests.find(row=>row.userId===query.userId&&row.clientSubmissionId===query.clientSubmissionId)}),create:async row=>{requests.push(row);return row;}},Equipment:{find:async()=>[]},vouchers:{},serializeServiceRequest:row=>({id:row.externalId,requestNumber:row.requestNumber,status:row.status,order:row.order,conversation:row.conversation}),sendServiceRequestNotification:async()=>{notifications++;return {sent:true};},loadConversation:conversationStore.get});
 app.get('/api/service-requests/admin',auth,(req,res)=>req.authUser._id==='qa-admin'?res.json({items:requests}):res.sendStatus(403));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=async(path,{method='GET',body,user=owner}={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{Authorization:user,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json().catch(()=>null)};};
 return {call,owner,drafts,conversations,requests,get notifications(){return notifications;}};
}
for(const [eventType,mode,language] of [['wedding','chat','English'],['graduation','voice','Arabic']])test(`${language}: complete assisted draft, correction, submission, admin receipt and draft retirement`,async t=>{
 const f=await fixture(t),draftId=randomUUID(),segmentId=randomUUID();let order=core.createEventOrder(),version=0;
 const changes={'customer.fullName':'Booking QA','customer.email':'qa@example.invalid','customer.phone':'4165550100','customer.contactMethod':'email','event.type':eventType,'event.date':'2027-12-14','event.startTime':'18:00','event.endTime':'01:00','event.guestCount':75,'event.venue.name':'QA TEST ONLY venue','event.venue.address':'1 Example Street','event.venue.city':'Toronto','event.venue.postalCode':'M1A 1A1','event.venue.area':'gta','event.venue.setting':'indoor','music.djRequested':true,'music.mcRequested':false,'rental.requested':false,'additional.notes':'QA TEST ONLY — no real event. Do not quote or contact.'};
 for(const [path,value] of Object.entries(changes)){
  order=core.applyOrderPatch(order,[{path,value}]);
  const saved=await f.call('/ai-booking/event-draft',{method:'PUT',body:{version,draftId,order}});assert.equal(saved.status,200,path);version=saved.data.item.version;
 }
 order=core.applyOrderPatch(order,[{path:'event.guestCount',value:80}]);assert.equal((await f.call('/ai-booking/event-draft',{method:'PUT',body:{version,draftId,order}})).status,200);version++;
 const messages=[{id:randomUUID(),role:'user',content:language==='Arabic'?'اختبار حجز حفل تخرج فقط، ليس فعالية حقيقية.':'QA TEST ONLY: please help book this wedding.',mode,segmentId},{id:randomUUID(),role:'assistant',content:language==='Arabic'?'تم تحديث المسودة. يمكنك تعديل المهام.':'Draft updated; tasks can be modified.',mode,segmentId},{id:randomUUID(),role:'user',content:'Change the guest count to 80.',mode:'chat',segmentId:randomUUID()}];
 assert.equal((await f.call('/ai-booking/conversations',{method:'POST',body:{consent:true,id:draftId,messages}})).status,200);
 const body={clientSubmissionId:randomUUID(),draftId,order,event:core.orderToLegacy(order),items:[{serviceId:'svc-dj',name:'DJ',category:'service',quantity:1}]};
 const receipt=await f.call('/service-requests',{method:'POST',body});assert.equal(receipt.status,201);assert.ok(receipt.data.item.requestNumber);assert.equal(receipt.data.item.status,'pending');
 const retry=await f.call('/service-requests',{method:'POST',body});assert.equal(retry.status,200);assert.equal(retry.data.item.id,receipt.data.item.id);assert.equal(f.notifications,1);
 const admin=await f.call('/service-requests/admin',{user:'qa-admin'});assert.equal(admin.status,200);assert.equal(admin.data.items.length,1);
 const submitted=admin.data.items[0];assert.equal(submitted.order.event.guestCount,80);assert.equal(submitted.conversation.messages.length,3);assert.equal(submitted.conversation.messages[0].mode,mode);assert.equal(submitted.order.customer.email,'booking-qa@example.invalid');
 const removed=await f.call(`/ai-booking/event-draft?version=${version}&draftId=${draftId}`,{method:'DELETE'});assert.equal(removed.status,200);assert.equal(removed.data.conversationRemoved,true);assert.equal(f.drafts.size,0);assert.equal(f.conversations.size,0);
 assert.equal(f.requests[0].conversation.messages.length,3,'the submitted admin snapshot survives draft deletion');
 assert.equal((await f.call('/ai-booking/event-draft',{method:'PUT',body:{version:0,draftId,order}})).status,409,'late writes cannot resurrect the submitted draft');
});
