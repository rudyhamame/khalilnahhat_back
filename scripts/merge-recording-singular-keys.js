#!/usr/bin/env node
// Moves a stored recording's single bpm / key / rhythmId into its bpms / keys / rhythmIds list, then removes the single field.
// Also sets atomCount (the number of items) and removes the stored recordingAmount.
// Applies to recording.musical and each item.sound. Dry run by default: node scripts/merge-recording-singular-keys.js [--apply]
require('dotenv').config({quiet:true});
const mongoose=require('mongoose');
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
module.exports={merge};
if(require.main===module)(async()=>{
 const apply=process.argv.includes('--apply');
 await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil',serverSelectionTimeoutMS:10000,autoIndex:false,autoCreate:false});
 const {ArchiveItem}=require('../src/models');
 let found=0,changed=0;
 for await(const row of ArchiveItem.collection.find({$or:[{musical:{$type:'object'}},{'items.sound':{$exists:true}},{recordingAmount:{$exists:true}}]},{projection:{musical:1,items:1,atomCount:1,recordingAmount:1}})){
  const set={};
  if(merge(row.musical))set.musical=row.musical;
  if(Array.isArray(row.items)&&row.items.map(item=>merge(item.sound)).includes(true))set.items=row.items;
  // recordingAmount is no longer stored: the atom count replaces it and is counted from the items.
  const unset={};if(Array.isArray(row.items)&&row.items.length!==row.atomCount)set.atomCount=row.items.length;if('recordingAmount' in row)unset.recordingAmount='';
  if(!Object.keys(set).length&&!Object.keys(unset).length)continue;
  found++;
  if(apply){await ArchiveItem.collection.updateOne({_id:row._id},{...(Object.keys(set).length?{$set:set}:{}),...(Object.keys(unset).length?{$unset:unset}:{})});changed++;}
 }
 console.log(JSON.stringify({apply,found,changed}));
 await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
