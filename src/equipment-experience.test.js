const test=require('node:test');
const assert=require('node:assert/strict');
const {publicView,updateSchema,createSchema}=require('./equipment');

test('equipment carries a function summary and per-event fit text that the admin can edit and the website receives',()=>{
 const ok=updateSchema.safeParse({functionSummary:'Adds deep low end.',eventFit:{wedding:'Fills the dance floor.',corporate:'Clear bass for presentations.'}});
 assert.equal(ok.success,true);
 assert.equal(updateSchema.safeParse({eventFit:{festival:'x'}}).success,false);
 assert.equal(updateSchema.safeParse({functionSummary:'x'.repeat(601)}).success,false);
 assert.equal(createSchema.safeParse({slug:'a-b',category:'sound',name:'A',eventFit:{party:'Loud'}}).success,true);
 const view=publicView({slug:'es18p',category:'sound',name:'ES18P',functionSummary:'Low end.',eventFit:{wedding:'Fills the floor.'},minQuantity:1,quantityOwned:1,stockTracked:false,isActive:true});
 assert.equal(view.functionSummary,'Low end.');assert.equal(view.eventFit.wedding,'Fills the floor.');
 assert.deepEqual(publicView({slug:'x',category:'c',name:'n'}).eventFit,{});
});
