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

const partSchema={_id:false,publicId:String,delivery:String,bytes:Number,duration:Number,sha256:String,trimStart:Number,trimEnd:Number,look:{type:Object}};
const sourceSchema={_id:false,key:String,remote:String,saved:Boolean,cleaned:Boolean,error:String,parts:[partSchema]};
const schema=new mongoose.Schema({
 commentsCaptured:{type:Boolean,default:false},
 recordingTimeline:{type:[{_id:false,startMs:Number,endMs:Number,offsetSec:Number}],default:undefined},
 roomName:{type:String,unique:true,required:true},title:String,status:{type:String,default:'waiting'},egressId:String,objectKey:String,
 parts:[partSchema],sources:[sourceSchema],legacyParts:[partSchema],
 leaseToken:{type:String,default:''},cleanupPending:{type:Boolean,default:false},
 captureState:{type:String,default:'waiting'},captureWarning:{type:String,default:''},captureAttempts:{type:Number,default:0},endObservedAt:Date,captureCheckedAt:Date,captureRequestedAt:Date,
 publicId:String,delivery:{type:String,default:'authenticated'},bytes:{type:Number,default:0},duration:{type:Number,default:0},trimStart:Number,trimEnd:Number,look:{type:Object},
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
function recordingParts(row){return row.parts?.length?Array.from(row.parts):row.publicId?[{publicId:row.publicId,delivery:row.delivery||'authenticated',bytes:row.bytes,duration:row.duration,trimStart:row.trimStart,trimEnd:row.trimEnd,look:row.look}]:[];}
function partTrim(part){
 const duration=Number(part?.duration)||0,start=Number(part?.trimStart),end=Number(part?.trimEnd);
 if(!duration||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+.05)return null;
 if(start<.005&&end>=duration-.005)return null;
 return {start:Math.max(0,start),end:Math.min(duration,end)};
}
// The editor's look (beauty and lighting) for a recorded video, applied by Cloudinary when the part is previewed, downloaded or published.
// Smoothing and side light need a live camera pipeline; they are not available on a recording, so they are never stored.
const LOOK_LIMITS={strength:[0,100],brightness:[-30,40],contrast:[-30,30],warmth:[-50,50],tone:[0,100]};
function normalizeLook(value){
 if(!value||typeof value!=='object')return null;
 const look={};
 for(const [key,[min,max]] of Object.entries(LOOK_LIMITS)){const number=Number(value[key]);look[key]=Number.isFinite(number)?Math.max(min,Math.min(max,Math.round(number))):0;}
 return look.strength>0?look:null;
}
// Cloudinary effects equivalent to the editor preview: amount = strength; brightness/contrast scale with it, tone adds a little saturation, warmth moves red against blue.
function lookTransformation(value){
 const look=normalizeLook(value);if(!look)return [];
 const amount=look.strength/100,effects=[];
 const brightness=Math.round(look.brightness*amount),contrast=Math.round(look.contrast*amount),saturation=Math.round(look.tone/5*amount),warmth=Math.round(look.warmth*amount*.4);
 if(brightness)effects.push({effect:`brightness:${brightness}`});
 if(contrast)effects.push({effect:`contrast:${contrast}`});
 if(saturation)effects.push({effect:`saturation:${saturation}`});
 if(warmth){effects.push({effect:`red:${warmth}`});effects.push({effect:`blue:${-warmth}`});}
 return effects;
}
// start/end offsets first, then the look.
function mediaTransformation(trim,look){const steps=[];if(trim)steps.push({start_offset:trim.start,end_offset:trim.end});steps.push(...lookTransformation(look));return steps.length?{transformation:steps}:{};}
// The whole live: every saved part joined in order by Cloudinary (the first part is the base, the others are spliced on), then the saved trim and look
// of the whole video. Parts keep their own delivery type, so private parts can be joined before publishing.
function wholeDuration(parts){return parts.reduce((sum,part)=>sum+(Number(part.duration)||0),0);}
function wholeTrim(row,parts){return partTrim({duration:wholeDuration(parts),trimStart:row.trimStart,trimEnd:row.trimEnd});}
function spliceSteps(parts){
 const steps=[];
 for(const part of parts.slice(1))steps.push({overlay:{resource_type:'video',...(part.delivery&&part.delivery!=='upload'?{type:part.delivery}:{}),public_id:part.publicId},flags:'splice'},{flags:'layer_apply'});
 return steps;
}
function wholeTransformation(row,parts,{full=false,look=true}={}){
 const steps=spliceSteps(parts);
 if(!full){const trim=wholeTrim(row,parts);steps.push(...(mediaTransformation(trim,look?row.look:null).transformation||[]));}
 return steps.length?{transformation:steps}:{};
}
function view(row){const parts=recordingParts(row);return {id:String(row._id),title:row.title,status:row.status,bytes:row.status==='recording'?row.direct?.bytes||0:row.bytes,durationSec:row.status==='recording'&&row.direct?.lastChunkAt?Math.max(0,Math.round((new Date(row.direct.lastChunkAt)-new Date(row.createdAt))/1000)):row.duration,published:row.published,createdAt:row.createdAt,error:row.error||'',captureState:row.captureState||'unknown',captureCheckedAt:row.captureCheckedAt||null,warning:row.captureWarning||'',cleanupPending:Boolean(row.cleanupPending),savedPartCount:parts.length,retrying:row.status==='upload_failed'&&(row.attempts||0)<3,canRetry:['failed','upload_failed'].includes(row.status)||row.captureState==='failed'||(row.status==='partial'&&row.sources?.some(source=>!source.saved)),canRemove:!row.cleanupPending&&(['ready','partial','not_recorded'].includes(row.status)||(['failed','upload_failed'].includes(row.status)&&row.captureState==='ended')),canPreview:['ready','partial'].includes(row.status)&&parts.length>0,partCount:parts.length,parts:parts.map((part,index)=>{const trim=partTrim(part);return {index,bytes:part.bytes,durationSec:part.duration,trimStartSec:trim?.start||0,trimEndSec:trim?.end||part.duration||0,selectedDurationSec:trim?trim.end-trim.start:part.duration,...(normalizeLook(part.look)?{look:normalizeLook(part.look)}:{})};}),...(parts.length>1?{whole:wholeView(row,parts)}:{})};}
function wholeView(row,parts){const duration=wholeDuration(parts),trim=wholeTrim(row,parts),look=normalizeLook(row.look);return {durationSec:duration,trimStartSec:trim?.start||0,trimEndSec:trim?.end||duration,selectedDurationSec:trim?trim.end-trim.start:duration,...(look?{look}:{})};}
// ttl: how long the private link works (seconds). A download starts at once, so 3 minutes is plenty; a <video> keeps asking for more of the file
// while it plays, pauses and seeks, so the preview link must outlive the viewing session.
const PREVIEW_LINK_TTL=6*60*60;
function recordingLink(row,partIndex,attachment,full=false,ttl=180){
 const parts=recordingParts(row);
 // part=all: the whole live, built from all parts (a single-part recording is just that part).
 if(partIndex==='all'&&parts.length>1)return cloudinary.url(parts[0].publicId,{secure:true,resource_type:'video',type:parts[0].delivery||'authenticated',format:'mp4',sign_url:true,...wholeTransformation(row,parts,{full}),...(attachment?{flags:'attachment'}:{})});
 const index=partIndex===undefined||partIndex==='all'?0:Number(partIndex);
 if(!Number.isInteger(index)||index<0||index>=parts.length)return null;
 const part=parts[index];
 // The saved trim applies to the preview as well as to downloads and publishing; only the trimmer asks for the full source (full=1).
 const trim=!full&&partTrim(part),look=!full&&normalizeLook(part.look);
 if(trim||look)return cloudinary.url(part.publicId,{secure:true,resource_type:'video',type:part.delivery||'authenticated',format:'mp4',sign_url:true,...mediaTransformation(trim,look),...(attachment?{flags:'attachment'}:{})});
 return cloudinary.utils.private_download_url(part.publicId,'mp4',{resource_type:'video',type:part.delivery||'authenticated',expires_at:Math.floor(Date.now()/1000)+ttl,attachment});
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
 app.get('/api/admin/live-recordings/:id/comments',requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOne({_id:req.params.id,deletedAt:null}):null;
   if(!row)return res.status(404).json({message:'Recording not found.'});
   const parts=recordingParts(row),all=req.query.part==='all',index=Number(req.query.part||0);
   if(!all&&(!Number.isInteger(index)||!parts[index]))return res.status(400).json({message:'Choose a valid recording part.'});
   const trim=all?wholeTrim(row,parts):partTrim(parts[index]);
   const duration=all?wholeDuration(parts):parts[index].duration;
   const offset=(all?0:parts.slice(0,index).reduce((sum,part)=>sum+(Number(part.duration)||0),0))+(trim?.start||0);
   if(row.commentsCaptured){
    const comments=await require('./recording-comments').RecordingComment.find({recordingId:row._id,atSec:{$gte:offset,$lt:offset+(trim?trim.end-trim.start:duration)}}).sort({atSec:1,_id:1}).lean();
    const items=comments.map(item=>({id:item.commentId,name:item.name,text:item.text,atSec:item.atSec-offset,...(item.reply?.text?{reply:{text:item.reply.text,atSec:item.reply.atSec-offset}}:{})}));
    return res.json({items,approximate:!row.recordingTimeline?.length});
   }
   const comments=await require('./live-comments').LiveComment.find({session:row.roomName,hidden:{$ne:true}}).sort({createdAt:1,_id:1}).lean();
   const items=require('./recording-comments').timedComments(comments,{timeline:row.recordingTimeline||[],startedAt:row.createdAt,offsetSec:offset,durationSec:trim?trim.end-trim.start:duration});
   return res.json({items,approximate:!row.recordingTimeline?.length});
  }catch{return res.status(503).json({message:'Recording comments could not be loaded.'});}
 });
 for(const route of ['download','preview']) app.get(`/api/admin/live-recordings/:id/${route}`,requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOne({_id:req.params.id,deletedAt:null}):null;
  if(!row||!['ready','partial'].includes(row.status))return res.status(404).json({message:'The recording is not ready.'});
  const ttl=route==='preview'?PREVIEW_LINK_TTL:180;
  const url=recordingLink(row,req.query.part,route==='download',route==='preview'&&req.query.full==='1',ttl);
  if(!url)return res.status(400).json({message:'Select a valid recording part.'});
  res.json({url,expiresIn:ttl});
 });
 app.post('/api/admin/live-recordings/:id/retry',requireAdmin,async(req,res)=>{
  const row=mongoose.isValidObjectId(req.params.id)?await LiveRecording.findOneAndUpdate({_id:req.params.id,deletedAt:null,$or:[{status:{$in:['failed','upload_failed']}},{status:'recording',captureState:'failed'},{status:'partial',sources:{$elemMatch:{saved:false}}}],leaseUntil:{$lte:new Date()}},{$set:{attempts:0,captureAttempts:0,status:'upload_failed',nextRetryAt:new Date()}},{new:true}):null;
  if(!row)return res.status(409).json({message:'This recording cannot be retried now.'});
  res.json({item:view(row)});sweep().catch(()=>{});
 });
 app.post('/api/admin/live-recordings/:id/trim',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid recording.'});
  const row=await LiveRecording.findOne({_id:req.params.id,deletedAt:null,status:{$in:['ready','partial']}});
  if(!row)return res.status(409).json({message:'Wait for the recording to finish saving.'});
  if(row.published)return res.status(409).json({message:'This recording is already published and its trim can no longer be changed.'});
  if(req.body?.part==='all'){
   // The whole live (all parts joined): its trim and look are saved on the recording itself.
   const all=recordingParts(row),total=wholeDuration(all),from=Number(req.body?.start),to=Number(req.body?.end);
   if(all.length<2)return res.status(400).json({message:'Select a valid recording part.'});
   if(!total||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to>total+.05||to-from<.1)return res.status(400).json({message:'Choose a valid trim range of at least 0.1 seconds.'});
   const wholeStart=Math.round(Math.max(0,from)*1000)/1000,wholeEnd=Math.round(Math.min(total,to)*1000)/1000,untrimmed=wholeStart<.005&&wholeEnd>=total-.005;
   row.trimStart=untrimmed?undefined:wholeStart;row.trimEnd=untrimmed?undefined:wholeEnd;
   if('look' in req.body)row.look=normalizeLook(req.body.look)||undefined;
   await row.save();
   return res.json({item:view(row)});
  }
  const index=Number(req.body?.part),start=Number(req.body?.start),end=Number(req.body?.end),parts=recordingParts(row),part=parts[index];
  if(!Number.isInteger(index)||index<0||!part)return res.status(400).json({message:'Select a valid recording part.'});
  const duration=Number(part.duration)||0;
  if(!duration||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+.05||end-start<.1)return res.status(400).json({message:'Choose a valid trim range of at least 0.1 seconds.'});
  const trimStart=Math.round(Math.max(0,start)*1000)/1000,trimEnd=Math.round(Math.min(duration,end)*1000)/1000;
  const full=trimStart<.005&&trimEnd>=duration-.005;
  if(row.parts?.length){row.parts[index].trimStart=full?undefined:trimStart;row.parts[index].trimEnd=full?undefined:trimEnd;}
  else{row.trimStart=full?undefined:trimStart;row.trimEnd=full?undefined:trimEnd;}
  // The editor's look is saved with the trim; an empty or zero-strength look clears it.
  if('look' in (req.body||{})){const look=normalizeLook(req.body.look)||undefined;if(row.parts?.length)row.parts[index].look=look;else row.look=look;}
  await row.save();
  res.json({item:view(row)});
 });
 app.delete('/api/admin/live-recordings/:id',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid recording.'});
  let keys=[];
  const removed=await mongoose.connection.transaction(async session=>{
   await mongoose.connection.collection('musicontologylocks').updateOne({_id:'source-graph'},{$inc:{revision:1}},{upsert:true,session});
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
   await require('./recording-comments').RecordingComment.deleteMany({recordingId:row._id},{session});
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
  // body.part: 'all' publishes the whole live as one video (all parts joined); a number publishes only that part; nothing keeps the old behaviour (each part on its own).
  const whole=req.body?.part==='all'&&parts.length>1,only=req.body?.part===undefined||req.body?.part==='all'?null:Number(req.body.part);
  if(only!==null&&!(Number.isInteger(only)&&only>=0&&only<parts.length))return res.status(400).json({message:'Select a valid recording part.'});
  for(let index=0;index<parts.length;index++){
   await lease.assert();
   const part=parts[index];
   if(only!==null&&index!==only)continue;
   if(part.delivery!=='upload'){
    let moved;
    try{moved=await cloudinary.uploader.rename(part.publicId,part.publicId,{resource_type:'video',type:'authenticated',to_type:'upload',overwrite:false});}
    catch(error){if((error.http_code||error.error?.http_code)!==404)throw error;moved=await cloudinary.api.resource(part.publicId,{resource_type:'video',type:'upload'});}
    if(moved.public_id!==part.publicId||(part.bytes&&moved.bytes!==part.bytes))return res.status(502).json({message:'Cloudinary did not confirm publication.'});
    part.delivery='upload';
    const updateDelivery=items=>(items||[]).map(item=>({...item.toObject?.()||item,delivery:parts.find(p=>p.publicId===item.publicId)?.delivery||item.delivery}));
    await lease.save({parts,legacyParts:updateDelivery(row.legacyParts),sources:(row.sources||[]).map(source=>({...source.toObject?.()||source,parts:updateDelivery(source.parts)})),delivery:parts.every(p=>p.delivery==='upload')?'upload':'authenticated'});
   }
   if(whole)continue;
   const trim=partTrim(part),transform=trim?{start_offset:trim.start,end_offset:trim.end}:{};
   const videoUrl=cloudinary.url(part.publicId,{secure:true,resource_type:'video',type:'upload',format:'mp4',...mediaTransformation(trim,part.look)});
   const audioUrl=cloudinary.url(part.publicId,{secure:true,resource_type:'video',type:'upload',format:'mp3',...transform});
   const externalId=`live-${row._id}${parts.length>1?`-part-${index+1}`:''}`;
   const title=`${row.title}${parts.length>1?` · Part ${index+1} of ${parts.length}`:''}`;
   const duration=trim?trim.end-trim.start:part.duration||0;
   await ArchiveItem.findOneAndUpdate({externalId},{$setOnInsert:{title,artist:'DJ Khalil',category:'Live Archive',mediaType:'audio',audioUrl,description:'Audio from a recorded Echo live stream.',duration:`${Math.floor(duration/60)}:${String(Math.floor(duration%60)).padStart(2,'0')}`}},{upsert:true});
   await MediaItem.findOneAndUpdate({mediaUrl:videoUrl},{$setOnInsert:{kind:'video',title,category:'Live Archive',isPublished:true,durationSec:Math.round(duration)}},{upsert:true});
  }
  if(whole){
   // One video made of every part, with the whole video's trim and look.
   const joined=wholeTrim(row,parts),total=wholeDuration(parts),duration=joined?joined.end-joined.start:total;
   const videoUrl=cloudinary.url(parts[0].publicId,{secure:true,resource_type:'video',type:'upload',format:'mp4',...wholeTransformation(row,parts)});
   const audioUrl=cloudinary.url(parts[0].publicId,{secure:true,resource_type:'video',type:'upload',format:'mp3',...wholeTransformation(row,parts,{look:false})});
   const externalId=`live-${row._id}`;
   await ArchiveItem.findOneAndUpdate({externalId},{$setOnInsert:{title:row.title,artist:'DJ Khalil',category:'Live Archive',mediaType:'audio',audioUrl,description:'Audio from a recorded Echo live stream.',duration:`${Math.floor(duration/60)}:${String(Math.floor(duration%60)).padStart(2,'0')}`}},{upsert:true});
   await MediaItem.findOneAndUpdate({mediaUrl:videoUrl},{$setOnInsert:{kind:'video',title:row.title,category:'Live Archive',isPublished:true,durationSec:Math.round(duration)}},{upsert:true});
  }
    await lease.save({published:true});return res.json({item:view(row)});
   });
   if(outcome?.busy)return res.status(409).json({message:'This recording is being processed. Refresh and try again.'});
  }catch(error){console.error('Live recording publication failed:',error.code||error.name);return res.status(502).json({message:'Publication did not finish. Refresh the recording before trying again.'});}
 });
 if(startWorker&&!workerTimer){workerTimer=setInterval(()=>sweepRecordings().catch(()=>{}),15000);workerTimer.unref();}
}
module.exports={wholeDuration,wholeTrim,wholeTransformation,spliceSteps,normalizeLook,lookTransformation,mediaTransformation,statusForRoom,LiveRecording,prepareRecordingRoom,ensureRecording,registerLiveRecordings,sweepRecordings,transferRecording,objectBelongsToRoom,view,recordingParts,recordingLink,uploadRecordingPart};
