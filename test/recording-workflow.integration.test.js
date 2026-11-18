const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');
test('recording archive and publication lifecycle',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const req=async(path,method='GET',body)=>{const response=await fetch(db.origin+'/api'+path,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 const write=async(kind,body,id)=>{const result=await req(`/admin/music-ontology/${kind}${id?'/'+id:''}`,id?'PUT':'POST',body);assert.equal(result.status,id?200:201,JSON.stringify(result.body));return result.body.item;};
 const existing=(await req('/admin/music-ontology/recordings/'+db.ids[0])).body.item;
 const make=(type)=>({name:type,workType:type,atoms:[{id:'a1',name:'Atom'}],audioUrl:existing.storedAudioUrl,durationMinutes:60/60,status:'PUBLISHED'});
 const music={id:db.music};
 await t.test('save privately, then publish and unpublish',async()=>{
  const type=await write('work-types',{name:'Workflow lifecycle'});
  const fields={...make(type.id,music.id),name:'Prepared privately',status:'DRAFT'};
  const saved=await write('recordings',fields);
  assert.equal(saved.status,'DRAFT');
  assert.equal((await req('/music-ontology/recordings/'+saved.id)).status,404);
  const collection=(await req('/admin/music-archive/collections','POST',{title:'Workflow collection',workTypeId:type.id,recordingIds:[saved.id],published:true})).body.item;
  assert.ok(collection?.id);
  let publicCollection=(await req('/music-archive')).body.collections.find(row=>row.id===collection.id);
  assert.deepEqual(publicCollection.recordingIds,[],'archived recordings stay private inside a public collection');
  const published=await write('recordings',{...fields,status:'PUBLISHED',revision:saved.revision},saved.id);
  assert.equal(published.status,'PUBLISHED');
  assert.equal((await req('/music-ontology/recordings/'+saved.id)).status,200);
  publicCollection=(await req('/music-archive')).body.collections.find(row=>row.id===collection.id);
  assert.deepEqual(publicCollection.recordingIds,[saved.id]);
  const archivedAgain=await write('recordings',{...fields,revision:published.revision},saved.id);
  assert.equal(archivedAgain.status,'DRAFT');assert.equal((await req('/music-ontology/recordings/'+saved.id)).status,404);
 });

});
