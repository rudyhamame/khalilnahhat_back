#!/usr/bin/env node
// Moves a stored recording's single bpm / key / rhythmId into its bpms / keys / rhythmIds list, then removes the single field.
// Also sets status from the old publicationStatus + archivalStatus (PUBLISHED, DRAFT, otherwise ARCHIVED), drops the other retired keys, sets atomCount (the number of items) and removes the stored recordingAmount.
// Applies to recording.musical and each item.sound. Dry run by default: node scripts/merge-recording-singular-keys.js [--apply]
require('dotenv').config({quiet:true});
const mongoose=require('mongoose');
const REMOVED=['recordingCredits','recordingAmount','publicationStatus','archivalStatus','sourceRecordingIds','sourceWorkIds','componentWorkIds','versionLabel','productionNotes','provenance'];
const PAIRS=[['bpm','bpms'],['key','keys'],['rhythmId','rhythmIds']];
function merge(obj){
 let changed=false;
 if(!obj||typeof obj!=='object')return false;
 for(const [one,many] of PAIRS){
  if(!(one in obj))continue;
  const list=Array.isArray(obj[many])?obj[many]:[];
  if(obj[one]!=null&&obj[one]!==''&&!list.includes(obj[one]))list.unshift(obj[one]);
  obj[many]=list;delete obj[one];changed=true;
 }
 return changed;
}
// Atom lyrics become languages[{languageId, dialectIds}] (each dialect under its language); lyrics startSec / endSec go.
// Credits keep only artistId (+ instrumentId for musicians): the free-text detail goes.
// Atom shape: musicianCredits move into sound, hasLyrics goes (vocal details present = has vocals), releaseDate goes (releaseYear stays).
function fixItem(item,parentOf=()=>null){
 let changed=false;
 if('musicianCredits' in item){item.sound={...(item.sound||{}),musicianCredits:[...(item.sound?.musicianCredits||[]),...(item.musicianCredits||[])]};delete item.musicianCredits;changed=true;}
 if('hasLyrics' in item){if(item.hasLyrics===false)item.lyrics=null;delete item.hasLyrics;changed=true;}
 if('releaseDate' in item){if(item.releaseYear==null&&/^\d{4}/.test(item.releaseDate||''))item.releaseYear=Number(item.releaseDate.slice(0,4));delete item.releaseDate;changed=true;}
 if(item.lyrics&&!Array.isArray(item.lyrics.languages)){
  const l=item.lyrics,ids=[...new Set([...(l.languageIds||[]),l.languageId].filter(Boolean))],dialects=[...new Set([...(l.dialectIds||[]),l.dialectId].filter(Boolean))];
  l.languages=ids.map(languageId=>({languageId,dialectIds:dialects.filter(id=>(parentOf(id)||ids[0])===languageId)}));
  for(const key of ['languageIds','dialectIds','languageId','dialectId'])delete l[key];changed=true;
 }
 if(item.lyrics&&('startSec' in item.lyrics||'endSec' in item.lyrics)){delete item.lyrics.startSec;delete item.lyrics.endSec;changed=true;}
 for(const credit of [...(item.sound?.musicianCredits||[]),...(item.lyrics?.vocalistCredits||[])])if('detail' in credit){delete credit.detail;changed=true;}
 return changed;
}
module.exports={merge,fixItem};
if(require.main===module)(async()=>{
 const apply=process.argv.includes('--apply');
 await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil',serverSelectionTimeoutMS:10000,autoIndex:false,autoCreate:false});
 const {ArchiveItem}=require('../src/models');
 const parents=new Map((await mongoose.connection.collection('musicvocabularies').find({kind:'dialect'},{projection:{externalId:1,parentId:1}}).toArray()).map(row=>[row.externalId,row.parentId]));
 const parentOf=id=>parents.get(id)||null;
 let found=0,changed=0;
 for await(const row of ArchiveItem.collection.find({$or:[{musical:{$type:'object'}},{'items.0':{$exists:true}},...REMOVED.map(k=>({[k]:{$exists:true}}))]},{projection:{musical:1,items:1,atomCount:1,status:1,published:1,publicationStatus:1,archivalStatus:1,...Object.fromEntries(REMOVED.map(k=>[k,1]))}})){
  const set={};
  if(merge(row.musical))set.musical=row.musical;
  if(Array.isArray(row.items)&&row.items.map(item=>[merge(item.sound),fixItem(item,parentOf)].includes(true)).includes(true))set.items=row.items;
  // recordingAmount is no longer stored: the atom count replaces it and is counted from the items.
  const unset={};const lifecycle=row.status||(row.publicationStatus?(row.publicationStatus==='PUBLISHED'&&row.archivalStatus!=='ARCHIVED'?'PUBLISHED':row.publicationStatus==='DRAFT'?'DRAFT':'ARCHIVED'):null);if(lifecycle&&row.status!==lifecycle)set.status=lifecycle;for(const key of REMOVED)if(key in row)unset[key]='';if(Array.isArray(row.items)&&row.items.length!==row.atomCount)set.atomCount=row.items.length;
  if(!Object.keys(set).length&&!Object.keys(unset).length)continue;
  found++;
  if(apply){await ArchiveItem.collection.updateOne({_id:row._id},{...(Object.keys(set).length?{$set:set}:{}),...(Object.keys(unset).length?{$unset:unset}:{})});changed++;}
 }
 // The DJ work type no longer holds an Individual / Multiple amount.
 const types=await mongoose.connection.collection('djworktypes').countDocuments({amount:{$exists:true}});
 if(apply&&types)await mongoose.connection.collection('djworktypes').updateMany({},{$unset:{amount:''}});
 console.log(JSON.stringify({apply,found,changed,workTypesWithAmount:types}));
 await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
