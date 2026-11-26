const assert=require('node:assert'),{test}=require('node:test');
const core=require('./event-order');
const {registerQuoteLifecycle}=require('./quote-lifecycle');
const routes={};const app={post:(p,...h)=>{routes[p]=h[h.length-1];},get(){},patch(){},put(){}};
let sr;
const Model={findOne:async()=>sr};
const notified=[];
registerQuoteLifecycle(app,{requireAuth:1,requireAdmin:1,serialize:x=>x,Model,notify:async(...args)=>{notified.push(args);return {sent:true};}});
const order=core.createEventOrder();
Object.assign(order.customer,{firstName:'A',lastName:'B',email:'a@b.co',phone:'+14165550101',contactMethod:'email'});
Object.assign(order.event,{type:'wedding',date:'2099-01-01',startTime:'18:00',endTime:'23:00',guestCount:50,venue:{name:'Hall',address:'1 St',city:'Toronto',country:'Canada'}});
order.music.djRequested=true;
const mk=()=>({userId:'u1',status:'quoted',order:structuredClone(order),event:{},quoteRevision:2,payments:[],availabilityAcceptedAt:new Date(),save:async function(){}});
const call=async body=>{const res={code:200,status(c){this.code=c;return this;},json(b){this.body=b;return this;}};await routes['/api/service-requests/:id/order-edit']({params:{id:'x'},body,authUser:{_id:'u1'}},res);return res;};
test('client order-edit: safe edits apply, availability edits need acknowledgement, priced atoms and paid bookings are refused',async()=>{
 sr=mk();let r=await call({path:'additional.notes',value:'hello'});assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(sr.order.additional.notes,'hello');assert.equal(sr.status,'quoted');
 sr=mk();r=await call({path:'event.date',value:'2099-02-02'});assert.equal(r.code,409);assert.equal(r.body.code,'RESET_REQUIRED');
 r=await call({path:'event.date',value:'2099-02-02',acknowledgeReset:true});assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(sr.status,'pending');assert.equal(sr.quoteRevision,3);assert.equal(sr.availabilityAcceptedAt,null);
 sr=mk();r=await call({path:'services',value:['dj']});assert.equal(r.code,400);
 sr=mk();r=await call({path:'customer.firstName',value:'Z'});assert.equal(r.code,400);assert.equal(sr.order.customer.firstName,'A');
 sr=mk();sr.payments=[{voided:false}];r=await call({path:'event.guestCount',value:60,acknowledgeReset:true});assert.equal(r.code,409);
});
test('admin order-edit edits any client booking through the admin route',async()=>{
 sr=mk();const res={code:200,status(c){this.code=c;return this;},json(b){this.body=b;return this;}};
 await routes['/api/service-requests/:id/admin-order-edit']({params:{id:'x'},body:{path:'additional.notes',value:'by admin'},authUser:{_id:'admin-1'}},res);
 assert.equal(res.code,200,JSON.stringify(res.body));assert.equal(sr.order.additional.notes,'by admin');
 sr=mk();const denied=await call({path:'additional.notes',value:'x'});assert.equal(denied.code,200); // owner still can
 sr=mk();const other={code:200,status(c){this.code=c;return this;},json(b){this.body=b;return this;}};
 await routes['/api/service-requests/:id/order-edit']({params:{id:'x'},body:{path:'additional.notes',value:'x'},authUser:{_id:'someone-else'}},other);
 assert.equal(other.code,404);
});

test('client-step-back: the client undoes their acceptance, a best-offer request or a cancellation, within safe limits',async()=>{
 const run=async(body,authId='u1')=>{const res={code:200,status(c){this.code=c;return this;},json(b){this.body=b;return this;}};await routes['/api/service-requests/:id/client-step-back']({params:{id:'x'},body,authUser:{_id:authId}},res);return res;};
 sr={...mk(),status:'accepted',acceptedAt:new Date(),expiresAt:new Date(Date.now()+864e5)};
 let r=await run({to:'quote'});assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(sr.status,'quoted');assert.equal(sr.acceptedAt,null);
 sr={...mk(),status:'changes_requested',changeRequest:'less?',changeRequestedAt:new Date(),negotiation:{revision:1,items:[]},negotiationHistory:[{revision:1,items:[]}]};
 r=await run({to:'quote'});assert.equal(r.code,200);assert.equal(sr.status,'quoted');assert.equal(sr.changeRequest,'');
 assert.ok(sr.negotiation.withdrawn&&sr.negotiation.resolvedAt&&sr.negotiationHistory[0].withdrawn); // the price offer is withdrawn with it
 assert.equal(notified.at(-1)[1],'booking-client-step-back-admin'); // the team is told
 sr={...mk(),status:'accepted',payments:[{amountCents:5000}]};r=await run({to:'quote'});assert.equal(r.code,409); // money recorded: cannot be undone
 sr={...mk(),status:'accepted',expiresAt:new Date(Date.now()-1000)};r=await run({to:'quote'});assert.equal(r.code,409); // the quote lapsed
 sr={...mk(),status:'cancelled',declinedBy:'client',cancelledFromStatus:'quoted'};r=await run({to:'restore'});assert.equal(r.code,200);assert.equal(sr.status,'quoted');assert.equal(sr.declinedBy,'');
 sr={...mk(),status:'cancelled',declinedBy:'client',cancelledFromStatus:'confirmed'};r=await run({to:'restore'});assert.equal(r.code,409); // a confirmed date may have been taken
 sr={...mk(),status:'cancelled',declinedBy:'admin',cancelledFromStatus:'quoted'};r=await run({to:'restore'});assert.equal(r.code,409); // only the client's own cancellation
 sr=mk();r=await run({to:'quote'},'someone-else');assert.equal(r.code,404);
});
