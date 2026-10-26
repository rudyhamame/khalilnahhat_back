const mongoose=require('mongoose');
const cloudinary=require('cloudinary').v2;
const {Client}=require('minio');
const {RoomServiceClient,EgressClient}=require('livekit-server-sdk');
const {RoomEgress,AutoParticipantEgress,EncodedFileOutput,S3Upload,EncodedFileType,EncodingOptionsPreset}=require('@livekit/protocol');
const {ArchiveItem}=require('./models');
const {MediaItem}=require('./content');
const http=require('http');
const fs=require('fs/promises');
const {createWriteStream}=require('fs');
const {pipeline}=require('stream/promises');
const path=require('path');
const {prepareRecordingFiles,cloudAssetId,DEFAULT_LIMIT}=require('./recording-files');

const schema=new mongoose.Schema({
 roomName:{type:String,unique:true,required:true},title:String,status:{type:String,default:'waiting'},egressId:String,objectKey:String,
 parts:[{_id:false,publicId:String,delivery:String,bytes:Number,duration:Number}],
 publicId:String,delivery:{type:String,default:'authenticated'},bytes:{type:Number,default:0},duration:{type:Number,default:0},
 attempts:{type:Number,default:0},nextRetryAt:{type:Date,default:()=>new Date()},leaseUntil:{type:Date,default:()=>new Date(0)},
 deletedAt:{type:Date,default:null},
 error:{type:String,default:''},published:{type:Boolean,default:false},test:{type:Boolean,default:false},
},{timestamps:true});
const LiveRecording=mongoose.models.LiveRecording||mongoose.model('LiveRecording',schema);
const BUCKET='echo-live-archive';
function configured(){return Boolean(process.env.ECHO_RECORDING_ACCESS_KEY&&process.env.ECHO_RECORDING_SECRET&&process.env.ECHO_RECORDING_PUBLIC_ENDPOINT&&process.env.CLOUDINARY_API_SECRET);}
function store(){return new Client({endPoint:process.env.ECHO_RECORDING_HOST||'echo-recording-store',port:9000,useSSL:false,accessKey:process.env.ECHO_RECORDING_ACCESS_KEY,secretKey:process.env.ECHO_RECORDING_SECRET,region:'us-east-1'});}
function sdk(Class){return new Class(process.env.LIVEKIT_URL,process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);}
function recordingParts(row){return row.parts?.length?Array.from(row.parts):row.publicId?[{publicId:row.publicId,delivery:row.delivery||'authenticated',bytes:row.bytes,duration:row.duration}]:[];}
function view(row){const parts=recordingParts(row);return {id:String(row._id),title:row.title,status:row.status,bytes:row.bytes,durationSec:row.duration,published:row.published,createdAt:row.createdAt,error:row.error||'',canPreview:row.status==='ready'&&parts.length>0,partCount:parts.length,parts:parts.map((part,index)=>({index,bytes:part.bytes,durationSec:part.duration}))};}
function recordingLink(row,partIndex,attachment){
 const parts=recordingParts(row);const index=partIndex===undefined?0:Number(partIndex);
 if(!Number.isInteger(index)||index<0||index>=parts.length)return null;
 const part=parts[index];
 return cloudinary.utils.private_download_url(part.publicId,'mp4',{resource_type:'video',type:part.delivery||'authenticated',expires_at:Math.floor(Date.now()/1000)+180,attachment});
}
async function uploadRecordingPart(filename,publicId){
 try {const existing=await cloudinary.api.resource(publicId,{resource_type:'video',type:'authenticated'});if(existing.bytes>0)return existing;}
 catch(error){if((error.http_code||error.error?.http_code)!==404)throw error;}
 return new Promise((resolve,reject)=>{const stream=cloudinary.uploader.upload_large(filename,{resource_type:'video',type:'authenticated',public_id:publicId,overwrite:false,chunk_size:20*1024*1024,timeout:600000},(error,result)=>error?reject(error):resolve(result));stream.on('error',reject);});
}
function objectBelongsToRoom(key,roomName){return typeof key==='string'&&key.startsWith(roomName+'/')&&!key.includes('..')&&key.endsWith('.mp4');}
async function prepareRecordingRoom(roomName,title,test=false){
 if(!configured())throw Object.assign(new Error('Automatic recording storage is not configured.'),{status:503});
 const client=store();
 if(!await client.bucketExists(BUCKET))await client.makeBucket(BUCKET,'us-east-1');
 // Bound retained staging data; the bucket also enforces a hard quota.
 let used=0;for await(const obj of client.listObjectsV2(BUCKET,'',true)){used+=obj.size||0;}
 if(used>1024*1024*1024)throw Object.assign(new Error('Recording staging storage needs attention before another live.'),{status:503});
 const file=new EncodedFileOutput({fileType:EncodedFileType.MP4,filepath:`${roomName}/{publisher_identity}-{time}.mp4`,disableManifest:true,
  output:{case:'s3',value:new S3Upload({accessKey:process.env.ECHO_RECORDING_ACCESS_KEY,secret:process.env.ECHO_RECORDING_SECRET,endpoint:process.env.ECHO_RECORDING_PUBLIC_ENDPOINT,bucket:BUCKET,region:'us-east-1',forcePathStyle:true})}});
 const recording=await LiveRecording.create({roomName,title:title||'DJ Khalil — Live',test});
 try {
  await sdk(RoomServiceClient).createRoom({name:roomName,emptyTimeout:180,departureTimeout:15,
   egress:new RoomEgress({participant:new AutoParticipantEgress({options:{case:'preset',value:EncodingOptionsPreset.H264_720P_30},fileOutputs:[file]})})});
 }catch(error){await LiveRecording.updateOne({_id:recording._id},{$set:{status:'failed',error:'LiveKit could not enable recording.'}});throw Object.assign(new Error('LiveKit could not enable automatic recording.'),{status:503});}
 return recording;
}
function registerRecordingProxy(app){
 app.use('/echo-live-archive',(req,res)=>{
  if(!configured())return res.status(503).end();
  // Preserve the complete S3 path and Host header so the staging store verifies SigV4 itself.
  const headers={...req.headers};delete headers.connection;
  // Cloudflare normalizes Accept-Encoding. AWS Go signs its original identity value.
  // Restoring that value leaves Garage responsible for validating the complete signature.
  if(headers.authorization?.match(/SignedHeaders=([^,]+)/)?.[1].split(';').includes('accept-encoding'))headers['accept-encoding']='identity';
  const upstream=http.request({hostname:process.env.ECHO_RECORDING_HOST||'echo-recording-store',port:9000,path:req.originalUrl,method:req.method,headers},response=>{
   res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });
  upstream.setTimeout(180_000,()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.headersSent)res.status(502).end();else res.destroy();});
  req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
 });
}
async function transferRecording(row){
 const claimed=await LiveRecording.findOneAndUpdate({_id:row._id,deletedAt:null,status:{$in:['waiting','recording','upload_failed','processing']},leaseUntil:{$lt:new Date()}},{$set:{status:'processing',leaseUntil:new Date(Date.now()+15*60*1000)},$inc:{attempts:1}},{new:true});
 if(!claimed)return;
 let directory;
 try {
  if(!objectBelongsToRoom(claimed.objectKey,claimed.roomName))throw new Error('Invalid recording object.');
  directory=await fs.mkdtemp('/var/tmp/echo-recording-');await fs.chmod(directory,0o700);
  const filename=path.join(directory,'recording.mp4');
  await pipeline(await store().getObject(BUCKET,claimed.objectKey),createWriteStream(filename,{mode:0o600}));
  const files=await prepareRecordingFiles(filename,directory,DEFAULT_LIMIT);
  const parts=[];
  for(let index=0;index<files.length;index++){
   const file=files[index];const publicId=cloudAssetId(claimed.roomName,index,files.length);
   const output=await uploadRecordingPart(file.filename,publicId);
   if(output.public_id!==publicId||!output.bytes)throw new Error('Cloudinary did not confirm the recording part.');
   parts.push({publicId:output.public_id,delivery:'authenticated',bytes:output.bytes,duration:output.duration||file.duration});
  }
  await LiveRecording.updateOne({_id:claimed._id},{$set:{status:'ready',parts,publicId:parts[0].publicId,delivery:'authenticated',bytes:parts.reduce((n,p)=>n+p.bytes,0),duration:claimed.duration||parts.reduce((n,p)=>n+p.duration,0),error:'',leaseUntil:new Date(0)}});
  // A cleanup failure must never downgrade a confirmed Cloudinary recording.
  try {await store().removeObject(BUCKET,claimed.objectKey);await LiveRecording.updateOne({_id:claimed._id},{$set:{objectKey:''}});}catch {console.error('Live Archive staging cleanup pending');}
 }catch(error){
  await LiveRecording.updateOne({_id:claimed._id},{$set:{status:'upload_failed',error:'Cloudinary transfer did not finish. The staging recording is retained; retry from Live Archive.',leaseUntil:new Date(0),nextRetryAt:new Date(Date.now()+Math.min(claimed.attempts*300,1800)*1000)}});
  console.error('Live Archive transfer failed:',error.http_code||error.code||error.name);
 }finally{if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}
let sweeping=false;
async function sweepRecordings(){
 if(sweeping||!configured())return;sweeping=true;
 try {
  const rows=await LiveRecording.find({deletedAt:null,$or:[{status:{$in:['waiting','recording']}},{status:'upload_failed',attempts:{$lt:3},nextRetryAt:{$lte:new Date()}},{status:'processing',leaseUntil:{$lt:new Date()}}]}).sort({createdAt:1}).limit(10);
  for(const row of rows){
   try {
    if(row.objectKey){await transferRecording(row);continue;}
    const jobs=await sdk(EgressClient).listEgress({roomName:row.roomName});
    const completedFile=job=>job.fileResults?.[0] || (job.result?.case==='file'?job.result.value:null);
    const complete=jobs.find(job=>[3,6].includes(job.status)&&completedFile(job));
    if(complete){
     const file=completedFile(complete);const key=file.filename;
     if(!objectBelongsToRoom(key,row.roomName))throw new Error('Unexpected recording object.');
     await LiveRecording.updateOne({_id:row._id},{$set:{objectKey:key,egressId:complete.egressId,status:'recording',duration:Number(file.duration||0)/1e9}});
     row.objectKey=key;await transferRecording(row);
    }else if(jobs.some(job=>[0,1,2].includes(job.status))){await LiveRecording.updateOne({_id:row._id},{$set:{status:'recording'}});}
    else if(jobs.some(job=>[4,5].includes(job.status))||Date.now()-row.createdAt.getTime()>5*60*1000){
     const active=await sdk(RoomServiceClient).listRooms([row.roomName]);
     if(active.length)continue;
     await LiveRecording.updateOne({_id:row._id},{$set:{status:jobs.length?'failed':'not_recorded',error:jobs.length?'LiveKit did not finish a recording. No completed file is available.':'This connection ended without a recording file. There is no saved media to recover.'}});
    }
   }catch(error){console.error('Live Archive check failed:',error.code||error.name);}
  }
 }finally{sweeping=false;}
}
function registerLiveRecordings(app,requireAdmin){
 app.get('/api/admin/live-recordings',requireAdmin,async(_req,res)=>res.json({items:(await LiveRecording.find({test:{$ne:true},deletedAt:null}).sort({createdAt:-1}).limit(500)).map(view)}));
 for(const route of ['download','preview']) app.get(`/api/admin/live-recordings/:id/${route}`,requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOne({_id:req.params.id,deletedAt:null}):null;
  if(!row||row.status!=='ready')return res.status(404).json({message:'The recording is not ready.'});
  const url=recordingLink(row,req.query.part,route==='download');
  if(!url)return res.status(400).json({message:'Select a valid recording part.'});
  res.json({url,expiresIn:180});
 });
 app.post('/api/admin/live-recordings/:id/retry',requireAdmin,async(req,res)=>{
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOneAndUpdate({_id:req.params.id,deletedAt:null,status:{$in:['failed','upload_failed']}},{$set:{attempts:0,status:'upload_failed',nextRetryAt:new Date(),leaseUntil:new Date(0)}},{new:true}):null;
  if(!row)return res.status(409).json({message:'This recording cannot be retried now.'});
  res.json({item:view(row)});sweepRecordings().catch(()=>{});
 });
 app.delete('/api/admin/live-recordings/:id',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid recording.'});
  const row=await LiveRecording.findOneAndUpdate({_id:req.params.id,deletedAt:null,status:{$in:['ready','failed','upload_failed','not_recorded']},leaseUntil:{$lt:new Date()}},{$set:{deletedAt:new Date()}},{new:true});
  if(!row)return res.status(409).json({message:'This recording is active, saving, or already removed. Refresh and try again.'});
  res.json({deleted:true,id:String(row._id),recoverable:true});
 });
 app.post('/api/admin/live-recordings/:id/restore',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid recording.'});
  const row=await LiveRecording.findOneAndUpdate({_id:req.params.id,deletedAt:{$ne:null}},{$set:{deletedAt:null}},{new:true});
  if(!row)return res.status(404).json({message:'No removed recording was found.'});
  res.json({item:view(row)});
 });
 app.post('/api/admin/live-recordings/:id/publish',requireAdmin,async(req,res)=>{
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOne({_id:req.params.id,deletedAt:null}):null;
  if(!row||row.status!=='ready')return res.status(409).json({message:'Wait for the recording to finish processing.'});
  const parts=recordingParts(row);
  for(let index=0;index<parts.length;index++){
   const part=parts[index];
   if(part.delivery!=='upload'){
    const moved=await cloudinary.uploader.rename(part.publicId,part.publicId,{resource_type:'video',type:'authenticated',to_type:'upload',overwrite:false});
    if(!moved.public_id)return res.status(502).json({message:'Cloudinary did not confirm publication.'});
    part.delivery='upload';row.parts=parts;row.delivery=parts.every(p=>p.delivery==='upload')?'upload':'authenticated';await row.save();
   }
   const videoUrl=cloudinary.url(part.publicId,{secure:true,resource_type:'video',type:'upload',format:'mp4'});
   const audioUrl=cloudinary.url(part.publicId,{secure:true,resource_type:'video',type:'upload',format:'mp3'});
   const externalId=`live-${row._id}${parts.length>1?`-part-${index+1}`:''}`;
   const title=`${row.title}${parts.length>1?` · Part ${index+1} of ${parts.length}`:''}`;
   const duration=part.duration||0;
   await ArchiveItem.findOneAndUpdate({externalId},{$setOnInsert:{title,artist:'DJ Khalil',category:'Live Archive',mediaType:'audio',audioUrl,description:'Audio from a recorded Echo live broadcast.',duration:`${Math.floor(duration/60)}:${String(Math.floor(duration%60)).padStart(2,'0')}`}},{upsert:true});
   await MediaItem.findOneAndUpdate({mediaUrl:videoUrl},{$setOnInsert:{kind:'video',title,category:'Live Archive',isPublished:true,durationSec:Math.round(duration)}},{upsert:true});
  }
  row.published=true;await row.save();res.json({item:view(row)});
 });
 const timer=setInterval(()=>sweepRecordings().catch(()=>{}),15000);timer.unref();
}
module.exports={LiveRecording,prepareRecordingRoom,registerRecordingProxy,registerLiveRecordings,sweepRecordings,transferRecording,objectBelongsToRoom,view,recordingParts,recordingLink,uploadRecordingPart};
