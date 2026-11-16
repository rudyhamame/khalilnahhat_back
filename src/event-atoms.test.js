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
