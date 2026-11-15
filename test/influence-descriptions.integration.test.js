const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');

test('influence descriptions follow their entry through create, rename and public reads',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const request=async(path,method='GET',body)=>{
  const response=await fetch(db.origin+'/api'+path,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,payload:await response.json()};
 };
 const admin='/admin/music-ontology/work-elements/influences/options';
 const created=await request(admin,'POST',{value:'Jazz influence',description:'  Swing rhythms and improvised melodies.  '});
 assert.equal(created.status,201,JSON.stringify(created.payload));
 let option=created.payload.items.find(row=>row.id==='influences').options.find(row=>row.value==='Jazz influence');
 assert.equal(option.description,'Swing rhythms and improvised melodies.');
 const publicOption=async()=>((await request('/music-ontology/influences')).payload.items.find(row=>row.id===option.id));
 assert.equal((await publicOption()).description,option.description);
 const renamed=await request(admin+'/'+option.id,'PUT',{value:'Jazz & swing',revision:option.revision});
 assert.equal(renamed.status,200,JSON.stringify(renamed.payload));
 option=renamed.payload.items.find(row=>row.id==='influences').options.find(row=>row.id===option.id);
 assert.equal(option.description,'Swing rhythms and improvised melodies.');
 assert.equal((await publicOption()).value,'Jazz & swing');
 const updated=await request(admin+'/'+option.id,'PUT',{value:option.value,revision:option.revision,description:'Warm brass, swing and improvisation.'});
 assert.equal(updated.status,200,JSON.stringify(updated.payload));
 option=updated.payload.items.find(row=>row.id==='influences').options.find(row=>row.id===option.id);
 assert.equal((await publicOption()).description,'Warm brass, swing and improvisation.');
 assert.equal((await request(admin+'/'+option.id,'PUT',{value:option.value,revision:option.revision,description:'x'.repeat(2001)})).status,400);
 assert.equal((await request(admin+'/'+option.id,'PUT',{value:option.value,revision:option.revision,description:''})).status,200);
 assert.equal((await publicOption()).description,'');
 const legacy=await request(admin,'POST',{value:'Existing name format'});
 assert.equal(legacy.status,201);
 assert.equal(legacy.payload.items.find(row=>row.id==='influences').options.find(row=>row.value==='Existing name format').description,'');
});
