const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('./event-order');
test('AI field guide describes every Event atom and clearly separates awareness from edit access',()=>{
 const guide=core.orderInstructions();const editable=core.orderPatchJsonSchema.items.properties.path.enum;
 for(const field of core.fields.filter(field=>field.key.startsWith('event.'))){
  assert.ok(guide.includes(`"path":"${field.key}"`),field.key);
  assert.equal(editable.includes(field.key),!field.manualOnly,field.key);
 }
 assert.match(guide,/"optionNames"/);assert.match(guide,/"readOnly":true/);assert.match(guide,/next day/);
 assert.equal(editable.some(path=>path.startsWith('customer.')),false);
});
test('AI context preserves current venue provenance without granting a write tool for it',()=>{
 const context={'event.type':'wedding','event.date':'2027-06-12','event.venue.latitude':43.65,'event.venue.longitude':-79.38,'event.venue.source':'osm','event.venue.sourceId':'node:123','unknown.path':'ignore'};
 const order=core.orderFromContext(context),flat=core.aiOrderContext(order);
 assert.equal(flat['event.venue.latitude'],43.65);assert.equal(flat['event.venue.sourceId'],'node:123');assert.equal(order.unknown,undefined);
 assert.deepEqual(core.sanitizeOrderPatch([{path:'event.venue.latitude',value:'44'},{path:'event.venue.sourceId',value:'invented'}]),[]);
 assert.equal(core.applyOrderPatch(order,[{path:'event.venue.latitude',value:44}]).event.venue.latitude,43.65);
 assert.equal(core.applyOrderPatch(order,[{path:'event.guestCount',value:'120'}]).event.guestCount,120);
});
test('past schedule checks use Toronto’s date, handle winter/summer and accept future overnight ends',()=>{
 const order=core.createEventOrder();Object.assign(order.event,{date:'2027-06-12',startTime:'19:00',endTime:'01:00'});
 const now=new Date('2027-06-12T16:00:00Z');
 assert.deepEqual(core.sanitizeOrderPatch([{path:'event.date',value:'2027-06-11'},{path:'event.startTime',value:'20:00'}],{order,now}),[]);
 assert.deepEqual(core.sanitizeOrderPatch([{path:'event.startTime',value:'11:30'}],{order,now}),[]);
 assert.deepEqual(core.sanitizeOrderPatch([{path:'event.startTime',value:'12:00'}],{order,now}),[]);
 assert.equal(core.sanitizeOrderPatch([{path:'event.startTime',value:'18:00'},{path:'event.endTime',value:'01:00'}],{order,now}).length,2);
 assert.deepEqual(core.pastEventScheduleFields({event:{date:'2027-01-01',startTime:'23:00'}},new Date('2027-01-02T03:00:00Z')),[]); // still Jan 1, 22:00 Toronto
 assert.deepEqual(core.pastEventScheduleFields({event:{date:'2027-01-01',startTime:'21:00'}},new Date('2027-01-02T03:00:00Z')),['event.startTime']);
});
