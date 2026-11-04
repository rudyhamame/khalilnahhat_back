#!/usr/bin/env node
require('dotenv').config({quiet:true});
const mongoose=require('mongoose');
const fs=require('node:fs/promises');
const path=require('node:path');
const {EJSON}=mongoose.mongo.BSON;

async function main(){
 if(!process.env.MONGODB_URI)throw Error('Configure the hosted MONGODB_URI and MONGODB_DB_NAME before running this cleanup.');
 const apply=process.argv.includes('--apply');
 await mongoose.connect(process.env.MONGODB_URI,{dbName:process.env.MONGODB_DB_NAME||'khalil',autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:10000});
 const {Vocabulary}=require('../src/music-ontology/models');
 const collection=mongoose.connection.db.collection(Vocabulary.collection.name);
 const inspect=async session=>{
  const genres=await collection.find({kind:'genre'},{session}).toArray();
  const affected=genres.filter(row=>typeof row.parentId==='string'&&row.parentId.length>0);
  const groups=new Map();
  for(const row of genres){const key=row.normalizedName||row.name.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');groups.set(key,[...(groups.get(key)||[]),row]);}
  const conflicts=[...groups.values()].filter(rows=>rows.length>1&&rows.some(row=>affected.some(item=>item._id.equals(row._id))));
  if(conflicts.length)throw Error(`${conflicts.length} genre name conflicts must be resolved before removing parents. No records were changed.`);
  return {genres,affected};
 };
 const initial=await inspect();
 if(!apply||!initial.affected.length){console.log(JSON.stringify({mode:apply?'apply':'dry-run',totalGenres:initial.genres.length,genresWithParent:initial.affected.length,changed:0}));return;}
 const backupDir=path.resolve(process.env.GENRE_PARENT_BACKUP_DIR||'artifacts/genre-parent-removal');
 await fs.mkdir(backupDir,{recursive:true,mode:0o700});
 const backup=path.join(backupDir,`genres-before-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
 // Back up all genre documents so original identities and relationships can be recovered.
 await fs.writeFile(backup,EJSON.stringify(initial.genres,null,2,{relaxed:false}),{flag:'wx',mode:0o600});
 const session=await mongoose.startSession();
 let changed=0;
 try{await session.withTransaction(async()=>{
  const current=await inspect(session);
  if(current.genres.length!==initial.genres.length||current.genres.some(row=>{
   const previous=initial.genres.find(item=>item._id.equals(row._id));
   return !previous||EJSON.stringify(previous)!==EJSON.stringify(row);
  }))throw Error('Genre data changed after the backup. Run the cleanup again to create a fresh backup.');
  const result=await collection.bulkWrite(current.affected.map(row=>({updateOne:{filter:{_id:row._id,parentId:row.parentId,revision:row.revision===undefined?{$exists:false}:row.revision},update:{$set:{parentId:'',updatedAt:new Date()},$inc:{revision:1}}}})),{session,ordered:true});
  if(result.matchedCount!==current.affected.length)throw Error('A genre changed during cleanup; the transaction was rolled back.');
  const after=await inspect(session);
  if(after.affected.length||after.genres.length!==initial.genres.length)throw Error('Verification failed; the transaction was rolled back.');
  changed=result.modifiedCount;
 });}finally{await session.endSession();}
 console.log(JSON.stringify({mode:'apply',totalGenres:initial.genres.length,changed,remainingParents:0,backup}));
}
main().catch(error=>{console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g,'[database connection]'));process.exitCode=1;}).finally(()=>mongoose.disconnect());
