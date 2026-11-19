const{test}=require('node:test');const assert=require('node:assert/strict');const{fixture}=require('./helpers/music-ontology-fixture.cjs');
test('time signatures are catalog dependencies and referenced signatures cannot be renamed or deleted',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());const request=async(path,method='GET',body)=>{const response=await fetch(db.origin+'/api/admin/music-ontology'+path,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()}};
 let catalog=await request('/work-elements');const signatures=catalog.data.items.find(e=>e.id==='timeSignature');assert.ok(signatures.options.some(e=>e.value==='3/4'));
 const created=await request('/work-elements/rhythm/options','POST',{value:'Waltz'});assert.equal(created.status,201);
 const signature=signatures.options.find(e=>e.value==='3/4');const deleted=await request('/work-elements/timeSignature/options/'+signature.id,'DELETE',{revision:signature.revision});assert.equal(deleted.status,409);assert.match(deleted.data.message,/used by a rhythm/);
 const renamed=await request('/work-elements/timeSignature/options/'+signature.id,'PUT',{value:'11/16',revision:signature.revision});assert.equal(renamed.status,409);
 for(const value of ['0/4','3/3','bad','99/4'])assert.equal((await request('/work-elements/timeSignature/options','POST',{value})).status,400);
 const map={meter:'11/16',subdivision:1,steps:[...'D..........']};assert.equal((await request('/work-elements/rhythm/options','POST',{value:'Eleven beat test',beatMap:map})).status,400,'Missing signature is rejected');
 const added=await request('/work-elements/timeSignature/options','POST',{value:'11/16'});assert.equal(added.status,201);assert.equal((await request('/work-elements/rhythm/options','POST',{value:'Eleven beat test',beatMap:map})).status,201);
 catalog=await request('/work-elements');assert.equal(catalog.data.items.find(e=>e.id==='rhythm').options.find(e=>e.value==='Eleven beat test').beatMap.meter,'11/16');
});
