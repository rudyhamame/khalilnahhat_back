const fs=require('node:fs/promises');
const {createReadStream,createWriteStream}=require('node:fs');
const path=require('node:path');
const {pipeline}=require('node:stream/promises');
const {Readable}=require('node:stream');
const {createHash,randomUUID}=require('node:crypto');
const {promisify}=require('node:util');
const exec=promisify(require('node:child_process').execFile);
const ROOT=process.env.ECHO_DIRECT_RECORDING_DIR||'/var/tmp/echo-direct-recordings';
const LIMIT=4*1024**3,CHUNK_LIMIT=8*1024**2;
const reservations=new Map();
const reservedBytes=()=>[...reservations.values()].reduce((sum,n)=>sum+n,0);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const directory=row=>{const id=String(row._id);if(!/^[a-f\d]{24}$/.test(id))throw fail(400,'Invalid recording identity.');return path.join(ROOT,id);};
const chunkPath=(row,n)=>path.join(directory(row),String(n).padStart(8,'0')+'.chunk');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function models(){return require('./live-recordings');}
async function diskCheck(reserve=2*1024**3){await fs.mkdir(ROOT,{recursive:true,mode:0o700});const disk=await fs.statfs(ROOT),free=disk.bavail*disk.bsize-reservedBytes();if(free<reserve){const gb=n=>(Math.max(0,n)/1024**3).toFixed(1)+' GB';throw fail(507,`The OVH server's recording disk is full (${gb(free)} free, ${gb(reserve)} needed). This is the server, not your computer: your recording is safe in your chosen folder and will upload automatically once space is freed on the server.`);}}
async function createDirectRecording(roomName,title,ownerId){
 if(!ownerId)throw fail(401,'Recording owner is required.');
 await diskCheck(require('./recording-storage').recordingDiskReserve()||2*1024**3);
 const row=await models().LiveRecording.create({roomName,title,provider:'direct',status:'recording',captureState:'waiting',direct:{ownerId:String(ownerId),count:0,bytes:0,state:'open',lastChunkAt:new Date()},nextRetryAt:new Date(Date.now()+15000)});
 await fs.mkdir(directory(row),{recursive:true,mode:0o700});return row;
}
async function withRecording(id,owner,work){
 const {LiveRecording}=models();if(!/^[a-f\d]{24}$/.test(id))throw fail(400,'Invalid recording.');
 const row=await LiveRecording.findOne({_id:id,provider:'direct',deletedAt:null,'direct.ownerId':String(owner)});
 if(!row)throw fail(404,'Recording not found.');
 const jobs=require('./recording-jobs').recordingJobs(LiveRecording);
 const result=await jobs.run(id,async lease=>work(lease));if(result?.busy)throw fail(409,'Recording is busy. Retry this same chunk.');return result;
}
async function acceptChunk(lease,index,body,mime,claimedHash){
 const {row,save}=lease,d=row.direct;
 if(!Number.isSafeInteger(index)||index<0||index>100000)throw fail(400,'Invalid chunk sequence.');
 if(!Buffer.isBuffer(body)||!body.length||body.length>CHUNK_LIMIT)throw fail(413,'Recording chunk is too large or empty.');
 const hash=digest(body),filename=chunkPath(row,index);
 // Transit integrity: the Studio hashes the part it holds on disk; a mismatch means the bytes were damaged in flight.
 if(claimedHash&&claimedHash.toLowerCase()!==hash)throw fail(422,'Chunk checksum mismatch. Retry this chunk.');
 // An acknowledgement lost in transit must never append the same bytes twice.
 if(index<d.count){const existing=await fs.readFile(filename).catch(()=>null);if(existing&&digest(existing)===hash)return {nextSequence:d.count};throw fail(409,'This chunk sequence already contains different data.');}
 if(d.state!=='open')throw fail(409,'This recording has finished receiving data.');
 if(index!==d.count)throw fail(409,'Upload the missing recording chunk first.');
 if(!/^(video\/(webm|mp4)|audio\/(webm|mp4|ogg))(;|$)/.test(mime||''))throw fail(400,'Unsupported recording format.');
 if(d.mime&&d.mime!==mime)throw fail(409,'Recording format changed during upload.');
 if(d.bytes+body.length>LIMIT)throw fail(507,'This recording has reached its 4 GiB storage limit.');
 await diskCheck();await fs.mkdir(directory(row),{recursive:true,mode:0o700});
 const pending=filename+'.'+randomUUID()+'.pending';
 try{
  await fs.writeFile(pending,body,{flag:'wx',mode:0o600,flush:true});await lease.assert();
  await fs.rename(pending,filename);
  const dir=await fs.open(directory(row),'r');try{await dir.sync();}finally{await dir.close();}
 }finally{await fs.rm(pending,{force:true});}
 await save({direct:{...d.toObject?.()||d,count:d.count+1,bytes:d.bytes+body.length,mime,lastChunkAt:new Date()},captureState:'recording',status:'recording'});
 return {nextSequence:index+1};
}
async function seal(lease,count,complete,bytes){
 const {row,save}=lease,d=row.direct;
 if(!Number.isSafeInteger(count)||count!==d.count||count<0)throw fail(409,'Some recording chunks have not arrived. Retry uploads before finishing.');
 if(bytes!==undefined&&bytes!==d.bytes)throw fail(409,'Received recording size does not match the Studio copy. Retry uploads before finishing.');
 if(d.state==='open')await save({direct:{...d.toObject?.()||d,state:count?'sealed':'empty',complete:count?Boolean(complete):false},captureState:'ended',status:'processing',error:'',attempts:0,nextRetryAt:new Date()});
 return {accepted:true,chunks:count};
}
async function materialize(row,lease){
 const dir=directory(row),target=path.join(dir,'capture.mp4');
 if(row.direct.state==='prepared'){await fs.access(target);await fs.rm(path.join(dir,'capture.raw'),{force:true});for(let i=0;i<row.direct.count;i++)await fs.rm(chunkPath(row,i),{force:true});return;}
 const attempt=randomUUID(),raw=path.join(dir,'capture-'+attempt+'.raw'),output=path.join(dir,'capture-'+attempt+'.pending.mp4');
 try{
 // Rebuild deterministically from durable chunks; failed conversions keep originals.
 async function* chunks(){for(let i=0;i<row.direct.count;i++){await lease.assert();yield* createReadStream(chunkPath(row,i));}}
 await pipeline(Readable.from(chunks()),createWriteStream(raw,{mode:0o600}));
 const {stdout}=await exec('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name','-of','json',raw],{timeout:60000});
 const streams=JSON.parse(stdout).streams||[],copyVideo=streams.find(s=>s.codec_type==='video')?.codec_name==='h264',copyAudio=streams.find(s=>s.codec_type==='audio')?.codec_name==='aac';
 await exec('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',raw,'-map','0:v?','-map','0:a?',...(copyVideo?['-c:v','copy']:['-c:v','libx264','-preset','ultrafast','-crf','23','-maxrate','3M','-bufsize','6M','-pix_fmt','yuv420p']),...(copyAudio?['-c:a','copy']:['-c:a','aac','-b:a','320k']),'-movflags','+faststart',output],{timeout:1800000,maxBuffer:1024*1024});
 await require('./recording-files').durationOf(output);
 await lease.assert();await fs.rename(output,target);
 await lease.save({direct:{...row.direct.toObject?.()||row.direct,state:'prepared'}});
 await fs.rm(raw,{force:true});
 for(let i=0;i<row.direct.count;i++)await fs.rm(chunkPath(row,i),{force:true});
 }finally{await fs.rm(raw,{force:true});await fs.rm(output,{force:true});}
}
function directProvider(){return {
 async inspect(row,lease){
  if(row.direct.state==='empty'){await fs.rm(directory(row),{recursive:true,force:true});return {sources:[],active:false,ended:true,captureState:'ended',warning:''};}
  if(row.direct.state==='open'){
   const active=await require('./models').LiveStreamConfig.exists({webrtcRoomName:row.roomName});
   const idle=Date.now()-new Date(row.direct.lastChunkAt).getTime();
   if(!active&&idle>120000){
    if(!row.direct.count)return {sources:[],active:false,ended:true,captureState:'ended',warning:'No recording chunks were received.'};
    await seal(lease,row.direct.count,false);
   }else return {sources:[],active:true,ended:false,captureState:row.direct.count?'recording':'waiting',warning:''};
  }
  const reservation=Math.max(64*1024**2,row.direct.bytes*2);
  await diskCheck(reservation+2*1024**3);reservations.set(row,reservation);
  // Completed manifests go straight to cleanup without re-creating deleted sources.
  if(!row.sources?.some(s=>s.saved))await materialize(row,lease);
  return {sources:[{key:'direct:'+row._id,remote:'capture.mp4'}],active:false,ended:true,captureState:'ended',warning:row.direct.complete?'':'The source was interrupted. Only received media could be saved.'};
 },
 async download(row,source,filename){if(source.remote!=='capture.mp4')throw fail(400,'Invalid recording file.');await pipeline(createReadStream(path.join(directory(row),'capture.mp4')),createWriteStream(filename,{mode:0o600}));},
 release(row){reservations.delete(row);},
 async remove(row,source){if(source.remote!=='capture.mp4')throw fail(400,'Invalid recording file.');await fs.rm(directory(row),{recursive:true,force:true});}
};}
function registerDirectRecordingRoutes(app,requireAdmin){
 const express=require('express');
 const handle=fn=>async(req,res)=>{try{res.set('Cache-Control','no-store');res.json(await withRecording(req.params.id,req.user._id,lease=>fn(req,lease)));}catch(e){res.status(e.status||503).json({message:e.status?e.message:'Recording data is retained. Please retry.'});}};
 app.post('/api/live-stream/recordings/:id/chunks/:sequence',requireAdmin,express.raw({type:'application/octet-stream',limit:CHUNK_LIMIT}),handle((req,lease)=>acceptChunk(lease,Number(req.params.sequence),req.body,req.headers['x-recording-mime'],req.headers['x-chunk-sha256'])));
 app.post('/api/live-stream/recordings/:id/finish',requireAdmin,handle((req,lease)=>seal(lease,req.body?.chunks,req.body?.complete===true,req.body?.bytes)));
 app.get('/api/live-stream/recordings/:id/status',requireAdmin,handle((_req,{row})=>({nextSequence:row.direct.count,state:row.direct.state,status:row.status})));
}
module.exports={createDirectRecording,acceptChunk,seal,directProvider,registerDirectRecordingRoutes,directory,CHUNK_LIMIT};
