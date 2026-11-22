const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');
const {removeGenreLanguages}=require('../scripts/remove-genre-languages');

test('genres have no language dependency in storage, APIs, or Work Elements',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const request=async(endpoint,method='GET',body)=>{
  const response=await fetch(db.origin+'/api'+endpoint,{method,headers:{Authorization:'Bearer qa-admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return{status:response.status,payload:await response.json()};
 };
 const prefix='/admin/music-ontology',options=prefix+'/work-elements/genre/options';
 const created=await request(options,'POST',{value:'Independent genre',description:'Any language.'});
 assert.equal(created.status,201,JSON.stringify(created.payload));
 let genre=created.payload.items.find(row=>row.id==='genre').options.find(row=>row.value==='Independent genre');
 assert.equal(Object.hasOwn(genre,'languageIds'),false);
 assert.equal(Object.hasOwn(genre,'languages'),false);
 const {Vocabulary}=db.service.models;
 let stored=await Vocabulary.collection.findOne({externalId:genre.id});
 assert.equal(Object.hasOwn(stored,'languageIds'),false);
 for(const endpoint of ['/music-ontology/vocabulary/'+genre.id,prefix+'/vocabulary/'+genre.id]){
  const row=(await request(endpoint)).payload.item;
  assert.equal(Object.hasOwn(row,'languageIds'),false);
 }
 // Both entry points reject attempts to recreate the removed relationship.
 assert.equal((await request(options,'POST',{value:'Linked genre',languageIds:[db.language]})).status,400);
 assert.equal((await request(prefix+'/vocabulary','POST',{kind:'genre',name:'Linked genre',languageIds:[db.language]})).status,400);
 assert.equal((await request(options+'/'+genre.id,'PUT',{value:genre.value,revision:genre.revision,languageIds:[db.language]})).status,400);
 assert.equal((await request(prefix+'/vocabulary/'+genre.id,'PUT',{kind:'genre',name:genre.value,revision:genre.revision,languageIds:[db.language]})).status,400);
 // Simulate a pre-migration record and confirm reads never expose legacy links.
 await Vocabulary.collection.updateOne({externalId:genre.id},{$set:{languageIds:[db.language],languageId:db.language,languages:[{id:db.language}]}});
 assert.equal(Object.hasOwn((await request('/music-ontology/vocabulary/'+genre.id)).payload.item,'languageIds'),false);
 const list=(await request(prefix+'/work-elements')).payload.items.find(row=>row.id==='genre').options.find(row=>row.id===genre.id);
 assert.equal(Object.hasOwn(list,'languages'),false);
 const dialect=(await request(prefix+'/vocabulary','POST',{kind:'dialect',name:'Test dialect',parentId:db.language,languageIds:[db.language]})).payload.item;
 const dialectBefore=await Vocabulary.collection.findOne({externalId:dialect.id});
 const backupDir=await fs.mkdtemp(path.join(os.tmpdir(),'genre-language-cleanup-'));t.after(()=>fs.rm(backupDir,{recursive:true,force:true}));
 const dryRun=await removeGenreLanguages();assert.ok(dryRun.genresWithLanguageFields>=1);
 const result=await removeGenreLanguages({apply:true,backupDir});assert.ok(result.changed>=1);
 stored=await Vocabulary.collection.findOne({externalId:genre.id});
 for(const field of ['languageIds','languageId','languages'])assert.equal(Object.hasOwn(stored,field),false);
 assert.equal(stored.name,'Independent genre');assert.equal(stored.description,'Any language.');
 assert.deepEqual(await Vocabulary.collection.findOne({externalId:dialect.id}),dialectBefore);
 assert.ok((await fs.stat(result.backup)).size>0);
 assert.equal((await removeGenreLanguages({apply:true,backupDir})).changed,0);
 // Renaming an older genre also unsets stale data without restoring the default array.
 await Vocabulary.collection.updateOne({externalId:genre.id},{$set:{languageIds:[db.language]}});
 const renamed=await request(options+'/'+genre.id,'PUT',{value:'Renamed independent genre',revision:stored.revision});
 assert.equal(renamed.status,200,JSON.stringify(renamed.payload));
 assert.equal(Object.hasOwn(await Vocabulary.collection.findOne({externalId:genre.id}),'languageIds'),false);
});
