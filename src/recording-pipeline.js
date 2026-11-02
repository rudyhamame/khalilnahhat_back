const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {recordingJobs}=require('./recording-jobs');
const {DEFAULT_LIMIT}=require('./recording-files');
const RETRIES=3;
async function fileDigest(filename){const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest('hex');}
function partId(room,key,index,digest){return `Live/${room}/saved/${createHash('sha256').update(key).digest('hex').slice(0,20)}/${index+1}-${digest}`;}
const flatten=sources=>sources.flatMap(source=>source.parts||[]);
function createRecordingPipeline({Model,providers,prepareFiles,upload,verify=async()=>{},clock=Date.now,jobs=recordingJobs(Model,{clock})}){
 async function run(id){
  return jobs.run(id,async lease=>{
   const {row,save}=lease;const previousAttempts=row.attempts||0;
   const provider=providers[row.provider==='ovh'?'ovh':'livekit'];
   let sources=Array.from(row.sources||[],source=>source.toObject?source.toObject():{...source});
   const keepLegacy=row.parts?.length?Array.from(row.parts,part=>part.toObject?part.toObject():{...part}):row.publicId?[{publicId:row.publicId,delivery:row.delivery||'authenticated',bytes:row.bytes||0,duration:row.duration||0}]:[];
   // Previously saved rows keep their original identities and part order.
   const legacyParts=sources.length?Array.from(row.legacyParts||[]):keepLegacy;
   let directory,phase='capture';
   const parts=()=>legacyParts.concat(flatten(sources));
   const commit=async extra=>{const saved=parts();await save({sources,legacyParts,parts:saved,publicId:saved[0]?.publicId||'',bytes:saved.reduce((n,p)=>n+p.bytes,0),duration:saved.reduce((n,p)=>n+p.duration,0),...extra});};
   const verified=new Set();
   const clean=async()=>{
    for(const source of sources.filter(item=>item.saved&&!item.cleaned)){
     try{await lease.assert();const saved=source.parts?.length?source.parts:legacyParts;if(!saved.length)throw new Error('Archive manifest is missing');for(const part of saved){if(!verified.has(part.publicId)){await verify(part);verified.add(part.publicId);}}await lease.assert();await provider.remove(row,source);source.cleaned=true;await commit({cleanupPending:sources.some(item=>item.saved&&!item.cleaned),...(source.remote===row.objectKey?{objectKey:''}:{})});}
     catch(error){if(error.code==='RECORDING_LEASE_LOST')throw error;await save({cleanupPending:true});}
    }
   };
   try{
    if(['ready','partial'].includes(row.status)){
     if(row.objectKey&&!sources.length){sources=[{key:'legacy-cleanup',remote:row.objectKey,saved:true,cleaned:false,parts:[]}];await commit({cleanupPending:true});}
     await clean();await save({nextRetryAt:new Date(clock()+60000)});return;
    }
    const snapshot=await provider.inspect(row,lease);
    phase='saving';
    const known=new Set(sources.map(source=>source.key)),remotes=new Set(sources.map(source=>source.remote));
    for(const source of snapshot.sources){if(!known.has(source.key)&&!remotes.has(source.remote)){sources.push({...source,saved:Boolean(source.alreadySaved),cleaned:false,parts:[]});known.add(source.key);remotes.add(source.remote);}}
    await commit({captureState:snapshot.captureState,captureCheckedAt:new Date(clock()),captureWarning:snapshot.warning||row.captureWarning||'',status:snapshot.active?'recording':'processing',nextRetryAt:new Date(clock()+15000)});
    let sourceFailed=false;
    for(const source of sources.filter(item=>!item.saved)){
     try{
     await lease.assert();
     directory=await fs.mkdtemp('/var/tmp/echo-recording-');await fs.chmod(directory,0o700);
     const filename=path.join(directory,'source.mp4');
     await provider.download(row,source,filename);
     const files=await prepareFiles(filename,directory,DEFAULT_LIMIT);
     if(!files.length)throw new Error('No recording parts');
     const saved=[];
     for(let index=0;index<files.length;index++){
      await lease.assert();const file=files[index];
      if(!(file.bytes>0&&file.bytes<=DEFAULT_LIMIT&&file.duration>0))throw new Error('Invalid recording part');
      const digest=await fileDigest(file.filename),publicId=partId(row.roomName,source.key,index,digest);
      const output=await upload(file.filename,publicId,{bytes:file.bytes});
      if(output.public_id!==publicId||output.bytes!==file.bytes)throw new Error('Archive did not confirm the exact recording part');
      saved.push({publicId,delivery:'authenticated',bytes:output.bytes,duration:file.duration,sha256:digest});
     }
     source.parts=saved;source.saved=true;source.error='';
     // Persist the complete source manifest before acknowledging or deleting any original.
     await commit({cleanupPending:true,error:''});
     await fs.rm(directory,{recursive:true,force:true});directory=null;
     }catch(error){if(error.code==='RECORDING_LEASE_LOST')throw error;sourceFailed=true;source.error='This source could not be saved.';await commit({});if(directory){await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});directory=null;}}
    }
    await clean();
    if(sourceFailed)throw new Error('Recording sources remain unsaved');
    const warning=snapshot.warning||row.captureWarning||'';
    const status=snapshot.ended?(parts().length?(warning?'partial':'ready'):'not_recorded'):snapshot.active?'recording':'waiting';
    await commit({status,error:status==='not_recorded'?'This live stream ended without a saved recording.':status==='partial'?warning:'',attempts:0,nextRetryAt:new Date(clock()+15000),cleanupPending:sources.some(item=>item.saved&&!item.cleaned)});
   }catch(error){
    if(error.code==='RECORDING_LEASE_LOST')return;
    const attempts=previousAttempts+1;
    await save({...(phase==='capture'?{captureState:row.captureState==='starting'?'failed':row.captureState==='ended'?'ended':'unknown'}:{}),status:attempts>=RETRIES&&row.captureState==='ended'&&parts().length?'partial':'upload_failed',attempts,error:phase==='capture'?'Recording capture could not be checked or started. Already saved parts are kept. Check the media service and retry recovery.':'Saving did not finish. Already saved parts are kept. Check source availability and retry recovery.',nextRetryAt:new Date(clock()+Math.min(attempts*60000,1800000))});
   }finally{if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
  });
 }
 let running=false;
 async function sweep(){
  if(running)return;running=true;
  try{
   const now=new Date(clock());
   const rows=await Model.find({deletedAt:null,nextRetryAt:{$lte:now},$and:[{$or:[{leaseUntil:{$lte:now}},{leaseUntil:null}]}],$or:[{status:{$in:['waiting','recording','processing']}},{status:'upload_failed',attempts:{$lt:RETRIES}},{status:{$in:['ready','partial']},$or:[{cleanupPending:true},{objectKey:{$exists:true,$nin:['',null]}}]}]}).sort({nextRetryAt:1,createdAt:1}).limit(20).select('_id');
   let cursor=0;await Promise.all(Array.from({length:2},async()=>{while(cursor<rows.length){const row=rows[cursor++];await run(row._id).catch(error=>console.error('Recording worker pending:',error.code||error.name));}}));
  }finally{running=false;}
 }
 return {run,sweep,jobs};
}
module.exports={createRecordingPipeline,partId,fileDigest};
