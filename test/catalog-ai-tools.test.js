const test=require('node:test'),assert=require('node:assert/strict');
const {createRegistry}=require('../src/ai-admin/registry');
test('administrator catalog and set tools reuse editor validation and retain approvals',()=>{
 const registry=createRegistry({invoke:async()=>{throw new Error('No write expected');}});
 const equipment=registry.entries.get('equipment_update');
 assert.equal(equipment.policy,'APPROVAL_REQUIRED');
 const body=equipment.schema.parse({id:'set',body:{isSet:true,setItems:[{equipmentId:'speaker',quantity:2,y:.535}],functionSummary:'A complete pair'}}).body;
 assert.equal(body.setItems[0].y,.535);assert.equal(body.setItems[0].quantity,2);
 assert.equal(equipment.schema.safeParse({id:'set',body:{setItems:[{equipmentId:'speaker',quantity:-1}]}}).success,false);
 const catalog=registry.entries.get('catalog_save');
 assert.equal(catalog.policy,'APPROVAL_REQUIRED');
 assert.deepEqual(catalog.schema.parse({id:'sound',kind:'service',create:false,body:{description:'Updated'}}).body,{description:'Updated'});
 assert.deepEqual(catalog.schema.parse({id:'wedding',kind:'event',create:false,body:{galleryImages:['https://assets.example.com/work.jpg']}}).body.galleryImages,['https://assets.example.com/work.jpg']);
});
