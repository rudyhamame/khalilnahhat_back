const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {windowKey,availabilityFor,requireAvailability}=require('../src/booking-availability');
const {registerQuoteLifecycle}=require('../src/quote-lifecycle');
async function fixture(t,{mailFails=false}={}){
 const sr={externalId:'r1',userId:'client',status:'pending',quoteRevision:0,payments:[],event:{eventDate:'2099-06-20',startTime:'18:00',endTime:'23:00'},order:{event:{date:'2099-06-20',startTime:'18:00',endTime:'23:00',timezone:'America/Toronto'}},save:async()=>{}};const mails=[];
 const app=express();app.use(express.json());const auth=(req,res,next)=>{if(!req.headers.authorization)return res.sendStatus(401);req.authUser={_id:req.headers.authorization};next();},admin=(req,res,next)=>auth(req,res,()=>req.authUser._id==='admin'?next():res.sendStatus(403));
 registerQuoteLifecycle(app,{requireAuth:auth,requireAdmin:admin,Model:{findOne:async q=>q.externalId==='r1'?sr:null},sendRequested:async()=>({sent:true}),serialize:r=>({id:r.externalId,status:r.status,quoteRevision:r.quoteRevision,availability:availabilityFor(r),order:r.order}),sendDecision:async(r,decision)=>{mails.push({decision,reason:r.availabilityReason});if(mailFails)throw Error('Mail offline');return {sent:true};}});
 app.post('/publish',admin,(req,res)=>{try{requireAvailability(sr);res.json({published:true});}catch(e){res.status(e.status).json({code:e.code});}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const post=async(path,body={},user='admin')=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path==='/publish'?path:'/api/service-requests/r1/'+path}`,{method:'POST',headers:{'Content-Type':'application/json',...(user?{Authorization:user}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>({}))};};return {sr,mails,post};
}
test('availability is required before publishing and is tied to the exact date and time',async t=>{
 const f=await fixture(t);assert.equal((await f.post('/publish')).status,409);
 assert.equal((await f.post('admin-review',{decision:'accept',quoteRevision:0})).status,200);assert.equal(f.mails[0].decision,'available');assert.equal(f.sr.quoteRevision,0,'availability does not erase the unsaved quote draft');assert.equal((await f.post('/publish')).status,200);
 f.sr.order.event.startTime='19:00';assert.equal(availabilityFor(f.sr).status,'pending');assert.equal((await f.post('/publish')).status,409);
});
test('not available requires a reason, withdraws a prior quote, and keeps the request open',async t=>{
 const f=await fixture(t);f.sr.status='quoted';f.sr.expiresAt=new Date('2099-06-19');
 for(const reason of [undefined,'   ','x'.repeat(2001)])assert.equal((await f.post('admin-review',{decision:'unavailable',reason,quoteRevision:0})).status,400);
 assert.equal(f.mails.length,0);const r=await f.post('admin-review',{decision:'unavailable',reason:'We have another event at that time.',quoteRevision:0});assert.equal(r.status,200);assert.equal(r.body.item.availability.reason,'We have another event at that time.');assert.equal(f.sr.status,'pending');assert.equal(f.sr.expiresAt,null);assert.equal(f.sr.availabilityAcceptedAt,null);assert.equal((await f.post('/publish')).status,409);assert.equal(f.mails[0].decision,'unavailable');
});
test('only the owner can suggest a different date/time, which must be reviewed again',async t=>{
 const f=await fixture(t);await f.post('admin-review',{decision:'unavailable',reason:'Already booked',quoteRevision:0});const body={date:'2099-06-21',startTime:'19:00',endTime:'01:00',quoteRevision:1};
 assert.equal((await f.post('reschedule-request',body,'stranger')).status,404);assert.equal((await f.post('reschedule-request',{...body,quoteRevision:0},'client')).status,409);
 assert.equal((await f.post('reschedule-request',{...body,date:'2099-02-30'},'client')).status,400);assert.equal((await f.post('reschedule-request',{...body,startTime:'25:00'},'client')).status,400);assert.equal((await f.post('reschedule-request',{date:'2099-06-20',startTime:'18:00',endTime:'23:00',quoteRevision:1},'client')).status,400);
 const result=await f.post('reschedule-request',body,'client');assert.equal(result.status,200);assert.equal(f.sr.event.eventDate,body.date);assert.equal(f.sr.order.event.date,body.date);assert.equal(f.sr.order.event.endTime,'01:00');assert.equal(availabilityFor(f.sr).status,'pending');assert.equal(f.sr.availabilityHistory[0].reason,'Already booked');assert.equal((await f.post('/publish')).status,409);
 await f.post('admin-review',{decision:'accept',quoteRevision:2});assert.equal((await f.post('/publish')).status,200);
});
test('paid/closed bookings and stale admin actions cannot be changed; notification failures are reported honestly',async t=>{
 const f=await fixture(t,{mailFails:true});assert.equal((await f.post('admin-review',{decision:'accept'},'client')).status,403);assert.equal((await f.post('admin-review',{decision:'accept'},null)).status,401);assert.equal((await f.post('admin-review',{decision:'accept',quoteRevision:99})).status,409);
 f.sr.payments=[{voided:false}];assert.equal((await f.post('admin-review',{decision:'unavailable',reason:'Busy'})).status,409);f.sr.payments=[];f.sr.status='confirmed';assert.equal((await f.post('admin-review',{decision:'accept'})).status,409);f.sr.status='pending';
 const r=await f.post('admin-review',{decision:'accept'});assert.equal(r.status,200);assert.equal(r.body.notificationSent,false);assert.equal(r.body.item.availability.status,'available');assert.equal((await f.post('admin-review',{decision:'accept'})).status,409);
});

test('extending an existing quote also requires availability',async t=>{
 const f=await fixture(t);f.sr.status='quoted';f.sr.quotedAt=new Date();f.sr.expiresAt=new Date(Date.now()+86400000);
 assert.equal((await f.post('extend',{days:2})).status,409);
});
test('the actual quote publishing route rejects a direct API bypass before changing prices',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
 const file=path.join(__dirname,'../src/server.js'),source=fs.readFileSync(file,'utf8'),start=source.indexOf("app.patch('/api/service-requests/:id/quote'"),end=source.indexOf('\n});',start)+5;
 assert.ok(start>=0&&end>start);let handler,saves=0;
 const sr={status:'pending',items:[{serviceId:'dj',unitPrice:100}],payments:[],save:async()=>{saves++;}};
 vm.runInNewContext(source.slice(start,end),{app:{patch:(_path,_auth,fn)=>{handler=fn;}},requireAdmin:()=>{},serviceRequestQuoteSchema:{safeParse:()=>({success:true,data:{items:[]}})},ServiceRequest:{findOne:async()=>sr},journey:require('../src/booking-journey'),require:createRequire(file)});
 const response={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await handler({params:{id:'r1'},body:{}},response);
 assert.equal(response.statusCode,409);assert.equal(response.body.code,'AVAILABILITY_REQUIRED');assert.equal(sr.items[0].unitPrice,100);assert.equal(saves,0);
});
test('the five client stages (with deposit paid) collapse acceptance into quote-ready and branch on availability',()=>{
 const journey=require('../src/booking-journey'),{STATUS}=journey;
 const sr={status:STATUS.PENDING,event:{eventDate:'2099-06-20',startTime:'18:00',endTime:'23:00'}};
 let client=journey.describeRequest(sr);assert.equal(client.label,'Booking requested');assert.deepEqual(client.path.map(step=>step.status),['requested','available','quote_ready','deposit_paid','booked']);
 sr.availabilityAcceptedAt=new Date();sr.availabilityWindow=windowKey(sr);assert.equal(journey.describeRequest(sr).clientStatus,'available');assert.equal(journey.describeRequest(sr).step,1);
 sr.availabilityAcceptedAt=null;sr.availabilityUnavailableAt=new Date();sr.availabilityReason='Already booked';client=journey.describeRequest(sr);assert.equal(client.clientStatus,'unavailable');assert.equal(client.path[1].status,'unavailable');assert.equal(client.canDiscussAvailability,true);
 for(const status of [STATUS.QUOTED,STATUS.ACCEPTED,STATUS.CHANGES_REQUESTED]){sr.status=status;client=journey.describeRequest(sr);assert.equal(client.clientStatus,'quote_ready');assert.equal(client.step,2);assert.equal(client.isBooked,false);}
 sr.status=STATUS.CONFIRMED;client=journey.describeRequest(sr);assert.equal(client.label,'Booked');assert.equal(client.step,4);assert.equal(client.isBooked,true);
 sr.status=STATUS.ACCEPTED;sr.payments=[{amountCents:5000,voided:false}];client=journey.describeRequest(sr);assert.equal(client.clientStatus,'deposit_paid');assert.equal(journey.bookingStatusOf(sr),'deposit_paid');
 sr.payments=[{amountCents:5000,voided:true}];assert.equal(journey.bookingStatusOf(sr),'quote_ready');sr.status=STATUS.CANCELLED;assert.equal(journey.bookingStatusOf(sr),'cancelled');
});
