// Scan the database once per batch, rather than once per file. This also keeps
// a large collection from delaying cleanup by N full-database scans.
const mongoose=require('mongoose');
const {Asset}=require('./cloudinary-assets');
const HOLD_MS=10*60*1000,GRACE_MS=5*60*1000;
const excluded=new Set(['cloudinaryassets','musicaudioassets','equipment3djobs','securityratelimits']);
async function references(rows,{db=mongoose.connection.db,media=require('./vps-media').store()}={}){
 if(!db)throw Error('Database unavailable; cleanup stopped');
 const byId=new Map(),byPublicId=new Map(),found=new Set(),aliases=new Map();
 for(const row of rows){const m=media.metadata(row.publicId);if(!m)continue;byId.set(m.id,row.key);for(const id of [row.publicId,m.publicId]){if(!byPublicId.has(id))byPublicId.set(id,new Set());byPublicId.get(id).add(row.key);}}
 const markUrl=value=>{const m=media.metadata(value),key=m&&byId.get(m.id);if(key)found.add(key);return key;};
 for await(const receipt of db.collection('musicaudioassets').find({}).batchSize(100)){const m=media.metadata(receipt.url),key=m&&byId.get(m.id);if(key)aliases.set(receipt.externalId,key);}
 function walk(value,key=''){
  if(typeof value==='string'){
   if(/public.?id/i.test(key))for(const owner of byPublicId.get(value)||[])found.add(owner);
   if(/assetId$/i.test(key)&&aliases.has(value))found.add(aliases.get(value));
   if(value.includes('/khalil-media/')||value.includes('res.cloudinary.com/')){
    if(!markUrl(value))for(const match of value.matchAll(/https:\/\/[^\s"'<>]+/g))markUrl(match[0]);
   }
  }else if(Array.isArray(value))for(const child of value)walk(child,key);
  else if(value&&typeof value==='object'&&!value._bsontype&&!Buffer.isBuffer(value)&&!(value instanceof Date))for(const [name,child]of Object.entries(value))walk(child,name);
 }
 for(const {name,type}of await db.listCollections({},{nameOnly:true}).toArray()){
  if(type==='view'||name.startsWith('system.')||excluded.has(name))continue;
  const cursor=db.collection(name).find({}).batchSize(100);
  try{for await(const row of cursor)walk(row);}finally{await cursor.close();}
 }
 return found;
}
async function sweep({Model=Asset,media=require('./vps-media').store(),db=mongoose.connection.db,now=new Date(),limit=200,scan=references}={}){
 const candidates=await Model.find({cloud:'vps',state:{$ne:'deleted'},holdUntil:{$lte:now},$or:[{leaseUntil:{$lte:now}},{leaseUntil:null}]}).sort({deleteRequested:-1,checkedAt:1}).limit(limit).lean();
 if(!candidates.length)return {checked:0,deleted:0};
 const rows=[];let deleted=0;
 for(const row of candidates){const claim=await Model.findOneAndUpdate({_id:row._id,$or:[{leaseUntil:{$lte:now}},{leaseUntil:null}]},{$set:{leaseUntil:new Date(+now+HOLD_MS),checkedAt:now}},{returnDocument:'after'});if(claim)rows.push(row);}
 const locked=[];
 try{
  const owned=await scan(rows,{db,media});
  for(const row of rows){
   if(owned.has(row.key)){await Model.updateOne({_id:row._id},{$set:{state:'ready',missingSince:null,lastError:'',deleteRequested:false}});continue;}
   if(!row.deleteRequested&&!row.missingSince){await Model.updateOne({_id:row._id},{$set:{missingSince:now}});continue;}
   if(!row.deleteRequested&&+now-new Date(row.missingSince)<GRACE_MS)continue;
   if(await Model.findOneAndUpdate({_id:row._id,state:{$ne:'deleted'},holdUntil:{$lte:now}},{$set:{state:'deleting'}},{returnDocument:'after'}))locked.push(row);
  }
  if(locked.length){
   const rechecked=await scan(locked,{db,media});
   for(const row of locked){
    try{
     if(rechecked.has(row.key)){await Model.updateOne({_id:row._id},{$set:{state:'ready',missingSince:null,deleteRequested:false}});continue;}
     const result=await media.remove(row.publicId);if(!['ok','not found'].includes(result?.result))throw Error('Local deletion was not confirmed');
     await Model.updateOne({_id:row._id,state:'deleting'},{$set:{state:'deleted',deletedAt:now,lastError:''}});deleted++;
    }catch(error){await failure(row,error);}
   }
  }
 }catch(error){for(const row of rows)await failure(row,error);throw error;}
 finally{if(rows.length)await Model.updateMany({_id:{$in:rows.map(r=>r._id)}},{$set:{leaseUntil:null}});}
 return {checked:rows.length,deleted};
 async function failure(row,error){await Model.updateOne({_id:row._id,state:{$ne:'deleted'}},{$set:{state:'ready',lastError:String(error.message).slice(0,200)},$inc:{attempts:1}});}
}
module.exports={references,sweep};
