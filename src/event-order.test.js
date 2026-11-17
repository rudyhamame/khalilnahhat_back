const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const core=require('./event-order');
function completed(){
  let order=core.createEventOrder();
  for(const [key,value] of Object.entries({'customer.fullName':'Example Client','customer.email':'example@example.invalid','customer.phone':'4165550123','customer.contactMethod':'email','customer.phoneContact':'sms','event.type':'wedding','event.date':'2099-06-20','event.startTime':'18:00','event.endTime':'01:00','event.guestCount':150,'event.venue.name':'Example venue','event.venue.address':'1 Example Street','event.venue.city':'Toronto','event.venue.postalCode':'M1A 1A1','event.venue.setting':'indoor',services:['dj']}))order=core.updateOrderField(order,key,value);
  return core.applyAccountProfile(order,{firstName:'Example',lastName:'Client',email:'example@example.invalid',phoneNumber:'4165550123',phoneContact:'sms'});
}
test('new order has unknown answers, explicit Toronto time and separate post-booking planning',()=>{
  const order=core.createEventOrder();assert.equal(order.event.guestCount,null);assert.equal(order.event.venue.setting,null);assert.deepEqual(order.services,[]);assert.equal(order.event.timezone,'America/Toronto');assert.equal(order.planning.phase,'after_confirmation');assert.equal(order.planning.firstDance,null);
});
test('canonical JSON contract and helpers are identical in frontend and backend',()=>{
  for(const name of ['eventOrderContract.json','eventOrderCore.mjs'])assert.equal(fs.readFileSync(path.join(__dirname,name),'utf8').trim(),fs.readFileSync(path.join(__dirname,'../../khalil-front/src/lib',name),'utf8').trim());
});
test('manual and AI produce the same event fields without treating ranges as a number',()=>{
  const ai=core.applyOrderPatch(core.createEventOrder(),[{path:'event.type',value:'wedding'},{path:'event.guestCount',value:'150'},{path:'services',value:'["dj"]'},{path:'event.guestCount',value:'100–150'}]);
  assert.equal(ai.event.guestCount,150);assert.equal(ai.event.type,'wedding');assert.deepEqual(ai.services,['dj']);
  assert.equal(core.applyOrderPatch(ai,[{path:'event.date',value:'2099-02-30'}]).event.date,null);
});
test('AI cannot edit account contacts, inject unknown keys or confirm orders',()=>{
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
  const user={firstName:'Verified',lastName:'Client',email:'verified@example.invalid',phoneNumber:'4165550123',phoneContact:'call',company:'Verified Company'};
  const result=core.prepareSubmittedOrder(order,user,[{serviceId:'svc-dj',name:'DJ',category:'service',quantity:1}],[]);
  assert.equal(result.order.customer.fullName,'Verified Client');assert.equal(result.order.event.setup.requirements.length,2800);assert.equal(result.event.setupRequirements.length,2000);assert.equal(result.order.status,undefined);assert.equal(result.order.price,undefined);
  assert.throws(()=>core.prepareSubmittedOrder(order,user,[{serviceId:'svc-lighting',name:'Lighting',category:'service',quantity:1}],[]),/selections changed/);
});
test('reference links are metadata, not fetched, and non-HTTPS references are rejected',()=>{
  const field=core.fields.find(field=>field.key==='references.images');assert.equal(core.validValue(field,['https://example.invalid/inspiration.jpg']),true);assert.equal(core.validValue(field,['javascript:alert(1)']),false);
});

test('quote questionnaire asks only what the brief lists plus language and dialect',()=>{
  const keys=core.fields.filter(field=>!field.hidden).map(field=>field.key).sort();
  const brief=['customer.fullName','customer.email','customer.phone','customer.contactMethod','customer.phoneContact','customer.company','event.type','event.date','event.startTime','event.endTime','event.guestCount','event.venue.name','event.venue.address','event.venue.city','event.venue.postalCode','event.venue.country','event.venue.addressDetails','event.venue.setting','event.setup.requirements','services','music.djRequested','music.mcRequested','rental.requested','music.djMc','references.images','additional.notes'].sort();
  assert.deepEqual(keys,brief);
});

test('dialect catalog has unique ids with English and Arabic names',()=>{
  const catalog=JSON.parse(require('node:fs').readFileSync(__dirname+'/dialectCatalog.json','utf8')).items;
  const ids=catalog.map(item=>item.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.ok(catalog.every(item=>item.display_name&&item.display_name_ar));
});
test('the retired free-text music fields are not data atoms and cannot be set, by the form or by the AI',()=>{
  for(const key of ['music.styles','music.otherLanguage','music.dialects','music.otherPreferences','music.entrance','music.customMix','music.announcements']){
    assert.equal(core.fields.some(field=>field.key===key),false,key);
    assert.equal(core.aiFields.some(field=>field.key===key),false,key);
    assert.equal(core.sanitizeOrderPatch([{path:key,value:'"anything"'}]).length,0,key);
  }
});

test('conversation edits preserve account contacts while editing venue and equipment, and never touch the planning worksheet',()=>{
 let order=core.applyOrderPatch(core.createEventOrder(),[{path:'customer.phone',value:'4165550123'},{path:'event.venue.address',value:'Client supplied address'},{path:'planning.mustPlay',value:'Requested song'},{path:'equipment',value:'[{"id":"speaker","quantity":2}]'}]);
 assert.equal(order.customer.phone,null);assert.equal(order.event.venue.address,'Client supplied address');assert.equal(order.equipment[0].quantity,2);assert.equal(core.normalizeEventOrder(order).planning.mustPlay,null); // the conversation never creates planning worksheet atoms
 assert.equal(core.aiOrderContext(order)['equipment'][0].id,'speaker');
 order=core.applyOrderPatch(order,[{path:'customer.phone',value:'null'},{path:'equipment',value:'[]'}]);assert.equal(order.customer.phone,null);assert.deepEqual(order.equipment,[]);
 assert.equal(core.applyOrderPatch(order,[{path:'status',value:'confirmed'}]).status,undefined);
});

 test('account identity resists manual, AI and clear patches; submission replaces forged contacts',()=>{
 const user={firstName:'Original',lastName:'Client',email:'original@example.invalid',phoneNumber:'4165550199',phoneContact:'call',company:'Original Company'};
 const order=core.applyAccountProfile(completed(),user);
 for(const field of core.lockedFields){
  assert.strictEqual(core.updateOrderField(order,field.key,'Changed'),order);
  assert.strictEqual(core.updateOrderField(order,field.key,null),order);
  assert.equal(core.getPath(core.applyOrderPatch(order,[{path:field.key,value:'Changed'}]),field.key),core.getPath(order,field.key));
  assert.ok(!core.orderPatchJsonSchema.items.properties.path.enum.includes(field.key));
 }
 const forged=structuredClone(order);for(const key of Object.keys(forged.customer))if(key!=='contactMethod')forged.customer[key]='Forged';
 const result=core.prepareSubmittedOrder(forged,user,[{serviceId:'svc-dj',name:'DJ',category:'service',quantity:1}],[]);
 assert.deepEqual(result.order.customer,order.customer);
 assert.equal(core.applyAccountProfile(order,{...user,company:''}).customer.company,null);
 });
test('every field has one short name in both languages, and no two form fields share one',()=>{
  for(const field of core.aiFields){
    assert.ok(field.short&&field.shortAr,`${field.key} needs short and shortAr in the contract`);
    assert.equal(core.fieldName(field.key),field.short);
    assert.equal(core.fieldName(field.key,true),field.shortAr);
  }
  const names=core.fields.map(field=>field.short);
  assert.deepEqual(names.filter((name,index)=>names.indexOf(name)!==index),[],'two contract fields share a short name');
  assert.equal(core.fieldName('not.a.field'),'');
});
test('option names come from the contract in both languages',()=>{
  assert.equal(core.optionName('customer.contactMethod','phone'),'Phone only');
  assert.equal(core.optionName('customer.phoneContact','whatsapp-text',true),'رسالة واتساب');
  assert.equal(core.optionName('customer.phoneContact','call'),'Phone call');
  assert.equal(core.fields.find(field=>field.key==='customer.contactMethod').options.includes('whatsapp'),false); // WhatsApp is a phone option, not a contact method
  assert.equal(core.optionName('customer.contactMethod','other'),'other');
});

test('retired GTA venue atom is absent from forms, AI tools and new/legacy orders',()=>{
 const retired='event.venue.area',order=completed();
 assert.ok(!core.fields.some(field=>field.key===retired));assert.ok(!core.aiFields.some(field=>field.key===retired));
 assert.ok(!core.orderPatchJsonSchema.items.properties.path.enum.includes(retired));
 order.event.venue.area='gta';const normalized=core.normalizeEventOrder(order);
 assert.equal(Object.hasOwn(normalized.event.venue,'area'),false);
 assert.equal(Object.hasOwn(core.orderToLegacy(normalized),'inGta'),false);
 assert.equal(core.applyOrderPatch(normalized,[{path:retired,value:'gta'}]).event.venue.area,undefined);
 assert.deepEqual(core.validateEventOrder(normalized,{submission:true}),[]);
 assert.doesNotMatch(core.orderInstructions(),/postal code, GTA area|coordinates, GTA area/);
});

test('Special requests is not a data atom any more: old text becomes the Additional notes, the AI cannot set it, and Event document links are gone',()=>{
  assert.equal(core.fields.some(field=>field.key==='additional.specialRequests'||field.key==='references.documents'),false);
  assert.equal(core.sanitizeOrderPatch([{path:'additional.specialRequests',value:'"x"'}]).length,0);
  assert.equal(core.normalizeEventOrder({additional:{specialRequests:'No flash photography'}}).additional.notes,'No flash photography');
  assert.equal(core.normalizeEventOrder({additional:{notes:'Keep me',specialRequests:'Old'}}).additional.notes,'Keep me');
  for(const key of ['references.photos','references.files'])assert.equal(core.isAiEditableField(key),false,key); // uploads come from the client, never from the AI
  assert.equal(core.isAiEditableField('references.images'),true);
});

test('a phone number needs one phone contact option; without a phone it is not asked',()=>{
  const base=()=>{const order=core.createEventOrder();order.customer.fullName='A B';order.customer.email='a@example.invalid';order.customer.contactMethod='email';return order;};
  assert.equal(core.missingOrderFields(base()).some(field=>field.key==='customer.phoneContact'),false);
  const withPhone=base();withPhone.customer.phone='4165550123';
  assert.equal(core.missingOrderFields(withPhone).some(field=>field.key==='customer.phoneContact'),true);
  withPhone.customer.phoneContact='whatsapp-call';
  assert.equal(core.missingOrderFields(withPhone).some(field=>field.key==='customer.phoneContact'),false);
  assert.equal(core.accountProfile({preferredContact:'whatsapp'})['customer.contactMethod'],'phone'); // old accounts
  // A signed-in client's Personal info is complete: an older account with a phone but no phone contact choice reads as Phone call.
  const legacy=core.applyAccountProfile(core.createEventOrder(),{firstName:'Ada',lastName:'Client',email:'ada@example.invalid',phoneNumber:'4165550123'});
  assert.equal(legacy.customer.phoneContact,'call');assert.equal(core.missingOrderFields(legacy).some(field=>field.key.startsWith('customer.')),false);
  assert.equal(core.accountProfile({email:'a@b.co',firstName:'A',lastName:'B'})['customer.phoneContact'],null); // no phone, nothing to ask
});

test('the AI instructions follow the booking data atoms bible: no retired atoms, no planning or upload writes',()=>{
  const text=require('./event-order').orderInstructions()+require('./ai-booking').instructions();
  for(const phrase of ['music.styles','music links','Special requests (optional','planning fields','music.entrance','music.dialects'])assert.equal(text.includes(phrase),false,phrase);
  assert.match(text,/song, artist and phase/);
  // Every atom named in the instructions' field guide is a real contract atom, and the read-only ones are exactly the atoms the AI cannot write.
  const guide=JSON.parse(text.slice(text.indexOf('Field guide: ')+13).split('\n')[0].replace(/\.$/,'').match(/^\[.*\]/s)?.[0]||'[]');
  assert.ok(guide.length>30,'the field guide is part of the instructions');
  for(const item of guide)assert.equal(item.readOnly,!core.isAiEditableField(item.path),item.path);
  assert.equal(core.isAiEditableField('planning.mustPlay'),false);
});

test('a guest can have Personal info saved by the AI; a signed-in client cannot change account fields', () => {
  const { sanitizeOrderPatch, guestOrderPatchJsonSchema, orderPatchJsonSchema } = require('./event-order');
  const patch = [{ path: 'customer.fullName', value: 'Sam Lee' }, { path: 'customer.email', value: 'sam@example.com' }, { path: 'customer.phone', value: '4165550123' }];
  assert.equal(sanitizeOrderPatch(patch, { guest: true }).length, 3);
  assert.equal(sanitizeOrderPatch(patch).length, 0);
  assert.ok(guestOrderPatchJsonSchema.items.properties.path.enum.includes('customer.email'));
  assert.ok(!orderPatchJsonSchema.items.properties.path.enum.includes('customer.email'));
});
