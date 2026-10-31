const fs=require('node:fs/promises');
const {createWriteStream}=require('node:fs');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const path=require('node:path');
const relay=require('./obs-relay-client');
async function transfer(row,{LiveRecording,uploadRecordingPart,prepareRecordingFiles,DEFAULT_LIMIT}) {
 const claimed=await LiveRecording.findOneAndUpdate({_id:row._id,deletedAt:null,status:{$in:['waiting','recording','upload_failed','processing']},leaseUntil:{$lt:new Date()}},{$set:{status:'processing',leaseUntil:new Date(Date.now()+15*60*1000)}},{new:true});
 if(!claimed)return;
 let directory;
 try {
  const state=await relay.request(relay.sessionRoute(row.roomName),{allowMissing:true});
  if(!state){
   const preparing=Date.now()-claimed.createdAt.getTime()<120000;
   await LiveRecording.updateOne({_id:row._id},{$set:{status:preparing?'waiting':'not_recorded',error:preparing?'':'This OBS connection ended before a recording was created.',leaseUntil:new Date(0)}});return;
  }
  let parts=Array.from(claimed.parts || []),completed=Array.from(claimed.relaySegments || []);
  for(const segment of state.segments) {
   const route=relay.segmentRoute(row.roomName,segment.id);
   if(!completed.includes(segment.id)) {
    directory=await fs.mkdtemp('/var/tmp/echo-obs-recording-');await fs.chmod(directory,0o700);
    const filename=path.join(directory,'recording.mp4');
    const response=await relay.request(route,{raw:true});
    if(!(Number(response.headers.get('content-length'))>0) || Number(response.headers.get('content-length'))>2*1024*1024*1024)throw new Error('Invalid recording size');
    await pipeline(Readable.fromWeb(response.body),createWriteStream(filename,{mode:0o600}));
    const files=await prepareRecordingFiles(filename,directory,DEFAULT_LIMIT);
    const additions=[];
    for(let index=0;index<files.length;index++) {
     const file=files[index];const publicId=`Live/${row.roomName}/${segment.id.slice(0,-4)}/part-${String(index+1).padStart(3,'0')}`;
     const result=await uploadRecordingPart(file.filename,publicId);
     if(!result.public_id || !(result.bytes>0))throw new Error('Archive upload not confirmed');
     additions.push({publicId:result.public_id,delivery:'authenticated',bytes:result.bytes,duration:file.duration});
    }
    parts=parts.concat(additions);completed=completed.concat(segment.id);
    await LiveRecording.updateOne({_id:row._id},{$set:{parts,relaySegments:completed,publicId:parts[0].publicId,bytes:parts.reduce((n,p)=>n+p.bytes,0),duration:parts.reduce((n,p)=>n+p.duration,0)}});
    await fs.rm(directory,{recursive:true,force:true});directory=null;
   }
   await relay.request(route,{method:'DELETE',allowMissing:true});
  }
  const finished=state.state==='ended' && Date.now()-state.endedAt>15000;
  await LiveRecording.updateOne({_id:row._id},{$set:{status:finished?(parts.length?'ready':'not_recorded'):'recording',error:finished&&!parts.length?(state.error || 'This connection ended without a recording file.'):'',leaseUntil:new Date(0)}});
 }catch(error){
  await LiveRecording.updateOne({_id:row._id},{$set:{status:'upload_failed',error:'OVH recording transfer did not finish. The source is retained; retry from Live Archive.',leaseUntil:new Date(0),nextRetryAt:new Date(Date.now()+60000)},$inc:{attempts:1}});
  console.error('OVH recording transfer pending:',error.status || error.name);
 }finally{if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}
module.exports={transfer};
