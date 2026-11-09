const mongoose=require('mongoose');
const cloudinary=require('cloudinary').v2;
const {Asset,collectIdentities,sweep}=require('./cloudinary-assets');

const managed=/^(?:Gallery\/|Live\/|khalil\/(?:assets|content|music-archive|equipment|equipment-models|live-sessions|live-posters|song-covers|private)\/)/;
function deletionIdentities(value,cloud,resourceType='video'){
 const plain=value?.toObject?value.toObject():value;
 const identities=collectIdentities(plain,cloud);
 const visit=(item,fallback)=>{
  if(!item||typeof item!=='object')return;
  if(Array.isArray(item)){item.forEach(child=>visit(child,fallback));return;}
  if(typeof item.publicId==='string'&&managed.test(item.publicId)){
   const asset={cloud,publicId:item.publicId,resourceType:item.resourceType||fallback,delivery:item.delivery||'authenticated'};
   identities.set([cloud,asset.resourceType,asset.delivery,asset.publicId].join(':'),asset);
  }
  for(const child of Object.values(item))if(child&&typeof child==='object')visit(child,fallback);
 };
 visit(plain,resourceType);
 return identities;
}
function createPermanentDeletion({Model=Asset,client=cloudinary,db=()=>mongoose.connection.db,runSweep=sweep}={}){
 // Persist the cleanup intent BEFORE removing owners, in the same DB transaction
 // where supplied. A Cloudinary outage cannot lose the identities to be removed.
 async function prepare(value,{session,resourceType='video'}={}){
  const plain=value?.toObject?value.toObject():value;
  const cloud=client.config().cloud_name||process.env.CLOUDINARY_CLOUD_NAME;
  const identities=deletionIdentities(plain,cloud,resourceType);
  // Music records can own audio through an asset receipt rather than a URL.
  const aliases=new Set();
  const scan=item=>{if(!item||typeof item!=='object')return;for(const [key,child]of Object.entries(item)){if(/audioAssetId$/i.test(key)&&typeof child==='string')aliases.add(child);else if(child&&typeof child==='object')scan(child);}};
  scan(plain);
  if(aliases.size){
   const rows=await db().collection('musicaudioassets').find({externalId:{$in:[...aliases]}},{session}).toArray();
   for(const row of rows)for(const [key,asset]of deletionIdentities(row,cloud))identities.set(key,asset);
  }
  const keys=[];
  for(const [key,asset]of identities){
   if(!cloud)throw Object.assign(new Error('Cloudinary must be configured before deleting uploaded files.'),{status:503});
   await Model.updateOne({key},{$set:{deleteRequested:true},$setOnInsert:{...asset,key,state:'ready',holdUntil:new Date(0)}},{upsert:true,session});
   keys.push(key);
  }
  return keys;
 }
 async function finish(keys){
  if(!keys.length)return {pending:false};
  try{
   await Model.updateMany({key:{$in:keys}},{$set:{deleteRequested:true}});
   await runSweep({Model,client,keys,limit:keys.length});
   return {pending:Boolean(await Model.exists({key:{$in:keys},deleteRequested:true}))};
  }catch{return {pending:true};} // The durable intent is retried by the worker.
 }
 async function remove(Model,filter){
  const item=await Model.findOne(filter);
  if(!item)return null;
  const keys=await prepare(item);
  const removed=await Model.findOneAndDelete({...filter,_id:item._id});
  if(removed)removed.cloudinaryCleanupPending=(await finish(keys)).pending;
  return removed;
 }
 return {prepare,finish,remove};
}
module.exports={...createPermanentDeletion(),createPermanentDeletion,deletionIdentities};
