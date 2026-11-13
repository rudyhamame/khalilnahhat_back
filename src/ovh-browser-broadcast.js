const {randomBytes}=require('node:crypto');
const defaultRelay=require('./obs-relay-client');
// The browser sends one H.264/Opus stream directly to OVH. MediaMTX forwards it
// and packages the same encoded tracks into private recording segments.
function registerOvhBrowserRoutes(app,deps,legacy,{relay=defaultRelay,env=process.env,Recording}={}){
 const {requireAdmin,getLiveStreamConfig,LiveStreamConfig,defaults,serialize,randomUUID}=deps;
 const enabled=()=>env.ECHO_BROWSER_TRANSPORT==='ovh'&&relay.configured();
 const active=row=>row.broadcastSource==='browser'&&row.broadcastMode==='whep'&&row.obsRoomName;
 const records=()=>Recording||require('./live-recordings').LiveRecording;
 const responseFor=async row=>({item:serialize(row),transport:'ovh',roomName:row.obsRoomName,url:new URL(`/live/${row.obsRoomName}/whip`,env.ECHO_OBS_RELAY_URL).href,token:row.obsStreamKey,
  recording:row.obsSaveRecording!==false?{id:String((await records().findOne({roomName:row.obsRoomName,deletedAt:null}))?._id||''),mode:'ovh'}:{mode:'none'}});
 app.post('/api/live-stream/webrtc/go-live',requireAdmin,async(req,res,next)=>{
  if(req.body?.transport!=='ovh')return next();
  res.set?.('Cache-Control','no-store');
  if(!enabled())return res.status(503).json({message:'OVH browser publishing is not enabled.'});
  let claimed;
  try{
   const current=await getLiveStreamConfig();
   if(current.isLive||current.webrtcRoomName||current.obsRoomName)return res.status(409).json({message:'End the current live before starting another.'});
   const id=`khalil-obs-${randomUUID()}`,publishToken=randomBytes(32).toString('hex'),saveRecording=req.body.saveRecording!==false,title=String(req.body.title||current.title||defaults.title).trim().slice(0,180);
   if(saveRecording&&!env.CLOUDINARY_API_SECRET)throw Object.assign(new Error('Private recording archive is not configured.'),{status:503});
   await relay.request('health');
   claimed=await LiveStreamConfig.findOneAndUpdate({key:defaults.key,isLive:{$ne:true},webrtcRoomName:{$in:['',null]},obsRoomName:{$in:['',null]}},{isLive:false,title,broadcastMode:'whep',broadcastSource:'browser',webrtcRoomName:id,obsRoomName:id,obsStreamKey:publishToken,obsUrl:'',obsState:'preparing',obsSaveRecording:saveRecording,obsExpiresAt:new Date(Date.now()+120000),streamUrl:'',statusLabel:'Connecting browser…'},{new:true});
   if(!claimed)return res.status(409).json({message:'Another source started first.'});
   await relay.request('sessions',{method:'POST',body:{id,publishToken,saveRecording}});
   if(saveRecording)await records().create({roomName:id,title,provider:'ovh',captureState:'waiting'});
   return res.status(201).json(await responseFor(claimed));
  }catch(error){
   // Do not release ownership until publishing credentials have been revoked.
   if(claimed)try{await legacy.stop(claimed);}catch{/* The synchronizer retains and retries the reservation. */}
   return res.status(error.status===409?409:503).json({message:error.status?error.message:'OVH could not prepare the broadcast. No browser recording was started.'});
  }
 });
 app.post('/api/live-stream/webrtc/ready',requireAdmin,async(req,res,next)=>{
  const current=await getLiveStreamConfig();if(!active(current))return next();
  res.set?.('Cache-Control','no-store');
  if(req.body?.roomName!==current.obsRoomName)return res.status(409).json({message:'This browser connection has been replaced.'});
  try{
   let status;
   for(let attempt=0;attempt<20;attempt++){
    status=await relay.request(relay.sessionRoute(current.obsRoomName));
    if(status.state==='live')break;
    if(status.state==='ended')throw new Error('OVH rejected the media codec or the source stopped.');
    await new Promise(resolve=>setTimeout(resolve,250));
   }
   if(status.state!=='live')throw new Error('OVH has not received the live media.');
   if(current.obsSaveRecording!==false&&status.saveRecording===false)throw new Error('OVH recording did not start.');
   const updated=await legacy.synchronize();return res.json({item:serialize(updated)});
  }catch(error){return res.status(503).json({message:error.message||'OVH could not confirm the live media.'});}
 });
 app.post('/api/live-stream/webrtc/end',requireAdmin,async(req,res,next)=>{
  const current=await getLiveStreamConfig();if(!active(current))return next();
  res.set?.('Cache-Control','no-store');
  if(req.body?.roomName!==current.obsRoomName)return res.json({item:serialize(current),ended:false});
  try{return res.json({item:serialize(await legacy.stop(current)),ended:true});}
  catch{return res.status(503).json({message:'OVH could not disconnect the live. Retry ending this session.'});}
 });
 app.post('/api/live-stream/webrtc/resume',requireAdmin,async(_req,res,next)=>{
  const current=await getLiveStreamConfig();if(!active(current))return next();
  res.set?.('Cache-Control','no-store');
  try{return res.json(await responseFor(current));}catch{return res.status(503).json({message:'OVH could not restore this session.'});}
 });
}
module.exports={registerOvhBrowserRoutes};
