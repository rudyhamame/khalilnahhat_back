const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');
test('recording archive and publication lifecycle',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const req=async(path,method='GET',body)=>{const response=await fetch(db.origin+'/api'+path,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 const write=async(kind,body,id)=>{const result=await req(`/admin/music-ontology/${kind}${id?'/'+id:''}`,id?'PUT':'POST',body);assert.equal(result.status,id?200:201,JSON.stringify(result.body));return result.body.item;};
 const existing=(await req('/admin/music-ontology/recordings/'+db.ids[0])).body.item;
 const make=(type)=>({name:type,workType:type,atoms:[{id:'a1',name:'Atom'}],audioUrl:existing.storedAudioUrl,durationMinutes:60/60,status:'PUBLISHED'});
 const music={id:db.music};
 await t.test('archive privately with a prepared sample, then publish and activate it atomically',async()=>{
  const type=await write('work-types',{name:'Workflow sample'});
  const original=await write('recordings',{...make(type.id,music.id),name:'Original public sample'});
  assert.equal((await req(`/admin/music-ontology/work-types/${type.id}/sample`,'PUT',{recordingId:original.id,startSec:0})).status,200);
  const fields={...make(type.id,music.id),name:'Prepared privately',status:'DRAFT',sampleStartSec:10};
  const saved=await write('recordings',fields);
  assert.equal(saved.sampleStartSec,10);assert.equal(saved.status,'DRAFT');
  assert.equal((await req('/music-ontology/recordings/'+saved.id)).status,404);
  let types=(await req('/music-ontology/work-types')).body.items;
  assert.equal(types.find(row=>row.id===type.id).sample.recordingId,original.id,'saving does not replace the public sample');
  const collection=(await req('/admin/music-archive/collections','POST',{title:'Workflow collection',workTypeId:type.id,recordingIds:[saved.id],published:true})).body.item;
  assert.ok(collection?.id);
  let publicCollection=(await req('/music-archive')).body.collections.find(row=>row.id===collection.id);
  assert.deepEqual(publicCollection.recordingIds,[],'archived recordings stay private inside a public collection');
  assert.equal((await req('/admin/music-ontology/recordings/'+saved.id,'PUT',{...fields,status:'PUBLISHED',revision:saved.revision,sampleStartSec:61})).status,400);
  types=(await req('/music-ontology/work-types')).body.items;
  assert.equal(types.find(row=>row.id===type.id).sample.recordingId,original.id,'invalid publication cannot replace a sample');
  const published=await write('recordings',{...fields,status:'PUBLISHED',revision:saved.revision},saved.id);
  assert.equal(published.status,'PUBLISHED');assert.equal(published.sampleStartSec,10);
  assert.equal((await req('/music-ontology/recordings/'+saved.id)).status,200);
  types=(await req('/music-ontology/work-types')).body.items;
  assert.equal(types.find(row=>row.id===type.id).sample.recordingId,saved.id);assert.equal(types.find(row=>row.id===type.id).sample.startSec,10);
  publicCollection=(await req('/music-archive')).body.collections.find(row=>row.id===collection.id);
  assert.deepEqual(publicCollection.recordingIds,[saved.id]);
  const archivedAgain=await write('recordings',{...fields,revision:published.revision},saved.id);
  assert.equal(archivedAgain.status,'DRAFT');assert.equal((await req('/music-ontology/recordings/'+saved.id)).status,404);
 });

});
