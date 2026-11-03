const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerServiceRequestSubmission } = require('../src/service-request-submission');

const id='60b34139-905f-4493-88e9-952f82459e76';
const payload=()=>({clientSubmissionId:id,event:{eventType:'wedding',eventDate:'2099-10-12',phone:'4165550100'},items:[{serviceId:'svc-dj',name:'DJ',category:'service',quantity:1}]});

async function fixture(t,options={}) {
 const saved=[];const counters={notify:0,reserve:0,release:0};
 const app=express();app.use(express.json());
 registerServiceRequestSubmission(app,{
  requireAuth:(req,res,next)=>{if(!req.headers.authorization)return res.status(401).json({message:'Sign in.'});req.authUser={_id:req.headers.authorization,firstName:'Test',lastName:'Client',username:'test',email:'test@example.invalid'};next();},
  ServiceRequest:{
   init:async()=>{if(options.failIndex)throw new Error('Index creation failed');},
   findOne:query=>({select:async()=>saved.find(item=>item.userId===query.userId&&item.clientSubmissionId===query.clientSubmissionId)}),
   create:async data=>{
    if(options.failSave)throw new Error('Database unavailable');
    if(saved.some(item=>item.userId===data.userId&&item.clientSubmissionId===data.clientSubmissionId))throw Object.assign(new Error('Duplicate'),{code:11000,keyPattern:{clientSubmissionId:1}});
    saved.push({...data});return saved.at(-1);
   },
  },Equipment:{find:async()=>options.catalog||[]},
  vouchers:{reserve:async()=>{counters.reserve++;return {voucher:{code:'TEST'}};},release:async()=>{counters.release++;},snapshot:v=>v,record:async()=>{}},
  serializeServiceRequest:item=>({id:item.externalId,status:item.status,customerEmail:item.customerEmail}),
  sendServiceRequestNotification:async()=>{counters.notify++;if(options.failEmail)throw new Error('Mail unavailable');return {sent:true};},
 });
 app.use((error,req,res,next)=>res.status(500).json({message:'Unable to save request.'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=async(body=payload(),user='client-1')=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/service-requests`,{method:'POST',headers:{'Content-Type':'application/json',...(user?{Authorization:user}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 return {post,saved,counters};
}

test('submission requires authentication and validates details before persistence',async t=>{
 const f=await fixture(t);assert.equal((await f.post(payload(),null)).status,401);
 assert.equal((await f.post({...payload(),clientSubmissionId:'invalid'})).status,400);
 assert.equal((await f.post({...payload(),event:{...payload().event,eventDate:'2020-01-01'}})).status,400);
 assert.equal(f.saved.length,0);
});
test('lost-response retry returns the same owned request without claiming voucher or emailing twice',async t=>{
 const f=await fixture(t);const body={...payload(),voucherCode:'TEST'};
 const first=await f.post(body);const retry=await f.post(body);
 assert.equal(first.status,201);assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);
 assert.equal(first.body.item.id,retry.body.item.id);assert.equal(f.saved.length,1);
 assert.equal(f.counters.notify,1);assert.equal(f.counters.reserve,1);
 assert.equal(retry.body.item.customerEmail,'test@example.invalid');
});
test('changed payload with the same key conflicts; another account has an independent key scope',async t=>{
 const f=await fixture(t);await f.post();
 assert.equal((await f.post({...payload(),event:{...payload().event,phone:'6475550100'}})).status,409);
 assert.equal((await f.post(payload(),'client-2')).status,201);assert.equal(f.saved.length,2);
});
test('simultaneous matching submissions create and notify only once',async t=>{
 const f=await fixture(t);const results=await Promise.all([f.post(),f.post()]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(f.saved.length,1);assert.equal(f.counters.notify,1);
});
test('failed persistence releases its voucher and leaves a retry possible',async t=>{
 const f=await fixture(t,{failSave:true});assert.equal((await f.post({...payload(),voucherCode:'TEST'})).status,500);
 assert.equal(f.saved.length,0);assert.equal(f.counters.release,1);assert.equal(f.counters.notify,0);
});
test('mail failure preserves a successfully saved request',async t=>{
 const f=await fixture(t,{failEmail:true});const result=await f.post();
 assert.equal(result.status,201);assert.equal(result.body.notificationSent,false);assert.equal(f.saved.length,1);
});

test('canonical submissions retain the brief but enforce account identity and reject mismatched services',async t=>{
 const core=require('../src/event-order');
 let order=core.createEventOrder();
 for(const [key,value] of Object.entries({'customer.fullName':'Forged Name','customer.email':'forged@example.invalid','customer.phone':'4165550100','customer.contactMethod':'email','event.type':'wedding','event.date':'2099-10-12','event.startTime':'18:00','event.endTime':'01:00','event.guestCount':100,'event.venue.name':'Test Hall','event.venue.address':'1 Example Street','event.venue.city':'Toronto','event.venue.postalCode':'M1A 1A1','event.venue.area':'gta','event.venue.setting':'indoor',services:['dj']}))order=core.updateOrderField(order,key,value);
 order.additional.voucherCode='TEST';
 const f=await fixture(t);
 assert.equal((await f.post({...payload(),order,voucherCode:'OTHER'})).status,400);
 assert.equal((await f.post({...payload(),order,items:[{serviceId:'svc-lighting',name:'Lighting',category:'service',quantity:1}]})).status,400);
 assert.equal((await f.post({...payload(),order,status:'confirmed',unitPrice:1})).status,201);
 assert.equal(f.saved[0].order.customer.fullName,'Test Client');assert.equal(f.saved[0].order.customer.email,'test@example.invalid');assert.equal(f.saved[0].status,'pending');assert.equal(f.counters.reserve,1);assert.equal(f.saved[0].voucher.code,'TEST');assert.equal(f.saved[0].order.event.venue.name,'Test Hall');
});

test('a successful request can be replayed after its equipment leaves the active catalog',async t=>{
 const options={catalog:[{slug:'speaker',name:'Speaker',category:'sound',minQuantity:1,isActive:true}]};
 const f=await fixture(t,options);const body={...payload(),items:[{serviceId:'speaker',name:'My speaker',category:'sound',quantity:1}]};
 assert.equal((await f.post(body)).status,201);options.catalog=[];
 const retry=await f.post(body);assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);assert.equal(f.saved.length,1);
});

test('protected submissions do not write when unique-index initialization fails',async t=>{
 const f=await fixture(t,{failIndex:true});assert.equal((await f.post()).status,500);assert.equal(f.saved.length,0);assert.equal(f.counters.notify,0);
});
