const {randomBytes}=require('node:crypto');
const defaultRelay=require('./obs-relay-client');
const {captureOutputs,outputView}=require('./recording-outputs');
// The browser sends one H.264/Opus stream directly to OVH. MediaMTX forwards it
// and packages the same encoded tracks into private recording segments.
function registerOvhBrowserRoutes(app,deps,legacy,{relay=defaultRelay,env=process.env,Recording}={}){
 const {requireAdmin,getLiveStreamConfig,LiveStreamConfig,defaults,serialize,randomUUID}=deps;
 const enabled=()=>env.ECHO_BROWSER_TRANSPORT==='ovh'&&relay.configured();
 const active=row=>row.broadcastSource==='browser'&&row.broadcastMode==='whep'&&row.obsRoomName;
 const records=()=>Recording||require('./live-recordings').LiveRecording;
 const responseFor=async row=>{
  const recording=row.obsSaveRecording!==false?await records().findOne({roomName:row.obsRoomName,deletedAt:null}):null;
  return {item:serialize(row),transport:'ovh',roomName:row.obsRoomName,url:new URL(`/live/${row.obsRoomName}/whip`,env.ECHO_OBS_RELAY_URL).href,token:row.obsStreamKey,
   ...(row.obsPortraitRoomName?{portraitPublisher:{url:new URL(`/live/${row.obsPortraitRoomName}/whip`,env.ECHO_OBS_RELAY_URL).href,token:row.obsStreamKey}}:{}),
   recording:recording?{id:String(recording._id),mode:'ovh',outputs:recording.outputRecordings?.length?recording.outputRecordings.map(out=>({id:String(out.id),key:out.key,width:out.width,height:out.height})):[outputView(recording)]}:{mode:'none'}};
 };
 app.post('/api/live-stream/webrtc/go-live',requireAdmin,async(req,res,next)=>{
  if(req.body?.transport!=='ovh')return next();
  res.set?.('Cache-Control','no-store');
  if(!enabled())return res.status(503).json({message:'OVH browser publishing is not enabled.'});
  let claimed;
  try{
   const current=await getLiveStreamConfig();
   if(current.isLive||current.webrtcRoomName||current.obsRoomName)return res.status(409).json({message:'End the current live before starting another.'});
   const setList=await deps.prepareSetList?.(req.body?.setListId);
   const outputs=captureOutputs(req.body.outputs);
   const id=`khalil-obs-${randomUUID()}`,portraitId=outputs.length===2?`khalil-obs-${randomUUID()}`:'',publishToken=randomBytes(32).toString('hex'),saveRecording=req.body.saveRecording!==false,title=String(req.body.title||current.title||defaults.title).trim().slice(0,180);
   if(saveRecording&&!env.CLOUDINARY_API_SECRET)throw Object.assign(new Error('Private recording archive is not configured.'),{status:503});
   await relay.request('health');
   claimed=await LiveStreamConfig.findOneAndUpdate({key:defaults.key,isLive:{$ne:true},webrtcRoomName:{$in:['',null]},obsRoomName:{$in:['',null]}},{isLive:false,title,liveSetListId:setList?.id||'none',broadcastMode:'whep',broadcastSource:'browser',webrtcRoomName:id,obsRoomName:id,obsPortraitRoomName:portraitId,obsStreamKey:publishToken,obsUrl:'',obsState:'preparing',obsSaveRecording:saveRecording,obsExpiresAt:new Date(Date.now()+120000),streamUrl:'',statusLabel:'Connecting browser…'},{new:true});
   if(!claimed)return res.status(409).json({message:'Another source started first.'});
   await setList?.install(id);
   await relay.request('sessions',{method:'POST',body:{id,publishToken,saveRecording}});
   if(portraitId)await relay.request('sessions',{method:'POST',body:{id:portraitId,publishToken,saveRecording}});
   if(saveRecording){
    const main=await records().create({roomName:id,title,provider:'ovh',captureState:'waiting',outputKey:'main',width:outputs[0].width,height:outputs[0].height});
    if(portraitId){
     const child=await records().create({roomName:portraitId,title,provider:'ovh',captureState:'waiting',parentRecordingId:main._id,sessionRoomName:id,outputKey:'portrait',width:outputs[1].width,height:outputs[1].height});
     main.outputRecordings=[outputView(main),outputView(child)];await main.save();
    }
   }
   return res.status(201).json(await responseFor(claimed));
  }catch(error){
   // Do not release ownership until publishing credentials have been revoked.
   if(claimed)try{await legacy.stop(claimed);}catch{/* The synchronizer retains and retries the reservation. */}
   return res.status(error.status===400?400:error.status===409?409:503).json({message:error.status?error.message:'OVH could not prepare the broadcast. No browser recording was started.'});
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
    if(status.state==='live'){
     if(!current.obsPortraitRoomName)break;
     const portrait=await relay.request(relay.sessionRoute(current.obsPortraitRoomName));
     if(current.obsSaveRecording!==false&&portrait.saveRecording===false)throw new Error('The portrait camera recording did not start.');
     if(portrait.state==='live')break;
     if(portrait.state==='ended')throw new Error('The portrait camera disconnected.');
     status={state:'waiting'};
    }
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
