const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerQuoteLifecycle}=require('../src/quote-lifecycle');
const {registerPayments}=require('../src/payments');

async function fixture(t,options={}){
 const request={externalId:'request-1',requestNumber:'ECHO-TEST',userId:'client',status:'quoted',event:{eventDate:'2099-06-20'},items:[{serviceId:'svc-dj',quantity:1,unitPrice:100}],taxPercent:0,depositAmount:30,expiresAt:new Date(Date.now()+86400000),payments:[],save:async()=>{if(options.failSave)throw new Error('Save failed');}};
 const bookings=[];let emails=0;
 const app=express();app.use(express.json());
 const requireAuth=(req,res,next)=>{const user=req.headers.authorization;if(!user)return res.status(401).json({message:'Sign in'});req.authUser={_id:user,isAdmin:user==='admin'};next();};
 const requireAdmin=(req,res,next)=>requireAuth(req,res,()=>req.authUser.isAdmin?next():res.status(403).json({message:'Admin only'}));
 const Model={findOne:async query=>query.externalId===request.externalId?request:null};
 const serialize=sr=>({id:sr.externalId,status:sr.status,payments:sr.payments});
 registerQuoteLifecycle(app,{requireAuth,requireAdmin,serialize,Model});
 registerPayments(app,{requireAuth,requireAdmin,serialize,Model,EquipmentModel:{find:async()=>options.stock||[]},BookingModel:{find:async()=>[],create:async data=>{if(options.dateTaken)throw Object.assign(new Error('Date taken'),{code:11000});const booking={...data,_id:'booking'};bookings.push(booking);return booking;},deleteOne:async()=>bookings.splice(0)},sendConfirmation:async()=>{emails++;return {sent:true};}});
 app.use((error,req,res,next)=>res.status(500).json({message:'Save failed'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=async(action,body={},user='client')=>{const result=await fetch(`http://127.0.0.1:${server.address().port}/api/service-requests/request-1/${action}`,{method:'POST',headers:{'Content-Type':'application/json',...(user?{Authorization:user}:{})},body:JSON.stringify(body)});return {status:result.status,body:await result.json()};};
 return {request,bookings,post,get emails(){return emails;}};
}
const deposit=amount=>({kind:'deposit',amount,method:'etransfer'});

test('only the owner can accept; acceptance does not reserve a date; only an admin records a deposit',async t=>{
 const f=await fixture(t);assert.equal((await f.post('accept',{},null)).status,401);assert.equal((await f.post('accept',{},'stranger')).status,404);
 assert.equal((await f.post('payments',deposit(30),'admin')).status,409);
 assert.equal((await f.post('accept')).status,200);assert.equal(f.request.status,'accepted');assert.equal(f.bookings.length,0);
 assert.equal((await f.post('payments',deposit(30))).status,403);
 assert.equal((await f.post('payments',deposit(10),'admin')).status,201);assert.equal(f.request.status,'accepted');assert.equal(f.bookings.length,0);
 assert.equal((await f.post('payments',deposit(20),'admin')).status,201);assert.equal(f.request.status,'confirmed');assert.equal(f.bookings.length,1);assert.equal(f.emails,1);
 assert.equal((await f.post('payments',deposit(20),'admin')).status,409);
});
test('expired quotes cannot be accepted or receive a deposit',async t=>{
 const f=await fixture(t);f.request.expiresAt=new Date(Date.now()-1000);
 assert.equal((await f.post('accept')).status,409);assert.equal(f.request.status,'expired');
 f.request.status='accepted';assert.equal((await f.post('payments',deposit(30),'admin')).status,409);assert.equal(f.bookings.length,0);
});
test('change requests leave the quote unaccepted and block deposits',async t=>{
 const f=await fixture(t);assert.equal((await f.post('request-changes',{message:'Please adjust the hours.'})).status,200);
 assert.equal(f.request.status,'changes_requested');assert.equal((await f.post('accept')).status,409);
 assert.equal((await f.post('payments',deposit(30),'admin')).status,409);
});
test('a taken date prevents confirmation and payment recording',async t=>{
 const f=await fixture(t,{dateTaken:true});await f.post('accept');
 assert.equal((await f.post('payments',deposit(30),'admin')).status,409);assert.equal(f.request.payments.length,0);assert.equal(f.request.status,'accepted');assert.equal(f.emails,0);
});
test('failed request persistence removes the newly created date reservation',async t=>{
 const f=await fixture(t,{failSave:true});f.request.status='accepted';
 assert.equal((await f.post('payments',deposit(30),'admin')).status,500);assert.equal(f.bookings.length,0);assert.equal(f.emails,0);
});
test('tracked equipment shortage prevents confirming and recording a deposit',async t=>{
 const f=await fixture(t,{stock:[{slug:'speaker',name:'Speaker',quantityOwned:1}]});f.request.status='accepted';f.request.items.push({serviceId:'speaker',quantity:2,unitPrice:10});
 const result=await f.post('payments',deposit(30),'admin');assert.equal(result.status,409);assert.match(result.body.message,/not available/);assert.equal(f.request.payments.length,0);assert.equal(f.bookings.length,0);
});

test('bundle and standalone components aggregate before deposit confirmation',async t=>{
 const f=await fixture(t,{stock:[{slug:'speaker',name:'Speaker',stockTracked:true,quantityOwned:2},{slug:'bundle',name:'Bundle',isSet:true,stockTracked:true,quantityOwned:2,setItems:[{equipmentId:'speaker',quantity:2}]}]});
 f.request.status='accepted';f.request.items.push({serviceId:'bundle',quantity:1,unitPrice:20},{serviceId:'speaker',quantity:1,unitPrice:10});
 const response=await f.post('payments',deposit(30),'admin');assert.equal(response.status,409);assert.match(response.body.message,/Speaker.*not available/);assert.equal(f.request.payments.length,0);assert.equal(f.bookings.length,0);
});
