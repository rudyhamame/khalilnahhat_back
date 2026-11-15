const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');

test('Work Elements genre descriptions are saved, edited, preserved on rename and cleared',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const request=async(path,method='GET',body)=>{
  const response=await fetch(db.origin+'/api'+path,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,payload:await response.json()};
 };
 const endpoint='/admin/music-ontology/work-elements/genre/options';
 const option=result=>result.payload.items.find(row=>row.id==='genre').options.find(row=>row.value==='Description test genre'||row.value==='Renamed test genre');
 let result=await request(endpoint,'POST',{value:'Description test genre',description:'  Warm melodies and a steady beat.  '});
 assert.equal(result.status,201,JSON.stringify(result.payload));
 let genre=option(result);
 assert.equal(genre.description,'Warm melodies and a steady beat.');
 assert.equal((await request('/music-ontology/vocabulary/'+genre.id)).payload.item.description,genre.description);
 result=await request(endpoint+'/'+genre.id,'PUT',{value:genre.value,revision:genre.revision,description:'Bright vocals and dance rhythms.'});
 assert.equal(result.status,200,JSON.stringify(result.payload));
 genre=option(result);
 assert.equal(genre.description,'Bright vocals and dance rhythms.');
 result=await request(endpoint+'/'+genre.id,'PUT',{value:'Renamed test genre',revision:genre.revision});
 assert.equal(result.status,200,JSON.stringify(result.payload));
 genre=option(result);
 assert.equal(genre.description,'Bright vocals and dance rhythms.');
 assert.equal((await request(endpoint+'/'+genre.id,'PUT',{value:genre.value,revision:genre.revision,description:'x'.repeat(2001)})).status,400);
 result=await request(endpoint+'/'+genre.id,'PUT',{value:genre.value,revision:genre.revision,description:''});
 assert.equal(result.status,200,JSON.stringify(result.payload));
 assert.equal(option(result).description,'');
});
