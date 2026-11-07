// Adds the requested MC service as editable catalogue data; never overwrites edits.
// Use the normal database environment, or set RENDER_SERVICE_ID to read its env
// with the locally configured RENDER_API_KEY. Credentials remain in memory.
require('dotenv').config({quiet:true});
const path=require('node:path');
const mongoose=require('mongoose');
async function environment(){
 if(!process.env.MONGODB_URI&&process.env.RENDER_SERVICE_ID){
  if(!process.env.RENDER_API_KEY)throw new Error('RENDER_API_KEY is required.');
  let cursor='';
  do{
   const url=new URL(`https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars`);url.searchParams.set('limit','100');if(cursor)url.searchParams.set('cursor',cursor);
   const response=await fetch(url,{headers:{Authorization:`Bearer ${process.env.RENDER_API_KEY}`},signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw new Error(`Could not read service environment (${response.status}).`);
   const rows=await response.json();
   for(const {envVar} of rows)if(envVar?.key&&!process.env[envVar.key])process.env[envVar.key]=envVar.value;
   cursor=rows.length===100?rows.at(-1).cursor:'';
  }while(cursor);
 }
 if(!process.env.MONGODB_URI)throw new Error('MONGODB_URI is required.');
}
async function main(){
 await environment();
 await mongoose.connect(process.env.MONGODB_URI,{dbName:process.env.MONGODB_DB_NAME||'khalil',autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:15000});
 await mongoose.connection.collection('setupcatalogentries').updateOne({key:'service:mc'},{$pull:{'value.equipmentIds':'mc-host'},$set:{updatedAt:new Date()}});
 const {Equipment}=require('../src/equipment');
 const result=await Equipment.deleteOne({slug:'mc-host'});
 console.log('Removed MC Host equipment card:',result.deletedCount,'; MC hosting service, microphone and lectern preserved.');
}
main().catch(error=>{console.error('MC host card removal failed:',error.name,error.code||'configuration or database error');process.exitCode=1;}).finally(()=>mongoose.disconnect());
