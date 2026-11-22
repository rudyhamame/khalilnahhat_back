#!/usr/bin/env node
const mongoose=require('mongoose');
const fs=require('node:fs/promises');
const path=require('node:path');
const {EJSON}=mongoose.mongo.BSON;
const fields=['languageIds','languageId','languages'];

async function removeGenreLanguages({apply=false,backupDir='artifacts/genre-language-removal'}={}){
 const {Vocabulary}=require('../src/music-ontology/models');
 // Use the raw collection so Mongoose defaults cannot recreate removed properties.
 const collection=mongoose.connection.db.collection(Vocabulary.collection.name);
 const genres=await collection.find({kind:'genre'}).toArray();
 const affected=genres.filter(row=>fields.some(field=>Object.hasOwn(row,field)));
 if(!apply||!affected.length)return{mode:apply?'apply':'dry-run',totalGenres:genres.length,genresWithLanguageFields:affected.length,changed:0};
 await fs.mkdir(backupDir,{recursive:true,mode:0o700});
 const backup=path.resolve(backupDir,`genres-before-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
 await fs.writeFile(backup,EJSON.stringify(genres,null,2,{relaxed:false}),{flag:'wx',mode:0o600});
 const session=await mongoose.startSession();let changed=0;
 try{await session.withTransaction(async()=>{
  const current=await collection.find({kind:'genre'},{session}).toArray();
  if(current.length!==genres.length||current.some(row=>{
   const previous=genres.find(item=>item._id.equals(row._id));
   return !previous||EJSON.stringify(previous)!==EJSON.stringify(row);
  }))throw Error('Genre records changed after backup. Retry with a fresh backup.');
  const result=await collection.bulkWrite(affected.map(row=>({updateOne:{filter:{_id:row._id,kind:'genre',revision:row.revision===undefined?{$exists:false}:row.revision},update:{$unset:Object.fromEntries(fields.map(field=>[field,''])),$inc:{revision:1},$set:{updatedAt:new Date()}}}})),{session,ordered:true});
  if(result.matchedCount!==affected.length)throw Error('A genre changed during cleanup; the transaction was rolled back.');
  const after=await collection.find({kind:'genre'},{session}).toArray();
  const stable=row=>{const {_id,revision,updatedAt,languageIds,languageId,languages,...rest}=row;return EJSON.stringify(rest);};
  if(after.length!==genres.length||after.some(row=>fields.some(field=>Object.hasOwn(row,field))||stable(row)!==stable(genres.find(item=>item._id.equals(row._id)))))throw Error('Genre cleanup verification failed; the transaction was rolled back.');
  changed=result.modifiedCount;
 });}finally{await session.endSession();}
 return{mode:'apply',totalGenres:genres.length,changed,remainingLanguageFields:0,backup};
}

if(require.main===module){
 require('dotenv').config({quiet:true});
 (async()=>{
  if(!process.env.MONGODB_URI)throw Error('Configure MONGODB_URI before running this cleanup.');
  await mongoose.connect(process.env.MONGODB_URI,{dbName:process.env.MONGODB_DB_NAME||'khalil',autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:10000});
  console.log(JSON.stringify(await removeGenreLanguages({apply:process.argv.includes('--apply'),backupDir:process.env.GENRE_LANGUAGE_BACKUP_DIR||'artifacts/genre-language-removal'})));
 })().catch(error=>{console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g,'[database connection]'));process.exitCode=1;}).finally(()=>mongoose.disconnect());
}
module.exports={removeGenreLanguages};
