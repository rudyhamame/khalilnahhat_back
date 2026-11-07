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
 const cloudinary=require('cloudinary').v2;
 cloudinary.config(Object.fromEntries([['cloud_name',process.env.CLOUDINARY_CLOUD_NAME],['api_key',process.env.CLOUDINARY_API_KEY],['api_secret',process.env.CLOUDINARY_API_SECRET]].filter(([,value])=>value)));
 const {uploadAsset}=require('../src/cloudinary-assets');
 const folder=path.resolve(__dirname,'../../khalil-front/public/echo/mc-hosting');
 const artwork=await uploadAsset(path.join(folder,'lectern-artwork-v1.webp'),{resource_type:'image'});
 const model=await uploadAsset(path.join(folder,'lectern-v1.glb'),{resource_type:'raw',public_id:'lectern-v1.glb'});
 const {Equipment}=require('../src/equipment');
 await Equipment.updateOne({slug:'lectern'},{$setOnInsert:{slug:'lectern',name:'Lectern',category:'mc',description:'A freestanding presentation lectern for speeches, event hosting and announcements.',functionSummary:'Supports speaker notes and gives presenters a dedicated position during your event.',imageUrl:artwork.secure_url,modelUrl:model.secure_url,modelSeeded:true,priceCents:0,minQuantity:1,quantityOwned:1,stockTracked:false,isActive:true,sortOrder:1}},{upsert:true});
 await mongoose.connection.collection('setupcatalogentries').updateOne({key:'service:mc'},{$addToSet:{'value.equipmentIds':'lectern'},$set:{updatedAt:new Date()}});
 const {MediaItem}=require('../src/content');
 await MediaItem.updateOne({mediaUrl:artwork.secure_url},{$setOnInsert:{kind:'photo',category:'equipment-artwork',title:'Lectern — equipment artwork',mediaUrl:artwork.secure_url,isPublished:false,downloadable:false,sortOrder:0}},{upsert:true});
 console.log('Lectern added to Equipment and linked to MC; pricing and stock remain on request.');
}
main().catch(error=>{console.error('Lectern provisioning failed:',error.name,error.code||'configuration, storage or database error');process.exitCode=1;}).finally(()=>mongoose.disconnect());
