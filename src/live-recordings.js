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

const schema=new mongoose.Schema({
 roomName:{type:String,unique:true,required:true},title:String,status:{type:String,default:'waiting'},egressId:String,objectKey:String,
 publicId:String,delivery:{type:String,default:'authenticated'},bytes:{type:Number,default:0},duration:{type:Number,default:0},
 attempts:{type:Number,default:0},nextRetryAt:{type:Date,default:()=>new Date()},leaseUntil:{type:Date,default:()=>new Date(0)},
 error:{type:String,default:''},published:{type:Boolean,default:false},test:{type:Boolean,default:false},
},{timestamps:true});
const LiveRecording=mongoose.models.LiveRecording||mongoose.model('LiveRecording',schema);
const BUCKET='echo-live-archive';
function configured(){return Boolean(process.env.ECHO_RECORDING_ACCESS_KEY&&process.env.ECHO_RECORDING_SECRET&&process.env.ECHO_RECORDING_PUBLIC_ENDPOINT&&process.env.CLOUDINARY_API_SECRET);}
function store(){return new Client({endPoint:process.env.ECHO_RECORDING_HOST||'echo-recording-store',port:9000,useSSL:false,accessKey:process.env.ECHO_RECORDING_ACCESS_KEY,secretKey:process.env.ECHO_RECORDING_SECRET,region:'us-east-1'});}
function sdk(Class){return new Class(process.env.LIVEKIT_URL,process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);}
function view(row){return {id:String(row._id),title:row.title,status:row.status,bytes:row.bytes,durationSec:row.duration,published:row.published,createdAt:row.createdAt,error:row.error||''};}
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
  await sdk(RoomServiceClient).createRoom({name:roomName,emptyTimeout:120,departureTimeout:15,
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
 const claimed=await LiveRecording.findOneAndUpdate({_id:row._id,status:{$in:['waiting','recording','upload_failed','processing']},leaseUntil:{$lt:new Date()}},{$set:{status:'processing',leaseUntil:new Date(Date.now()+15*60*1000)},$inc:{attempts:1}},{new:true});
 if(!claimed)return;
 let directory;
 try {
  if(!objectBelongsToRoom(claimed.objectKey,claimed.roomName))throw new Error('Invalid recording object.');
  directory=await fs.mkdtemp('/var/tmp/echo-recording-');await fs.chmod(directory,0o700);
  const filename=path.join(directory,'recording.mp4');
  await pipeline(await store().getObject(BUCKET,claimed.objectKey),createWriteStream(filename,{mode:0o600}));
  const output=await new Promise((resolve,reject)=>{const stream=cloudinary.uploader.upload_large(filename,{resource_type:'video',type:'authenticated',folder:'khalil/live-archive',public_id:claimed.roomName,overwrite:false,chunk_size:20*1024*1024,timeout:600_000},(error,result)=>error?reject(error):resolve(result));stream.on('error',reject);});
  if(!output.public_id||!output.bytes)throw new Error('Cloudinary did not confirm the recording.');
  await LiveRecording.updateOne({_id:claimed._id},{$set:{status:'ready',publicId:output.public_id,delivery:'authenticated',bytes:output.bytes,duration:output.duration||claimed.duration,error:'',leaseUntil:new Date(0)}});
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
  const rows=await LiveRecording.find({$or:[{status:{$in:['waiting','recording']}},{status:'upload_failed',attempts:{$lt:3},nextRetryAt:{$lte:new Date()}},{status:'processing',leaseUntil:{$lt:new Date()}}]}).sort({createdAt:1}).limit(10);
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
     await LiveRecording.updateOne({_id:row._id},{$set:{status:'failed',error:'LiveKit did not produce a completed recording. Check Egress status in LiveKit Cloud.'}});
    }
   }catch(error){console.error('Live Archive check failed:',error.code||error.name);}
  }
 }finally{sweeping=false;}
}
function registerLiveRecordings(app,requireAdmin){
 app.get('/api/admin/live-recordings',requireAdmin,async(_req,res)=>res.json({items:(await LiveRecording.find({test:{$ne:true}}).sort({createdAt:-1}).limit(500)).map(view)}));
 app.get('/api/admin/live-recordings/:id/download',requireAdmin,async(req,res)=>{
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findById(req.params.id):null;
  if(!row?.publicId)return res.status(404).json({message:'The recording is not ready.'});
  res.json({url:cloudinary.utils.private_download_url(row.publicId,'mp4',{resource_type:'video',type:row.delivery,expires_at:Math.floor(Date.now()/1000)+180,attachment:true}),expiresIn:180});
 });
 app.post('/api/admin/live-recordings/:id/retry',requireAdmin,async(req,res)=>{
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOneAndUpdate({_id:req.params.id,status:{$in:['failed','upload_failed']}},{$set:{attempts:0,status:'upload_failed',nextRetryAt:new Date(),leaseUntil:new Date(0)}},{new:true}):null;
  if(!row)return res.status(409).json({message:'This recording cannot be retried now.'});
  res.json({item:view(row)});sweepRecordings().catch(()=>{});
 });
 app.post('/api/admin/live-recordings/:id/publish',requireAdmin,async(req,res)=>{
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findById(req.params.id):null;
  if(!row||row.status!=='ready')return res.status(409).json({message:'Wait for the recording to finish processing.'});
  if(row.delivery!=='upload'){
   const moved=await cloudinary.uploader.rename(row.publicId,row.publicId,{resource_type:'video',type:'authenticated',to_type:'upload',overwrite:false});
   if(!moved.public_id)return res.status(502).json({message:'Cloudinary did not confirm publication.'});
   row.delivery='upload';await row.save();
  }
  const videoUrl=cloudinary.url(row.publicId,{secure:true,resource_type:'video',type:'upload',format:'mp4'});
  const audioUrl=cloudinary.url(row.publicId,{secure:true,resource_type:'video',type:'upload',format:'mp3'});
  const externalId=`live-${row._id}`;
  await ArchiveItem.findOneAndUpdate({externalId},{$setOnInsert:{title:row.title,artist:'DJ Khalil',category:'Live Archive',mediaType:'audio',audioUrl,description:'Audio from a recorded Echo live broadcast.',duration:`${Math.floor(row.duration/60)}:${String(Math.floor(row.duration%60)).padStart(2,'0')}`}},{upsert:true});
  await MediaItem.findOneAndUpdate({mediaUrl:videoUrl},{$setOnInsert:{kind:'video',title:row.title,category:'Live Archive',isPublished:true,durationSec:Math.round(row.duration)}},{upsert:true});
  row.published=true;await row.save();res.json({item:view(row)});
 });
 const timer=setInterval(()=>sweepRecordings().catch(()=>{}),15000);timer.unref();
}
module.exports={LiveRecording,prepareRecordingRoom,registerRecordingProxy,registerLiveRecordings,sweepRecordings,transferRecording,objectBelongsToRoom,view};
