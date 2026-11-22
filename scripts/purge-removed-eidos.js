#!/usr/bin/env node
const mongoose=require('mongoose');
const {Eidos,ensureBooking}=require('../src/eden-eidos');
async function purgeRemovedEidos({apply=false}={}){
 if(apply)await ensureBooking();
 const collection=mongoose.connection.db.collection(Eidos.collection.name);
 const pending=await collection.countDocuments({hiddenFromMap:true});
 if(!apply)return {mode:'dry-run',previouslyRemoved:pending};
 const result=await collection.deleteMany({hiddenFromMap:true});
 await collection.updateMany({hiddenFromMap:{$exists:true}},{$unset:{hiddenFromMap:''}});
 const remaining=await collection.countDocuments({hiddenFromMap:true});
 if(remaining)throw Error('Removed Eidos cleanup is incomplete.');
 return {mode:'apply',permanentlyDeleted:result.deletedCount,remainingRemoved:remaining};
}
if(require.main===module){
 require('dotenv').config({quiet:true});
 (async()=>{
  if(!process.env.MONGODB_URI)throw Error('Configure MONGODB_URI before this cleanup.');
  await mongoose.connect(process.env.MONGODB_URI,{dbName:process.env.MONGODB_DB_NAME||'khalil',autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:10000});
  console.log(JSON.stringify(await purgeRemovedEidos({apply:process.argv.includes('--apply')})));
 })().catch(error=>{console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g,'[database connection]'));process.exitCode=1;}).finally(()=>mongoose.disconnect());
}
module.exports={purgeRemovedEidos};
