// Content-addressed uploads and conservative, retryable garbage collection.
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const mongoose=require('mongoose');
const cloudinary=require('cloudinary').v2;
const Asset=mongoose.models.CloudinaryAsset||mongoose.model('CloudinaryAsset',new mongoose.Schema({
 key:{type:String,unique:true,required:true},sha256:String,cloud:String,publicId:String,resourceType:String,delivery:String,
 result:mongoose.Schema.Types.Mixed,state:{type:String,default:'ready'},holdUntil:Date,missingSince:Date,
 checkedAt:Date,leaseUntil:Date,deletedAt:Date,attempts:{type:Number,default:0},lastError:String,deleteRequested:{type:Boolean,default:false},
},{timestamps:true}));
const HOLD_MS=10*60*1000,GRACE_MS=5*60*1000;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const identityOptions=(hash,options)=>{
 const {public_id,folder,use_filename,unique_filename,overwrite,...given}=options;
 const rest={resource_type:'image',type:'upload',...given};
 // Keep access policies and processing profiles separate, even for identical bytes.
 const profile=createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex').slice(0,16);
 const suffix=options.resource_type==='raw'?(/\.[a-z0-9]{1,12}$/i.exec(public_id||'')?.[0]||''):'';
 return {...rest,public_id:`khalil/assets/${profile}/${hash}${suffix}`,overwrite:false,unique_filename:false};
};
async function digest(input){
 const hash=createHash('sha256');
 if(Buffer.isBuffer(input))return hash.update(input).digest('hex');
 for await(const chunk of fs.createReadStream(input))hash.update(chunk);
 return hash.digest('hex');
}
function createAssetStore({client=cloudinary,Model=Asset,now=()=>new Date()}={}){
 const inFlight=new Map();
 async function upload(input,options={}){
  const sha256=await digest(input),opts=identityOptions(sha256,options),cloud=client.config?.().cloud_name||process.env.CLOUDINARY_CLOUD_NAME;
  const key=[cloud,opts.resource_type||'image',opts.type||'upload',opts.public_id].join(':');
  if(inFlight.has(key))return inFlight.get(key);
  const work=(async()=>{
   // The hold protects a reused asset while its new DB reference is being saved.
   let row;
   try{row=await Model.findOneAndUpdate({key,state:{$ne:'deleting'}},{$set:{holdUntil:new Date(+now()+HOLD_MS),missingSince:null},$setOnInsert:{sha256,cloud,publicId:opts.public_id,resourceType:opts.resource_type||'image',delivery:opts.type||'upload',state:'ready'}},{upsert:true,returnDocument:'after'});}
   catch(error){
    if(error.code!==11000)throw error;
    row=await Model.findOneAndUpdate({key,state:'ready'},{$set:{holdUntil:new Date(+now()+HOLD_MS),missingSince:null}},{returnDocument:'after'});
    if(!row)throw Object.assign(new Error('This file is being cleaned up. Retry the upload.'),{status:409});
   }
   if(row?.result?.secure_url)return row.result;
   const result=await new Promise((resolve,reject)=>{
    const done=(error,result)=>error?reject(error):resolve(result);
    if(Buffer.isBuffer(input))client.uploader.upload_stream(opts,done).end(input);
    else client.uploader.upload(input,opts).then(resolve,reject);
   });
   if(!result?.secure_url||!result.public_id)throw Error('Storage did not confirm the uploaded asset.');
   await Model.updateOne({key,state:'ready'},{$set:{result,publicId:result.public_id,resourceType:result.resource_type||opts.resource_type||'image',lastError:''}});
   return result;
  })();
  inFlight.set(key,work);
  try{return await work;}finally{inFlight.delete(key);}
 }
 return {upload};
}
const store=createAssetStore();
function referenced(value,asset,key=''){
 if(typeof value==='string'){
  if(asset.cloud==='vps'){
   if(/assetId$/i.test(key)&&asset.aliases?.includes(value))return true;
   const media=require('./vps-media').store(),target=media.metadata(asset.publicId),m=media.metadata(value);
   if(Boolean(target&&m?.id===target.id)||(/public.?id/i.test(key)&&(value===asset.publicId||value===target?.publicId)))return true;
   // Rich text (for example an email template) can own an embedded media URL too.
   if(target&&(value.includes('/khalil-media/')||value.includes('res.cloudinary.com/'))){for(const match of value.matchAll(/https:\/\/[^\s"'<>]+/g))if(media.metadata(match[0])?.id===target.id)return true;}
   return false;
  }
  if(/public.?id/i.test(key)&&value===asset.publicId)return true;
  if(/assetId$/i.test(key)&&asset.aliases?.includes(value))return true;
  try{
   const url=new URL(value);
   if(url.hostname!=='res.cloudinary.com')return false;
   const path=decodeURIComponent(url.pathname),prefix=`/${asset.cloud}/${asset.resourceType}/${asset.delivery}/`;
   if(!path.startsWith(prefix))return false;
   const tail=path.slice(prefix.length),at=tail.lastIndexOf(asset.publicId);
   if(at<0||(at>0&&tail[at-1]!=='/'))return false;
   const suffix=tail.slice(at+asset.publicId.length);
   return suffix===''||(asset.resourceType!=='raw'&&/^\.[a-z0-9]+$/i.test(suffix));
  }catch{return false;}
 }
 if(Array.isArray(value))return value.some(item=>referenced(item,asset,key));
 return !!value&&typeof value==='object'&&Object.entries(value).some(([name,item])=>referenced(item,asset,name));
}
async function hasReferences(asset,{db=mongoose.connection.db}={}){
 if(!db)throw Error('Database unavailable; cleanup stopped.');
 const aliases=[];
 for await(const row of db.collection('musicaudioassets').find({}).batchSize(100)){if(referenced(row.url,asset))aliases.push(row.externalId);}
 asset={...asset,aliases};
 const collections=await db.listCollections({},{nameOnly:true}).toArray();
 for(const {name,type} of collections){
  // These are upload receipts, not owners. Actual recording/version rows own audio.
  if(type==='view'||name.startsWith('system.')||['cloudinaryassets','musicaudioassets','equipment3djobs','securityratelimits'].includes(name))continue;
  const cursor=db.collection(name).find({}).batchSize(100);
  try{for await(const row of cursor){if(referenced(row,asset))return true;}}finally{await cursor.close();}
 }
 return false;
}
async function sweep({Model=Asset,client=cloudinary,check=hasReferences,now=new Date(),limit=20,keys}={}){
 const rows=await Model.find({...(require('./vps-media').enabled()?{cloud:'vps'}:{}),...(keys?{key:{$in:keys}}:{}),state:{$ne:'deleted'},holdUntil:{$lte:now},$or:[{leaseUntil:{$lte:now}},{leaseUntil:null}]}).sort({deleteRequested:-1,checkedAt:1}).limit(limit).lean();
 for(const row of rows){
  const claim=await Model.findOneAndUpdate({_id:row._id,$or:[{leaseUntil:{$lte:now}},{leaseUntil:null}]},{$set:{leaseUntil:new Date(+now+10*60*1000),checkedAt:now}},{returnDocument:'after'});
  if(!claim)continue;
  try{
   if(await check(row)){await Model.updateOne({_id:row._id},{$set:{state:'ready',missingSince:null,lastError:'',deleteRequested:false}});continue;}
   if(!row.deleteRequested&&!row.missingSince){await Model.updateOne({_id:row._id},{$set:{missingSince:now}});continue;}
   if(!row.deleteRequested&&+now-new Date(row.missingSince)<GRACE_MS)continue;
   const locked=await Model.findOneAndUpdate({_id:row._id,state:{$ne:'deleted'},holdUntil:{$lte:now}},{$set:{state:'deleting'}},{returnDocument:'after'});
   if(!locked)continue;
   // Recheck after locking; uploads cannot reuse an asset marked deleting.
   if(await check(row)){await Model.updateOne({_id:row._id},{$set:{state:'ready',missingSince:null}});continue;}
   if(row.cloud!=='vps'&&row.cloud!==client.config?.().cloud_name)throw Error('Cloudinary environment mismatch');
   const result=row.cloud==='vps'?await require('./vps-media').store().remove(row.publicId):await client.uploader.destroy(row.publicId,{resource_type:row.resourceType,type:row.delivery,invalidate:true});
   if(!['ok','not found'].includes(result?.result))throw Error('Storage deletion not confirmed');
   if(row.cloud==='vps')await Model.updateOne({_id:row._id,state:'deleting'},{$set:{state:'deleted',deletedAt:now,lastError:''}});
   else await Model.deleteOne({_id:row._id,state:'deleting'});
  }catch(error){await Model.updateOne({_id:row._id},{$set:{state:'ready',lastError:String(error.message).slice(0,200)},$inc:{attempts:1}});}
  finally{await Model.updateOne({_id:row._id},{$set:{leaseUntil:null}});}
 }
}
// Adopt existing application uploads while they are still referenced. Static
// site-assets and unrelated Cloudinary folders are deliberately outside this scope.
const managedPrefix=/^(?:Gallery\/|Live\/|khalil\/(?:assets|content|music-archive|equipment|equipment-models|live-sessions|live-posters|song-covers|private)\/)/;
function ownedIdentity(value,cloud){
 if(require('./vps-media').enabled()&&typeof value==='string'){const m=require('./vps-media').store().metadata(value);if(m&&!m.pinned)return {cloud:'vps',resourceType:m.resourceType,delivery:m.delivery,publicId:`vps/${m.id}.${m.ext}`};}
 try{
  const url=new URL(value);if(url.hostname!=='res.cloudinary.com')return null;
  const match=decodeURIComponent(url.pathname).match(/^\/([^/]+)\/(image|video|raw)\/(upload|authenticated)\/(.+)$/);
  if(!match||match[1]!==cloud)return null;
  const [, ,resourceType,delivery,tail]=match;
  const pieces=tail.split('/');let publicId;
  for(let i=0;i<pieces.length;i++){const candidate=pieces.slice(i).join('/');if(managedPrefix.test(candidate)){publicId=candidate;break;}}
  if(!publicId)return null;
  if(resourceType!=='raw')publicId=publicId.replace(/\.[a-z0-9]+$/i,'');
  return {cloud,resourceType,delivery,publicId};
 }catch{return null;}
}
function collectIdentities(value,cloud,out=new Map()){
 if(typeof value==='string'){const item=ownedIdentity(value,cloud);if(item)out.set([item.cloud,item.resourceType,item.delivery,item.publicId].join(':'),item);}
 else if(Array.isArray(value))value.forEach(item=>collectIdentities(item,cloud,out));
 else if(value&&typeof value==='object')Object.values(value).forEach(item=>collectIdentities(item,cloud,out));
 return out;
}
async function discoverReferenced({db=mongoose.connection.db,Model=Asset,cloud=cloudinary.config().cloud_name,dryRun=false}={}){
 if(!db||!cloud)throw Error('Database and Cloudinary configuration required');
 let found=0;
 for(const {name,type} of await db.listCollections({},{nameOnly:true}).toArray()){
  if(type==='view'||name.startsWith('system.')||['cloudinaryassets','musicaudioassets','equipment3djobs','securityratelimits'].includes(name))continue;
  const cursor=db.collection(name).find({}).batchSize(100);
  try{for await(const row of cursor){
   const identities=collectIdentities(row,cloud);
   // Private file records and live recording manifests store public IDs directly.
   const addPart=part=>{if(part?.publicId&&managedPrefix.test(part.publicId)){const item={cloud,publicId:part.publicId,resourceType:part.resourceType||'video',delivery:part.delivery||'authenticated'};identities.set([cloud,item.resourceType,item.delivery,item.publicId].join(':'),item);}};
   if(name==='storedfiles')addPart({...row,resourceType:row.resourceType||'raw'});
   if(name==='liverecordings'){addPart(row);for(const part of row.parts||[])addPart(part);for(const part of row.legacyParts||[])addPart(part);for(const source of row.sources||[])for(const part of source.parts||[])addPart(part);}
   for(const [key,item] of identities){found++;if(!dryRun)await Model.updateOne({key},{$setOnInsert:{...item,key,state:'ready',holdUntil:new Date(Date.now()+HOLD_MS)}},{upsert:true});}
  }}finally{await cursor.close();}
 }
 return {referencesFound:found,dryRun};
}
async function uploadVpsAsset(input,options){
 const result=await require('./vps-media').store().upload(input,options);
 const publicId=result.public_id,key=['vps',result.resource_type,result.type,publicId].join(':');
 try{
  const row=await Asset.findOneAndUpdate({key,state:{$ne:'deleting'}},{$set:{state:'ready',result,holdUntil:new Date(Date.now()+HOLD_MS),missingSince:null,deleteRequested:false,deletedAt:null},$setOnInsert:{cloud:'vps',publicId,resourceType:result.resource_type,delivery:result.type}},{upsert:true,returnDocument:'after'});
  if(!row)throw Error('Missing media registry receipt');
 }catch(e){if(e.code===11000)throw Object.assign(Error('This file is being cleaned up. Retry the upload.'),{status:409});throw e;}
 return result;
}
async function adoptVpsAssets({Model=Asset,media=require('./vps-media').store(),now=new Date()}={}){
 let adopted=0;
 for(const item of Object.values(media.load().assets)){
  if(item.pinned)continue;
  const publicId=`vps/${item.id}.${item.ext}`,key=['vps',item.resourceType,item.delivery,publicId].join(':');
  await Model.updateOne({key},{$setOnInsert:{key,cloud:'vps',publicId,resourceType:item.resourceType,delivery:item.delivery,state:'ready',holdUntil:new Date(+now+HOLD_MS)}},{upsert:true});adopted++;
 }
 return {adopted};
}
function startCleanup(){
 // Cloudinary originals stay intact during the migration; only local receipts are collected.
 if(require('./vps-media').enabled()){
  let running=false,lastAdoption=0;
  const run=async()=>{if(running||mongoose.connection.readyState!==1)return;running=true;try{
   if(Date.now()-lastAdoption>10*60*1000){await adoptVpsAssets();lastAdoption=Date.now();}
   await require('./vps-media-lifecycle').sweep();
  }catch(error){console.warn('Local media cleanup deferred:',error.name);}finally{running=false;}};
  const timer=setInterval(run,30000);timer.unref();run();return()=>clearInterval(timer);
 }
 let running=false,lastDiscovery=0;
 const run=async()=>{if(running||mongoose.connection.readyState!==1)return;running=true;try{
  if(Date.now()-lastDiscovery>10*60*1000){await discoverReferenced();lastDiscovery=Date.now();}
  await sweep();
 }catch(error){console.warn('Asset cleanup deferred:',error.name);}finally{running=false;}};
 const timer=setInterval(run,60000);timer.unref();run();return()=>clearInterval(timer);
}
module.exports={Asset,uploadAsset:(input,options)=>require('./vps-media').enabled()?uploadVpsAsset(input,options):store.upload(input,options),createAssetStore,adoptVpsAssets,uploadVpsAsset,identityOptions,referenced,hasReferences,sweep,startCleanup,ownedIdentity,collectIdentities,discoverReferenced};
