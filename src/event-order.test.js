const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const core=require('./event-order');
function completed(){
  let order=core.createEventOrder();
  for(const [key,value] of Object.entries({'customer.fullName':'Example Client','customer.email':'example@example.invalid','customer.phone':'4165550123','customer.contactMethod':'email','event.type':'wedding','event.date':'2099-06-20','event.startTime':'18:00','event.endTime':'01:00','event.guestCount':150,'event.venue.name':'Example venue','event.venue.address':'1 Example Street','event.venue.city':'Toronto','event.venue.postalCode':'M1A 1A1','event.venue.area':'gta','event.venue.setting':'indoor',services:['dj']}))order=core.updateOrderField(order,key,value);
  return order;
}
test('new order has unknown answers, explicit Toronto time and separate post-booking planning',()=>{
  const order=core.createEventOrder();assert.equal(order.event.guestCount,null);assert.equal(order.event.venue.area,null);assert.equal(order.event.venue.setting,null);assert.deepEqual(order.services,[]);assert.equal(order.event.timezone,'America/Toronto');assert.equal(order.planning.phase,'after_confirmation');assert.equal(order.planning.firstDance,null);
});
test('canonical JSON contract and helpers are identical in frontend and backend',()=>{
  for(const name of ['eventOrderContract.json','eventOrderCore.mjs'])assert.equal(fs.readFileSync(path.join(__dirname,name),'utf8').trim(),fs.readFileSync(path.join(__dirname,'../../khalil-front/src/lib',name),'utf8').trim());
});
test('manual and AI produce the same event fields without treating ranges as a number',()=>{
  const ai=core.applyOrderPatch(core.createEventOrder(),[{path:'event.type',value:'wedding'},{path:'event.guestCount',value:'150'},{path:'services',value:'["dj"]'},{path:'event.guestCount',value:'100–150'}]);
  assert.equal(ai.event.guestCount,150);assert.equal(ai.event.type,'wedding');assert.deepEqual(ai.services,['dj']);
  assert.equal(core.applyOrderPatch(ai,[{path:'event.date',value:'2099-02-30'}]).event.date,null);
});
test('AI cannot set contact fields, grant permissions, inject unknown keys or confirm orders',()=>{
  const order=core.applyOrderPatch(core.createEventOrder(),[{path:'customer.email',value:'attack@example.invalid'},{path:'studio.rights.confirmed',value:'true'},{path:'status',value:'confirmed'},{path:'__proto__.polluted',value:'yes'}]);
  assert.equal(order.customer.email,null);assert.equal(order.studio,undefined);assert.equal(order.status,undefined);assert.equal({}.polluted,undefined);
});
test('submission validates required details; overnight times are valid',()=>{
  const order=completed();assert.deepEqual(core.validateEventOrder(order,{submission:true}),[]);
  assert.ok(core.validateEventOrder({...order,event:{...order.event,endTime:'18:00'}},{submission:true}).includes('event.endTime'));
  assert.ok(core.validateEventOrder({...order,event:{...order.event,date:'2000-01-01'}},{submission:true}).includes('event.date'));
});
test('server retains full brief, enforces identity and selections, and cannot receive client pricing/status',()=>{
  const order=completed();order.status='confirmed';order.price=1;order.event.setup.requirements='x'.repeat(2800);
  const user={firstName:'Verified',lastName:'Client',email:'verified@example.invalid'};
  const result=core.prepareSubmittedOrder(order,user,[{serviceId:'svc-dj',name:'DJ',category:'service',quantity:1}],[]);
  assert.equal(result.order.customer.fullName,'Verified Client');assert.equal(result.order.event.setup.requirements.length,2800);assert.equal(result.event.setupRequirements.length,2000);assert.equal(result.order.status,undefined);assert.equal(result.order.price,undefined);
  assert.throws(()=>core.prepareSubmittedOrder(order,user,[{serviceId:'svc-lighting',name:'Lighting',category:'service',quantity:1}],[]),/selections changed/);
});
test('reference links are metadata, not fetched, and non-HTTPS references are rejected',()=>{
  const field=core.fields.find(field=>field.key==='references.documents');assert.equal(core.validValue(field,['https://example.invalid/brief.pdf']),true);assert.equal(core.validValue(field,['javascript:alert(1)']),false);
});

test('quote questionnaire asks only what the brief lists plus language and dialect',()=>{
  const keys=core.fields.map(field=>field.key).sort();
  const brief=['customer.fullName','customer.email','customer.phone','customer.contactMethod','customer.company','event.type','event.date','event.startTime','event.endTime','event.guestCount','event.venue.name','event.venue.address','event.venue.city','event.venue.postalCode','event.venue.country','event.venue.addressDetails','event.venue.area','event.venue.setting','event.setup.requirements','services','music.styles','music.otherLanguage','music.dialects','music.otherPreferences','music.djMc','music.entrance','music.customMix','music.announcements','references.images','references.documents','additional.specialRequests','additional.notes'].sort();
  assert.deepEqual(keys,brief);
});

test('dialect catalog has unique ids matching the contract, with English and Arabic names',()=>{
  const catalog=JSON.parse(require('node:fs').readFileSync(__dirname+'/dialectCatalog.json','utf8')).items;
  const ids=catalog.map(item=>item.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.deepEqual([...ids].sort(),[...core.fields.find(field=>field.key==='music.dialects').options].sort());
  assert.ok(catalog.every(item=>item.display_name&&item.display_name_ar));
  const order=core.updateOrderField(core.createEventOrder(),'music.dialects',['levantine-syrian-aleppine','unknown']);
  assert.deepEqual(order.music.dialects,['levantine-syrian-aleppine','unknown']);
  assert.deepEqual(core.updateOrderField(core.createEventOrder(),'music.dialects',['made-up']).music.dialects,[]);
});
