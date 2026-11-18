#!/usr/bin/env node
// Moves recordings out of the shared archive collection into their own collection (musicrecordings), in the new shape.
// Dry run by default. Nothing is deleted from archiveitems unless its copy was written:
//   node scripts/migrate-recordings.js            # report only
//   node scripts/migrate-recordings.js --apply    # copy, then remove the moved documents
// Old work-based recordings (a workId but no atoms) cannot be converted: they are listed and left in place.
require('dotenv').config({quiet:true});
const mongoose=require('mongoose');
const text=v=>typeof v==='string'?v:'';
const uniq=list=>[...new Set(list.filter(Boolean))];
const minutes=row=>row.durationMinutes??(row.duration?(()=>{const s=String(row.duration).split(':').reduce((t,n)=>t*60+Number(n),0);return Number.isFinite(s)?Math.round(s/60*10000)/10000:null;})():null);
const statusOf=row=>row.status||(row.publicationStatus?(row.publicationStatus==='PUBLISHED'&&row.archivalStatus!=='ARCHIVED'?'PUBLISHED':row.publicationStatus==='DRAFT'?'DRAFT':'ARCHIVED'):(row.published===false?'DRAFT':'PUBLISHED'));
const credit=c=>({artistId:c.artistId,...(c.instrumentId?{instrumentId:c.instrumentId}:{})});
// An atom in the new shape (credits inside sound; language entries carry their own dialects; no hasLyrics, releaseDate, detail or lyrics times).
function atom(item,parentOf){
 const sound=item.sound||{},musicians=[...(sound.musicianCredits||[]),...(item.musicianCredits||[])].map(credit);
 const out={id:item.id,name:item.name,sound:{musicianCredits:musicians,bpms:uniq([...(sound.bpms||[]),sound.bpm]),keys:uniq([...(sound.keys||[]),sound.key]),rhythmIds:uniq([...(sound.rhythmIds||[]),sound.rhythmId]),genreIds:sound.genreIds||[]},lyrics:null};
 const year=item.releaseYear??(/^\d{4}/.test(item.releaseDate||'')?Number(item.releaseDate.slice(0,4)):null);
 if(year!=null)out.releaseYear=year;
 if(item.audioRange)out.audioRange={startSec:item.audioRange.startSec,endSec:item.audioRange.endSec};
 const l=item.lyrics;
 if(l&&item.hasLyrics!==false){
  const languageIds=uniq([...(l.languageIds||[]),l.languageId]),dialectIds=uniq([...(l.dialectIds||[]),l.dialectId]);
  const languages=Array.isArray(l.languages)?l.languages:languageIds.map(languageId=>({languageId,dialectIds:dialectIds.filter(id=>(parentOf(id)||languageIds[0])===languageId)}));
  out.lyrics={languages:languages.map(row=>({languageId:row.languageId,dialectIds:row.dialectIds||[]})),vocalistCredits:(l.vocalistCredits||[]).map(credit)};
 }
 return out;
}
function recording(row,parentOf){
 const atoms=(row.atoms||row.items||[]).map(item=>atom(item,parentOf));
 return {externalId:row.externalId,name:row.name||row.title,description:text(row.description),workType:row.workType||row.recordingType,status:statusOf(row),atomCount:atoms.length,releaseDate:text(row.releaseDate||row.date).slice(0,10),durationMinutes:minutes(row),audioUrl:text(row.audioUrl),coverImage:text(row.coverImage),  audioMetadata:row.audioMetadata?{format:row.audioMetadata.format,sizeBytes:row.audioMetadata.sizeBytes}:null,stems:row.stems||null,atoms,revision:Math.max(1,row.ontologyRevision||row.revision||1),createdAt:row.createdAt,updatedAt:row.updatedAt};
}
module.exports={recording,atom};
if(require.main===module)(async()=>{
 const apply=process.argv.includes('--apply');
 await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil',serverSelectionTimeoutMS:10000,autoIndex:false,autoCreate:false});
 const db=mongoose.connection,archive=db.collection('archiveitems'),target=db.collection('musicrecordings');
 const parents=new Map((await db.collection('musicvocabularies').find({kind:'dialect'},{projection:{externalId:1,parentId:1}}).toArray()).map(row=>[row.externalId,row.parentId]));
 const parentOf=id=>parents.get(id)||null;
 const isRecording={$or:[{'atoms.0':{$exists:true}},{'items.0':{$exists:true}},{workId:{$exists:true,$ne:''}},{publicationStatus:{$exists:true}},{status:{$exists:true}},{recordingType:{$exists:true}},{workType:{$exists:true}}]};
 const found=await archive.find(isRecording).toArray();
 const convertible=found.filter(row=>(row.atoms||row.items||[]).length>0),skipped=found.filter(row=>!(row.atoms||row.items||[]).length);
 let copied=0,removed=0;
 if(apply)for(const row of convertible){
  const doc=recording(row,parentOf);
  await target.updateOne({externalId:doc.externalId},{$set:doc},{upsert:true});
  copied++;
  if(await target.countDocuments({externalId:doc.externalId})===1)removed+=(await archive.deleteOne({_id:row._id})).deletedCount;
 }
 // Work types no longer hold an Individual / Multiple amount or a 1-minute sample.
 const types=await db.collection('djworktypes').countDocuments({$or:[{amount:{$exists:true}},{sample:{$exists:true}}]});
 if(apply&&types)await db.collection('djworktypes').updateMany({},{$unset:{amount:'',sample:''}});
 console.log(JSON.stringify({apply,recordingsFound:found.length,toMove:convertible.length,copied,removedFromArchive:removed,leftInPlace:skipped.map(row=>({externalId:row.externalId,reason:'no atoms (old work-based recording)'})),workTypesWithAmount:types},null,1));
 await mongoose.disconnect();
})().catch(error=>{console.error(error.message);process.exit(1)});
