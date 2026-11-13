const fs=require('node:fs/promises');
const path=require('node:path');
async function cleanVerifiedRecordings({root,jobs,active,verify,files=fs}){
 const result={removed:0,preserved:0,failed:0};
 for(const entry of await files.readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
  if(!entry.isDirectory()||!entry.name.match(/^[a-f\d]{24}$/))continue;
  try{
   const outcome=await jobs.run(entry.name,async lease=>{
    const row=lease.row;
    if(row.provider!=='direct'||!['ready','partial'].includes(row.status)||!row.parts?.length||!row.sources?.length||row.sources.some(source=>!source.saved)||await active(row.roomName))return false;
    for(const part of row.parts)await verify(part);
    await lease.assert();
    await files.rm(path.join(root,entry.name),{recursive:true,force:true});
    await lease.save({sources:row.sources.map(source=>({...source.toObject?.()||source,cleaned:true})),cleanupPending:false});
    return true;
   });
   if(outcome===true)result.removed++;else result.preserved++;
  }catch{result.failed++;}
 }
 return result;
}
async function main(){
 const app=process.env.KHALIL_APP_ROOT||'/app';
 const {connectToDatabase}=require(path.join(app,'src/db'));
 const mongoose=require(path.join(app,'node_modules/mongoose'));
 const cloud=require(path.join(app,'node_modules/cloudinary')).v2;
 cloud.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET});
 await connectToDatabase();
 try{
  const {LiveRecording}=require(path.join(app,'src/live-recordings'));
  const {LiveStreamConfig}=require(path.join(app,'src/models'));
  const {recordingJobs}=require(path.join(app,'src/recording-jobs'));
  const result=await cleanVerifiedRecordings({root:process.env.ECHO_DIRECT_RECORDING_DIR||'/var/tmp/echo-direct-recordings',jobs:recordingJobs(LiveRecording),active:room=>LiveStreamConfig.exists({webrtcRoomName:room}),verify:async part=>{
   if(!part.publicId||!['authenticated','upload'].includes(part.delivery||'authenticated')||!(part.bytes>0))throw Error('Invalid archive manifest');
   const stored=await cloud.api.resource(part.publicId,{resource_type:'video',type:part.delivery||'authenticated'});
   if(stored.public_id!==part.publicId||stored.bytes!==part.bytes)throw Error('Archive verification failed');
  }});
  console.log('Recording maintenance:',JSON.stringify(result));
 }finally{await mongoose.disconnect();}
}
module.exports={cleanVerifiedRecordings};
if(!module.parent)main().catch(()=>{console.error('Recording maintenance failed; originals retained');process.exitCode=1;});
