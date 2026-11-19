#!/usr/bin/env node
// A recording no longer has a name of its own: its name is derived from its atoms' names (src/music-ontology/recording-name.js).
// This removes the old stored `name` from recordings (and from their saved versions). A recording that has no atoms would lose its only name,
// so it gets one atom carrying that name first. Dry run by default:
//   node scripts/drop-recording-name.js            # report only
//   node scripts/drop-recording-name.js --apply    # write the change
require('dotenv').config({quiet:true});
const mongoose=require('mongoose');
const {randomUUID}=require('node:crypto');
const apply=process.argv.includes('--apply');
(async()=>{
 await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil',serverSelectionTimeoutMS:10000});
 const recordings=mongoose.connection.collection('musicrecordings'),versions=mongoose.connection.collection('musicrecordingversions');
 let renamed=0,kept=0;const report=[];
 for(const row of await recordings.find({name:{$exists:true}}).toArray()){
  const named=(row.atoms||[]).some(atom=>String(atom?.name||'').trim());
  if(named){kept++;report.push(`${row.externalId}: name "${row.name}" dropped (derived from ${row.atoms.length} atom name(s) instead)`);}
  else{renamed++;report.push(`${row.externalId}: no named atoms, atom "${row.name}" added`);}
  if(!apply)continue;
  const update={$unset:{name:''}};
  if(!named)Object.assign(update,{$set:{atoms:[{id:randomUUID(),name:String(row.name||'Untitled').trim()||'Untitled',sound:{musicianCredits:[],rhythmIds:[],genreIds:[]},lyrics:null}],atomCount:1}});
  await recordings.updateOne({_id:row._id},update);
 }
 if(apply)await versions.updateMany({'snapshot.name':{$exists:true}},{$unset:{'snapshot.name':''}});
 console.log(report.join('\n')||'No recording has a stored name.');
 console.log(`${apply?'Applied':'Dry run'}: ${kept} derived from atoms, ${renamed} given an atom.`);
 await mongoose.disconnect();
})().catch(error=>{console.error(error.message);process.exit(1);});
