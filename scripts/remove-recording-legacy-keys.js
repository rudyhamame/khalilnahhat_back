#!/usr/bin/env node
// Removes the retired recordingMetadata and credits keys from stored recordings (they are derived from items, musical and recordingCredits).
// Dry run by default: node scripts/remove-recording-legacy-keys.js [--apply]
require('dotenv').config({quiet:true});
const mongoose=require('mongoose');
(async()=>{
 const apply=process.argv.includes('--apply');
 await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017',{dbName:process.env.MONGODB_DB_NAME||'khalil',serverSelectionTimeoutMS:10000,autoIndex:false,autoCreate:false});
 const {ArchiveItem}=require('../src/models');
 const filter={$or:[{recordingMetadata:{$exists:true}},{credits:{$exists:true}}]};
 const found=await ArchiveItem.collection.countDocuments(filter);
 const changed=apply?(await ArchiveItem.collection.updateMany(filter,{$unset:{recordingMetadata:'',credits:''}})).modifiedCount:0;
 console.log(JSON.stringify({apply,found,changed}));
 await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
