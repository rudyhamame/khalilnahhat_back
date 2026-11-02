const crypto=require('node:crypto');
const mongoose=require('mongoose');
const {EgressClient}=require('livekit-server-sdk');
const {StreamOutput,StreamProtocol,EncodingOptions,VideoCodec,AudioCodec}=require('@livekit/protocol');
const platforms=['youtube','instagram'];
const active=['starting','live','stopping'];
const schema=new mongoose.Schema({platform:{type:String,enum:platforms,unique:true,required:true},serverUrl:String,secret:{type:String,select:false},roomName:{type:String,default:''},jobId:{type:String,default:''},state:{type:String,default:'idle'},operation:String,error:{type:String,default:''}},{timestamps:true});
const Destination=mongoose.models.LiveDestination||mongoose.model('LiveDestination',schema);
const failure=(status,message)=>Object.assign(new Error(message),{status});
function encryptionKey(env){const value=env.ECHO_STREAM_DESTINATION_KEY||'';if(!/^[a-f0-9]{64}$/i.test(value))throw failure(503,'Configure ECHO_STREAM_DESTINATION_KEY as a private 64-character hexadecimal key on the API server.');return Buffer.from(value,'hex');}
function seal(value,env){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(env),iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),data].map(x=>x.toString('base64')).join('.');}
function unseal(value,env){const [iv,tag,data]=value.split('.').map(x=>Buffer.from(x,'base64'));const cipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(env),iv);cipher.setAuthTag(tag);return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');}
function validate(platform,body){
 if(!platforms.includes(platform))throw failure(404,'Unknown streaming destination.');
 const hosts=platform==='youtube'?['a.rtmps.youtube.com','b.rtmps.youtube.com']:['live-upload.instagram.com'];
 let url;try{url=new URL(body.serverUrl);}catch{throw failure(400,'Enter the platform’s RTMPS server URL without its stream key.');}
 if(url.protocol!=='rtmps:'||!hosts.includes(url.hostname)||url.username||url.password||url.search||url.hash||(url.port&&url.port!=='443')||url.pathname.replace(/\/$/,'')!==(platform==='youtube'?'/live2':'/rtmp'))throw failure(400,'Use the supported secure platform server URL, with no key or query in the URL.');
 if(typeof body.streamKey!=='string'||!body.streamKey.trim()||body.streamKey.length>2048||/[\s#]/.test(body.streamKey)||body.streamKey.includes('://'))throw failure(400,'Enter a valid stream key separately.');
 return {serverUrl:url.href.replace(/\/$/,''),streamKey:body.streamKey};
}
function view(row){return {platform:row.platform,serverUrl:row.serverUrl||'',configured:Boolean(row.secret),roomName:row.roomName||'',state:row.state||'idle',error:row.error||'',updatedAt:row.updatedAt||null,format:row.platform==='instagram'?'720 × 1280 portrait':'1280 × 720 landscape'};}
function createDestinationService({Model=Destination,getLiveStreamConfig,env=process.env,client=()=>new EgressClient(env.LIVEKIT_URL,env.LIVEKIT_API_KEY,env.LIVEKIT_API_SECRET)}={}){
 const read=platform=>Model.findOne({platform}).select('+secret');
 const change=(row,patch)=>Model.findOneAndUpdate({_id:row._id,operation:row.operation,state:row.state},{$set:patch},{new:true}).select('+secret');
 const outputUrl=row=>row.serverUrl+'/'+unseal(row.secret,env);
 const jobs=async row=>(await client().listEgress({roomName:row.roomName}));
 async function refresh(row){
  if(!active.includes(row.state))return row;
  try{
   const list=await jobs(row),job=list.find(x=>row.jobId?x.egressId===row.jobId:x.streamResults?.some(s=>s.url===outputUrl(row)));
   if(!job){
    // A timed-out start is ambiguous: retain the reservation until it can be reconciled.
    const current=await getLiveStreamConfig();
    if(current.webrtcRoomName===row.roomName&&current.isLive)return change(row,{error:'Output not yet confirmed. Refresh status. End this Echo session to clear an uncertain start safely.'});
    return change(row,{state:'ended',error:''});
   }
   const live=await getLiveStreamConfig();
   if(row.state==='stopping'||!live.isLive||live.webrtcRoomName!==row.roomName){
    if([0,1,2].includes(Number(job.status)))await client().stopEgress(job.egressId);
    return change(row,{jobId:job.egressId,state:[0,1,2].includes(Number(job.status))?'stopping':'ended',error:''});
   }
   const status=Number(job.status),state=status===1?'live':status===0?'starting':status===2?'stopping':[4,5,6].includes(status)?'failed':'ended';
   return change(row,{jobId:job.egressId,state,error:state==='failed'?'The platform output failed. Check its key and platform dashboard.':''});
  }catch{return change(row,{error:'Destination status unavailable. Refresh before retrying; Echo playback is separate.'});}
 }
 async function list(){const items=[];for(const platform of platforms){let row=await read(platform);if(row)row=await refresh(row)||row;items.push(row?view(row):view({platform}));}return {items,ready:Boolean(env.LIVEKIT_URL&&env.LIVEKIT_API_KEY&&env.LIVEKIT_API_SECRET&&/^[a-f0-9]{64}$/i.test(env.ECHO_STREAM_DESTINATION_KEY||''))};}
 async function save(platform,body){const value=validate(platform,body),secret=seal(value.streamKey,env);const previous=await read(platform);if(previous&&active.includes(previous.state))throw failure(409,'Stop this destination before replacing its settings.');
  try{const row=await Model.findOneAndUpdate({platform,state:{$nin:active}},{$set:{serverUrl:value.serverUrl,secret,state:'idle',error:'',operation:crypto.randomUUID(),jobId:'',roomName:''}},{upsert:!previous,new:true}).select('+secret');if(!row)throw failure(409,'Destination changed. Refresh its status.');return view(row);}catch(e){if(e.code===11000)throw failure(409,'Destination changed. Refresh its status.');throw e;}
 }
 async function start(platform,roomName){
  const live=await getLiveStreamConfig();if(!live.isLive||live.broadcastMode!=='webrtc'||!roomName||live.webrtcRoomName!==roomName)throw failure(409,'Start the browser or Android live stream first. OBS relay output is not supported by these destinations.');
  if(!env.LIVEKIT_URL||!env.LIVEKIT_API_KEY||!env.LIVEKIT_API_SECRET)throw failure(503,'Configure LiveKit on the API server.');
  let row=await read(platform);if(!row?.secret)throw failure(409,'Save this destination’s server URL and stream key first.');
  const url=outputUrl(row),operation=crypto.randomUUID();
  row=await Model.findOneAndUpdate({_id:row._id,state:{$nin:active}},{$set:{state:'starting',operation,roomName,jobId:'',error:''}},{new:true}).select('+secret');if(!row)throw failure(409,'This destination is already active or awaiting reconciliation.');
  try{
   const portrait=platform==='instagram';
   const job=await client().startRoomCompositeEgress(roomName,{stream:new StreamOutput({protocol:StreamProtocol.RTMP,urls:[url]})},{layout:'single-speaker',encodingOptions:new EncodingOptions({width:portrait?720:1280,height:portrait?1280:720,framerate:30,videoCodec:VideoCodec.H264_BASELINE,videoBitrate:2500,audioCodec:AudioCodec.AAC,audioBitrate:128,audioFrequency:48000,keyFrameInterval:2})});
   await change(row,{jobId:job.egressId});row={...row.toObject?.()||row,jobId:job.egressId};
   return view(await refresh(row)||row);
  }catch(error){
   if([400,401,403,404,422,429].includes(error.status)){await change(row,{state:'failed',error:'The media service rejected this output. Check its configuration and platform key.'});throw failure(503,'The media service rejected this output. Check its configuration and platform key.');}
   // Never echo provider errors: they can contain a destination URL and its key.
   await change(row,{error:'Start could not be confirmed. Refresh status to reconcile it before retrying.'});
   throw failure(503,'Start could not be confirmed. Refresh this destination before retrying.');
  }
 }
 async function stop(platform,roomName){let row=await read(platform);if(!row||row.roomName!==roomName)throw failure(409,'This destination session has changed. Refresh before stopping it.');if(!active.includes(row.state))return view(row);
  row=await change(row,{state:'stopping',error:''});if(!row)throw failure(409,'Destination changed. Refresh its status.');return view(await refresh(row)||row);
 }
 let sweeping=false;
 async function sweep(){if(sweeping)return;sweeping=true;try{for(const platform of platforms){const row=await read(platform);if(row)await refresh(row);}}finally{sweeping=false;}}
 return {list,save,start,stop,sweep};
}
function registerLiveDestinations(app,{requireAdmin,getLiveStreamConfig,service=createDestinationService({getLiveStreamConfig}),startWorker=true}){
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await fn(req));}catch(e){res.status(e.status||503).json({message:e.status?e.message:'Streaming destinations are temporarily unavailable.'});}};
 app.get('/api/admin/live-destinations',requireAdmin,wrap(()=>service.list()));
 for(const platform of platforms){
  app.put('/api/admin/live-destinations/'+platform,requireAdmin,wrap(async req=>({item:await service.save(platform,req.body||{})})));
  for(const action of ['start','stop'])app.post('/api/admin/live-destinations/'+platform+'/'+action,requireAdmin,wrap(async req=>({item:await service[action](platform,req.body?.roomName)})));
 }
 if(startWorker){const timer=setInterval(()=>service.sweep().catch(()=>{}),15000);timer.unref?.();}
 return service;
}
module.exports={Destination,validate,seal,unseal,view,createDestinationService,registerLiveDestinations};
