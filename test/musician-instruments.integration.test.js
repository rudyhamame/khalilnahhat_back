const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');

test('musician instrument dependencies are accepted, validated and persisted through HTTP',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const request=async(path,method='GET',body)=>{
  const response=await fetch(db.origin+'/api/admin/music-ontology'+path,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,payload:await response.json()};
 };
 const catalog=(await request('/work-elements')).payload.items;
 const instrument=catalog.find(row=>row.id==='instrument').options[0];
 const created=await request('/work-elements/musician/options','POST',{value:'Instrument regression musician',instrumentId:instrument.id});
 assert.equal(created.status,201,JSON.stringify(created.payload));
 const musician=created.payload.items.find(row=>row.id==='musician').options.find(row=>row.value==='Instrument regression musician');
 assert.equal(musician.instrumentId,instrument.id);
 assert.equal(musician.instrument.name,instrument.value);
 const stored=(await request('/vocabulary/'+musician.id)).payload.item;
 assert.equal(stored.instrumentId,instrument.id);
 const invalid=await request('/work-elements/musician/options/'+musician.id,'PUT',{value:musician.value,revision:musician.revision,instrumentId:db.artist});
 assert.equal(invalid.status,400);assert.match(invalid.payload.message,/existing instrument/);
 const recording=await request('/recordings','POST',{title:'Instrument regression recording',recordingType:'MIX',recordingAmount:'INDIVIDUAL',items:[{id:'instrument-regression-atom',name:'Instrument regression atom',hasLyrics:false,musicianCredits:[{artistId:musician.id,instrumentId:instrument.id}]}]});
 assert.equal(recording.status,201,JSON.stringify(recording.payload));
 const reloaded=(await request('/recordings/'+recording.payload.item.id)).payload.item;
 assert.equal(reloaded.items[0].musicianCredits[0].instrumentId,instrument.id);
 const cleared=await request('/work-elements/musician/options/'+musician.id,'PUT',{value:musician.value,revision:musician.revision,instrumentId:null});
 assert.equal(cleared.status,200,JSON.stringify(cleared.payload));
 assert.equal(cleared.payload.items.find(row=>row.id==='musician').options.find(row=>row.id===musician.id).instrumentId,null);
});
