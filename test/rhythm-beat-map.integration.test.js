const {test}=require('node:test');const assert=require('node:assert/strict');const{fixture}=require('./helpers/music-ontology-fixture.cjs');
test('rhythm creation auto-attaches known maps and persists custom maps through reload and rename',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const request=async(path,method='GET',body)=>{const response=await fetch(db.origin+'/api/admin/music-ontology'+path,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:response.status,payload:await response.json()}};
 const created=await request('/work-elements/rhythm/options','POST',{value:'Waltz'});assert.equal(created.status,201,JSON.stringify(created.payload));
 let waltz=created.payload.items.find(e=>e.id==='rhythm').options.find(e=>e.value==='Waltz');assert.equal(waltz.beatMap.meter,'3/4');assert.deepEqual(waltz.beatMap.steps,[...'D.T.T.']);
 const stored=(await request('/vocabulary/'+waltz.id)).payload.item;assert.deepEqual(stored.beatMap.steps,[...'D.T.T.']);
 const custom={meter:'5/8',subdivision:2,steps:[...'D.T.K.D.T.']};const added=await request('/work-elements/rhythm/options','POST',{value:'Custom five',beatMap:custom});assert.equal(added.status,201,JSON.stringify(added.payload));const row=added.payload.items.find(e=>e.id==='rhythm').options.find(e=>e.value==='Custom five');
 const invalid=await request('/work-elements/rhythm/options','POST',{value:'Invalid map',beatMap:{...custom,steps:['D']}});assert.equal(invalid.status,400);
 const renamed=await request('/work-elements/rhythm/options/'+row.id,'PUT',{value:'Custom five renamed',revision:row.revision});assert.equal(renamed.status,200,JSON.stringify(renamed.payload));
 const reload=(await request('/work-elements')).payload.items.find(e=>e.id==='rhythm').options.find(e=>e.id===row.id);assert.equal(reload.beatMap.meter,'5/8');assert.deepEqual(reload.beatMap.steps,custom.steps);
});
