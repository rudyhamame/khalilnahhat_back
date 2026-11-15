const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');

test('vocalist language and dialect dependencies persist and reject mismatched terms',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const request=async(path,method='GET',body)=>{
  const response=await fetch(db.origin+'/api'+path,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,payload:await response.json()};
 };
 const prefix='/admin/music-ontology';
 const french=(await request(prefix+'/vocabulary','POST',{kind:'language',name:'French',isoCode:'fr'})).payload.item;
 const dialect=(await request(prefix+'/vocabulary','POST',{kind:'dialect',name:'Levantine',parentId:db.language,languageIds:[db.language]})).payload.item;
 const body={value:'Vocalist dependency test',languageIds:[db.language],dialectIds:[dialect.id]};
 const created=await request(prefix+'/work-elements/artist/options','POST',body);
 assert.equal(created.status,201,JSON.stringify(created.payload));
 let artist=created.payload.items.find(row=>row.id==='artist').options.find(row=>row.value===body.value);
 assert.deepEqual(artist.languageIds,[db.language]);
 assert.deepEqual(artist.dialectIds,[dialect.id]);
 assert.deepEqual(artist.dialects,[{id:dialect.id,name:'Levantine'}]);
 const publicRow=(await request('/music-ontology/vocabulary?kind=artist')).payload.items.find(row=>row.id===artist.id);
 assert.deepEqual(publicRow.dialectIds,[dialect.id]);
 assert.deepEqual(publicRow.languageIds,[db.language]);
 const renamed=await request(prefix+'/work-elements/artist/options/'+artist.id,'PUT',{value:'Renamed vocalist',revision:artist.revision});
 assert.equal(renamed.status,200,JSON.stringify(renamed.payload));
 artist=renamed.payload.items.find(row=>row.id==='artist').options.find(row=>row.id===artist.id);
 assert.deepEqual(artist.dialectIds,[dialect.id]);
 assert.equal((await request(prefix+'/work-elements/artist/options/'+artist.id,'PUT',{value:artist.value,revision:artist.revision,languageIds:[french.id]})).status,400);
 assert.equal((await request(prefix+'/work-elements/artist/options','POST',{...body,value:'Mismatched vocalist',languageIds:[french.id]})).status,400);
 assert.equal((await request(prefix+'/work-elements/artist/options','POST',{...body,value:'Invalid dialect vocalist',dialectIds:[db.artist]})).status,400);
 assert.equal((await request(prefix+'/work-elements/artist/options','POST',{...body,value:'No language vocalist',languageIds:[]})).status,400);
 assert.equal((await request(prefix+'/work-elements/dialect/options/'+dialect.id,'DELETE',{revision:dialect.revision})).status,409);
 const cleared=await request(prefix+'/work-elements/artist/options/'+artist.id,'PUT',{value:artist.value,revision:artist.revision,languageIds:[french.id],dialectIds:[]});
 assert.equal(cleared.status,200,JSON.stringify(cleared.payload));
 artist=cleared.payload.items.find(row=>row.id==='artist').options.find(row=>row.id===artist.id);
 assert.deepEqual(artist.dialectIds,[]);
 assert.deepEqual(artist.languageIds,[french.id]);
});
