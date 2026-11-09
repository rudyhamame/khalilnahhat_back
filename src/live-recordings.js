const permanentDeletion=require('./permanent-deletion');
const mongoose=require('mongoose');
const {statfs}=require('node:fs/promises');
const {recordingDiskReserve}=require('./recording-storage');
const cloudinary=require('cloudinary').v2;
const {createRecordingObjectStore}=require('./recording-object-store');
const {RoomServiceClient,EgressClient}=require('livekit-server-sdk');
const {RoomEgress,AutoParticipantEgress,EncodedFileOutput,S3Upload,EncodedFileType,EncodingOptionsPreset}=require('@livekit/protocol');
const {ArchiveItem}=require('./models');
const {MediaItem}=require('./content');
const {recordingStorageConfig}=require('./recording-storage');
const {createRecordingPipeline}=require('./recording-pipeline');
const {createRecordingProviders}=require('./recording-providers');
const {prepareRecordingFiles}=require('./recording-files');

const partSchema={_id:false,publicId:String,delivery:String,bytes:Number,duration:Number,sha256:String};
const sourceSchema={_id:false,key:String,remote:String,saved:Boolean,cleaned:Boolean,error:String,parts:[partSchema]};
const schema=new mongoose.Schema({
 roomName:{type:String,unique:true,required:true},title:String,status:{type:String,default:'waiting'},egressId:String,objectKey:String,
 parts:[partSchema],sources:[sourceSchema],legacyParts:[partSchema],
 leaseToken:{type:String,default:''},cleanupPending:{type:Boolean,default:false},
 captureState:{type:String,default:'waiting'},captureWarning:{type:String,default:''},captureAttempts:{type:Number,default:0},endObservedAt:Date,captureCheckedAt:Date,captureRequestedAt:Date,
 publicId:String,delivery:{type:String,default:'authenticated'},bytes:{type:Number,default:0},duration:{type:Number,default:0},
 attempts:{type:Number,default:0},nextRetryAt:{type:Date,default:()=>new Date()},leaseUntil:{type:Date,default:()=>new Date(0)},
 deletedAt:{type:Date,default:null},
 provider:{type:String,default:'livekit'},relaySegments:[String],
 direct:{ownerId:String,mime:String,count:{type:Number,default:0},bytes:{type:Number,default:0},state:String,complete:Boolean,lastChunkAt:Date},
 error:{type:String,default:''},published:{type:Boolean,default:false},test:{type:Boolean,default:false},
},{timestamps:true});
schema.index({deletedAt:1,nextRetryAt:1,leaseUntil:1});
const LiveRecording=mongoose.models.LiveRecording||mongoose.model('LiveRecording',schema);
function configured(){return Boolean(recordingStorageConfig()&&process.env.CLOUDINARY_API_SECRET);}
let storageClient, storageIdentity;
function store(){
 const config=recordingStorageConfig();
 if(!config)throw Object.assign(new Error('Configure private S3 recording storage before starting a live stream.'),{status:503});
 const identity=JSON.stringify(config);
 if(!storageClient||identity!==storageIdentity){storageClient=createRecordingObjectStore(config);storageIdentity=identity;}
 return storageClient;
}
function sdk(Class){return new Class(process.env.LIVEKIT_URL,process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);}
function recordingParts(row){return row.parts?.length?Array.from(row.parts):row.publicId?[{publicId:row.publicId,delivery:row.delivery||'authenticated',bytes:row.bytes,duration:row.duration}]:[];}
function view(row){const parts=recordingParts(row);return {id:String(row._id),title:row.title,status:row.status,bytes:row.bytes,durationSec:row.duration,published:row.published,createdAt:row.createdAt,error:row.error||'',captureState:row.captureState||'unknown',captureCheckedAt:row.captureCheckedAt||null,warning:row.captureWarning||'',cleanupPending:Boolean(row.cleanupPending),savedPartCount:parts.length,canRetry:['failed','upload_failed'].includes(row.status)||row.captureState==='failed'||(row.status==='partial'&&row.sources?.some(source=>!source.saved)),canRemove:!row.cleanupPending&&(['ready','partial','not_recorded'].includes(row.status)||(['failed','upload_failed'].includes(row.status)&&row.captureState==='ended')),canPreview:['ready','partial'].includes(row.status)&&parts.length>0,partCount:parts.length,parts:parts.map((part,index)=>({index,bytes:part.bytes,durationSec:part.duration}))};}
function recordingLink(row,partIndex,attachment){
 const parts=recordingParts(row);const index=partIndex===undefined?0:Number(partIndex);
 if(!Number.isInteger(index)||index<0||index>=parts.length)return null;
 const part=parts[index];
 return cloudinary.utils.private_download_url(part.publicId,'mp4',{resource_type:'video',type:part.delivery||'authenticated',expires_at:Math.floor(Date.now()/1000)+180,attachment});
}
async function uploadRecordingPart(filename,publicId,expected={}){
 try {const existing=await cloudinary.api.resource(publicId,{resource_type:'video',type:'authenticated'});if(existing.public_id!==publicId||!(existing.bytes>0)||(expected.bytes&&existing.bytes!==expected.bytes))throw new Error('Archive identity or size mismatch');return existing;}
 catch(error){if((error.http_code||error.error?.http_code)!==404)throw error;}
 return new Promise((resolve,reject)=>{const stream=cloudinary.uploader.upload_large(filename,{resource_type:'video',type:'authenticated',public_id:publicId,overwrite:false,chunk_size:20*1024*1024,timeout:600000},(error,result)=>error?reject(error):resolve(result));stream.on('error',reject);});
}
function objectBelongsToRoom(key,roomName){return typeof key==='string'&&key.startsWith(roomName+'/')&&!key.includes('..')&&key.endsWith('.mp4');}
// LiveKit writes to the configured private S3 staging bucket; verified files move to Cloudinary.
function recordingFile(roomName,config){
 return new EncodedFileOutput({fileType:EncodedFileType.MP4,filepath:`${roomName}/{publisher_identity}-{time}.mp4`,disableManifest:true,
  output:{case:'s3',value:new S3Upload({accessKey:process.env.ECHO_RECORDING_ACCESS_KEY,secret:process.env.ECHO_RECORDING_SECRET,endpoint:config.publicEndpoint,bucket:config.bucket,region:config.region,forcePathStyle:true})}});
}
async function prepareRecordingRoom(roomName,title,test=false,options={}){
 if(options.mode==='direct'){
  const recording=await require('./direct-recording').createDirectRecording(roomName,title,options.ownerId);
  try{await sdk(RoomServiceClient).createRoom({name:roomName,emptyTimeout:180,departureTimeout:15});}
  catch(error){await LiveRecording.updateOne({_id:recording._id},{$set:{captureState:'ended',status:'failed',error:'The live room could not start.'}});throw error;}
  return recording;
 }
 if(!configured())throw Object.assign(new Error('Automatic recording storage is not configured.'),{status:503});
 const reserve=recordingDiskReserve();
 if(reserve){
  const disk=await statfs('/var/tmp');
  if(disk.bavail*disk.bsize<reserve)throw Object.assign(new Error('Recording storage is low on disk space. Wait for pending recordings to finish saving before starting another live stream.'),{status:503});
 }
 const config=recordingStorageConfig(),BUCKET=config.bucket;
 const client=store();
 if(!await client.bucketExists(BUCKET))throw Object.assign(new Error('Create the private recording staging bucket before starting a live stream.'),{status:503});
 // Bound visible staging data before another recording. Provider spending caps and
 // version lifecycle rules must be configured separately.
 let used=0;for await(const obj of client.listObjectsV2(BUCKET,'',true)){used+=obj.size||0;}
 if(used>1024*1024*1024)throw Object.assign(new Error('Recording staging storage needs attention before another live.'),{status:503});
 const file=recordingFile(roomName,config);
 const recording=await LiveRecording.create({roomName,title:title||'DJ Khalil — Live',test});
 try {
  await sdk(RoomServiceClient).createRoom({name:roomName,emptyTimeout:180,departureTimeout:15,
   egress:new RoomEgress({participant:new AutoParticipantEgress({options:{case:'preset',value:EncodingOptionsPreset.H264_720P_30},fileOutputs:[file]})})});
 }catch(error){await LiveRecording.updateOne({_id:recording._id},{$set:{status:'failed',captureState:'ended',error:'LiveKit could not enable recording.'}});throw Object.assign(new Error('LiveKit could not enable automatic recording.'),{status:503});}
 return recording;
}
async function verifyArchivedPart(part){
 const stored=await cloudinary.api.resource(part.publicId,{resource_type:'video',type:part.delivery||'authenticated'});
 if(stored.public_id!==part.publicId||!(stored.bytes>0)||(part.bytes&&stored.bytes!==part.bytes))throw new Error('Saved archive part could not be confirmed');
}
const pipeline=createRecordingPipeline({Model:LiveRecording,
 providers:{direct:require('./direct-recording').directProvider(),...createRecordingProviders({store,bucket:()=>recordingStorageConfig()?.bucket,
  egress:()=>sdk(EgressClient),rooms:()=>sdk(RoomServiceClient),
  startCapture:(roomName,identity)=>sdk(EgressClient).startParticipantEgress(roomName,identity,{file:recordingFile(roomName,recordingStorageConfig())},{encodingOptions:EncodingOptionsPreset.H264_720P_30})})},
 prepareFiles:prepareRecordingFiles,upload:uploadRecordingPart,verify:verifyArchivedPart});
async function statusForRoom(roomName){
 if(!roomName)return null;
 try{const row=await LiveRecording.findOne({roomName,deletedAt:null});return row?view(row):null;}catch{return {status:'unavailable',captureState:'unknown',error:'Recording status could not be checked.'};}
}
async function transferRecording(row){return pipeline.run(row._id);}
async function ensureRecording(roomName){
 if(!configured())return false;
 const row=await LiveRecording.findOne({roomName,deletedAt:null,status:{$nin:['ready','partial','not_recorded']}});
 if(!row)return false;
 await pipeline.run(row._id);return true;
}
async function sweepRecordings(){return pipeline.sweep();}
let workerTimer;
function registerLiveRecordings(app,requireAdmin,{sweep=sweepRecordings,startWorker=true}={}){
 app.get('/api/admin/live-recordings',requireAdmin,async(_req,res)=>res.json({items:(await LiveRecording.find({test:{$ne:true},deletedAt:null}).sort({createdAt:-1}).limit(500)).map(view)}));
 for(const route of ['download','preview']) app.get(`/api/admin/live-recordings/:id/${route}`,requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOne({_id:req.params.id,deletedAt:null}):null;
  if(!row||!['ready','partial'].includes(row.status))return res.status(404).json({message:'The recording is not ready.'});
  const url=recordingLink(row,req.query.part,route==='download');
  if(!url)return res.status(400).json({message:'Select a valid recording part.'});
  res.json({url,expiresIn:180});
 });
 app.post('/api/admin/live-recordings/:id/retry',requireAdmin,async(req,res)=>{
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOneAndUpdate({_id:req.params.id,deletedAt:null,$or:[{status:{$in:['failed','upload_failed']}},{status:'recording',captureState:'failed'},{status:'partial',sources:{$elemMatch:{saved:false}}}],leaseUntil:{$lte:new Date()}},{$set:{attempts:0,captureAttempts:0,status:'upload_failed',nextRetryAt:new Date()}},{new:true}):null;
  if(!row)return res.status(409).json({message:'This recording cannot be retried now.'});
  res.json({item:view(row)});sweep().catch(()=>{});
 });
 app.delete('/api/admin/live-recordings/:id',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid recording.'});
  let keys=[];
  const removed=await mongoose.connection.transaction(async session=>{
   const filter={_id:req.params.id,deletedAt:null,status:{$in:['ready','partial','failed','upload_failed','not_recorded']},$or:[{status:{$in:['ready','partial','not_recorded']}},{captureState:'ended'}],leaseUntil:{$lt:new Date()},cleanupPending:{$ne:true}};
   const row=await LiveRecording.findOne(filter).session(session);
   if(!row)return false;
   const prefix=`live-${row._id}`,ownedIds=new RegExp('^'+prefix+'(?:-part-[0-9]+)?$');
   const published=await ArchiveItem.find({externalId:ownedIds}).session(session);
   const ids=published.map(item=>item.externalId);
   if(ids.length&&await ArchiveItem.exists({externalId:{$nin:ids},sourceRecordingIds:{$in:ids}}).session(session))throw Object.assign(new Error('This live recording is used as a source. Remove its source links before deleting it.'),{status:409});
   const versions=ids.length?await require('./music-ontology/models').Version.find({recordingId:{$in:ids}}).session(session):[];
   keys=await permanentDeletion.prepare([row.toObject(),...published.map(item=>item.toObject()),...versions.map(item=>item.toObject())],{session});
   if(ids.length){
    await require('./music-archive').Collection.updateMany({recordingIds:{$in:ids}},{$pull:{recordingIds:{$in:ids}}},{session});
    await require('./music-ontology/models').Version.deleteMany({recordingId:{$in:ids}},{session});
    await ArchiveItem.deleteMany({externalId:{$in:ids}},{session});
   }
   const urls=recordingParts(row).map(part=>cloudinary.url(part.publicId,{secure:true,resource_type:'video',type:part.delivery||'authenticated',format:'mp4'}));
   const media=await MediaItem.find({mediaUrl:{$in:urls}}).select('_id').session(session);
   await require('./gallery-albums').GalleryAlbum.updateMany({itemIds:{$in:media.map(item=>String(item._id))}},{$pull:{itemIds:{$in:media.map(item=>String(item._id))}}},{session});
   await MediaItem.deleteMany({_id:{$in:media.map(item=>item._id)}},{session});
   const result=await LiveRecording.deleteOne(filter,{session});
   if(result.deletedCount!==1)throw Object.assign(new Error('Recording changed. Refresh before deleting.'),{status:409});
   return true;
  });
  if(!removed)return res.status(409).json({message:'This recording is active, saving, or already deleted. Refresh and try again.'});
  const cleanup=await permanentDeletion.finish(keys);
  res.json({deleted:true,id:req.params.id,recoverable:false,cloudinaryCleanupPending:cleanup.pending});
 });
 app.post('/api/admin/live-recordings/:id/publish',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid recording.'});
  try{
   const outcome=await pipeline.jobs.run(req.params.id,async lease=>{
    const row=lease.row;
    if(!['ready','partial'].includes(row.status))return res.status(409).json({message:'Wait for the recording to finish saving.'});
    if(row.status==='partial'&&req.body?.allowPartial!==true)return res.status(409).json({message:'Confirm that you want to publish only the saved parts of this incomplete recording.'});
  const parts=recordingParts(row);
  for(let index=0;index<parts.length;index++){
   await lease.assert();
   const part=parts[index];
   if(part.delivery!=='upload'){
    let moved;
    try{moved=await cloudinary.uploader.rename(part.publicId,part.publicId,{resource_type:'video',type:'authenticated',to_type:'upload',overwrite:false});}
    catch(error){if((error.http_code||error.error?.http_code)!==404)throw error;moved=await cloudinary.api.resource(part.publicId,{resource_type:'video',type:'upload'});}
    if(moved.public_id!==part.publicId||(part.bytes&&moved.bytes!==part.bytes))return res.status(502).json({message:'Cloudinary did not confirm publication.'});
    part.delivery='upload';
    const updateDelivery=items=>(items||[]).map(item=>({...item.toObject?.()||item,delivery:parts.find(p=>p.publicId===item.publicId)?.delivery||item.delivery}));
    await lease.save({parts,legacyParts:updateDelivery(row.legacyParts),sources:(row.sources||[]).map(source=>({...source.toObject?.()||source,parts:updateDelivery(source.parts)})),delivery:parts.every(p=>p.delivery==='upload')?'upload':'authenticated'});
   }
   const videoUrl=cloudinary.url(part.publicId,{secure:true,resource_type:'video',type:'upload',format:'mp4'});
   const audioUrl=cloudinary.url(part.publicId,{secure:true,resource_type:'video',type:'upload',format:'mp3'});
   const externalId=`live-${row._id}${parts.length>1?`-part-${index+1}`:''}`;
   const title=`${row.title}${parts.length>1?` · Part ${index+1} of ${parts.length}`:''}`;
   const duration=part.duration||0;
   await ArchiveItem.findOneAndUpdate({externalId},{$setOnInsert:{title,artist:'DJ Khalil',category:'Live Archive',mediaType:'audio',audioUrl,description:'Audio from a recorded Echo live stream.',duration:`${Math.floor(duration/60)}:${String(Math.floor(duration%60)).padStart(2,'0')}`}},{upsert:true});
   await MediaItem.findOneAndUpdate({mediaUrl:videoUrl},{$setOnInsert:{kind:'video',title,category:'Live Archive',isPublished:true,durationSec:Math.round(duration)}},{upsert:true});
  }
    await lease.save({published:true});return res.json({item:view(row)});
   });
   if(outcome?.busy)return res.status(409).json({message:'This recording is being processed. Refresh and try again.'});
  }catch(error){console.error('Live recording publication failed:',error.code||error.name);return res.status(502).json({message:'Publication did not finish. Refresh the recording before trying again.'});}
 });
 if(startWorker&&!workerTimer){workerTimer=setInterval(()=>sweepRecordings().catch(()=>{}),15000);workerTimer.unref();}
}
module.exports={statusForRoom,LiveRecording,prepareRecordingRoom,ensureRecording,registerLiveRecordings,sweepRecordings,transferRecording,objectBelongsToRoom,view,recordingParts,recordingLink,uploadRecordingPart};
