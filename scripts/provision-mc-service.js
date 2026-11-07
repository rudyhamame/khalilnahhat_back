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
 const entries=mongoose.connection.collection('setupcatalogentries');
 const existing=await entries.findOne({key:'service:mc'});
 if(existing){console.log('MC service already exists; preserved existing settings.');return;}
 const cloudinary=require('cloudinary').v2;
 cloudinary.config(Object.fromEntries([['cloud_name',process.env.CLOUDINARY_CLOUD_NAME],['api_key',process.env.CLOUDINARY_API_KEY],['api_secret',process.env.CLOUDINARY_API_SECRET]].filter(([,value])=>value)));
 const {uploadAsset}=require('../src/cloudinary-assets');
 const folder=path.resolve(__dirname,'../../khalil-front/public/echo/mc-hosting');
 const artwork=await uploadAsset(path.join(folder,'mc-hosting-artwork-v1.webp'),{resource_type:'image'});
 const model=await uploadAsset(path.join(folder,'mc-hosting-scene-v1.glb'),{resource_type:'raw',public_id:'mc-hosting-scene-v1.glb'});
 const {Equipment}=require('../src/equipment');
 await Equipment.updateOne({slug:'mc-hosting-scene'},{$setOnInsert:{slug:'mc-hosting-scene',name:'Microphone & lectern setup',category:'mc',description:'A microphone and lectern presentation setup for hosting, introductions and announcements.',functionSummary:'A clear focal point for your event host and announcements.',imageUrl:artwork.secure_url,modelUrl:model.secure_url,modelSeeded:true,priceCents:0,minQuantity:1,quantityOwned:1,stockTracked:false,isActive:true,sortOrder:0}},{upsert:true});
 const {ServicePrice}=require('../src/models');
 await ServicePrice.updateOne({serviceId:'service-mc'},{$setOnInsert:{serviceId:'service-mc',name:'MC hosting & announcements',category:'Service',amountCents:0,currency:'CAD',unit:'event',isActive:true}},{upsert:true});
 const {MediaItem}=require('../src/content');
 await MediaItem.updateOne({mediaUrl:artwork.secure_url},{$setOnInsert:{kind:'photo',category:'service-artwork',title:'MC hosting & announcements — service artwork',titleAr:'تقديم الحفل والإعلانات — صورة الخدمة',mediaUrl:artwork.secure_url,isPublished:false,downloadable:false,sortOrder:0}},{upsert:true});
 const value={id:'mc',kind:'service',name:'MC hosting & announcements',nameAr:'تقديم الحفل والإعلانات',description:'Event hosting, guest introductions and announcements, coordinated with your event program.',descriptionAr:'تقديم الحفل والتعريف بالضيوف والإعلانات بالتنسيق مع برنامج فعاليتك.',imageUrl:artwork.secure_url,galleryImages:[],category:'mc',bookingType:'other',equipmentIds:['mc-hosting-scene'],priceId:'service-mc',icon:'microphone',selectionField:'music.mcRequested',isActive:true,sortOrder:0};
 const now=new Date();
 await entries.updateOne({key:'service:mc'},{$setOnInsert:{key:'service:mc',value,createdAt:now,updatedAt:now}},{upsert:true});
 console.log('MC service, editable artwork, linked 3D scene and unset quote pricing saved.');
}
main().catch(error=>{console.error('MC provisioning failed:',error.name,error.code||'configuration, storage or database error');process.exitCode=1;}).finally(()=>mongoose.disconnect());
