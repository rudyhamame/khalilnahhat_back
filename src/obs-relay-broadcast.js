const {randomBytes}=require('node:crypto');
const relay=require('./obs-relay-client');
function createRelayBroadcast(deps) {
 const {LiveStreamConfig,getLiveStreamConfig,defaults,randomUUID,serialize}=deps;
 const owned=row=>({key:defaults.key,obsRoomName:row.obsRoomName,broadcastMode:'whep'});
 async function stop(row) {
  const ending=await LiveStreamConfig.findOneAndUpdate(owned(row),{isLive:false,obsState:'ending',streamUrl:'',statusLabel:defaults.statusLabel},{new:true});
  if(!ending)return getLiveStreamConfig();
  if(row.obsPortraitRoomName)await relay.request(relay.sessionRoute(row.obsPortraitRoomName),{method:'DELETE',allowMissing:true});
  await relay.request(relay.sessionRoute(row.obsRoomName),{method:'DELETE',allowMissing:true});
  return await LiveStreamConfig.findOneAndUpdate(owned(row),{isLive:false,audience:'all',audienceUserIds:[],webrtcRoomName:'',obsRoomName:'',obsPortraitRoomName:'',obsGoLive:true,obsIngressId:'',obsUrl:'',obsStreamKey:'',obsState:'',obsExpiresAt:null,streamUrl:'',statusLabel:defaults.statusLabel},{new:true}) || getLiveStreamConfig();
 }
 async function synchronize(row) {
  if(row.obsState==='ending')return stop(row);
  const status=await relay.request(relay.sessionRoute(row.obsRoomName),{allowMissing:true});
  if(!status && row.obsState==='preparing' && new Date(row.obsExpiresAt).getTime()>Date.now())return row;
  if(!status || status.state==='ended') {
   const cleared=await stop(row);
   return status?.error?Object.assign(cleared,{_obsRelayError:status.error}):cleared;
  }
  const portrait=row.obsPortraitRoomName?await relay.request(relay.sessionRoute(row.obsPortraitRoomName),{allowMissing:true}):null;
  if(portrait?.state==='ended')return stop(row);
  // OBS goes on air as soon as the relay receives media, including sessions prepared by older clients.
  // Preserve any explicit release gate for browser publishing.
  const flowing=status.state==='live'&&(!row.obsPortraitRoomName||portrait?.state==='live');
  const live=flowing&&(row.broadcastSource==='obs'||row.obsGoLive!==false);
  const updated=await LiveStreamConfig.findOneAndUpdate({...owned(row),obsState:{$in:['preparing','waiting','ready','live']}},
   {isLive:live,obsState:live?'live':flowing?'ready':'waiting',streamUrl:live?status.playbackUrl:'',statusLabel:live?'Live now — DJ Khalil is on air.':defaults.statusLabel},{new:true});
  if(updated&&(updated.audience||'all')==='all')await deps.notifyLiveTransition?.(row,updated);
  return updated || getLiveStreamConfig();
 }
 // OBS publishes over WHIP straight to the OVH relay: no LiveKit ingress (which is billed) is involved.
 async function prepare(req,res) {
  let claimed;
  try {
   const current=await getLiveStreamConfig();
   if(current.isLive || current.webrtcRoomName || current.obsRoomName)return res.status(409).json({message:'End the existing broadcast or OBS session first.'});
   await relay.request('health');
   const roomName=`khalil-obs-${randomUUID()}`;
   const title=(typeof req.body?.title==='string' && req.body.title.trim().slice(0,180)) || current.title || defaults.title;
   claimed=await LiveStreamConfig.findOneAndUpdate({key:defaults.key,isLive:{$ne:true},webrtcRoomName:{$in:['',null]},obsRoomName:{$in:['',null]}},
    {isLive:false,obsGoLive:true,obsSaveRecording:false,title,streamUrl:'',broadcastMode:'whep',broadcastSource:'obs',webrtcRoomName:'',obsRoomName:roomName,obsState:'preparing',obsExpiresAt:new Date(Date.now()+120000)},{new:true});
   if(!claimed)return res.status(409).json({message:'Another broadcaster started first.'});
   const saveRecording=false;
   const connection=await relay.request('sessions',{method:'POST',body:{id:roomName,publishToken:randomBytes(32).toString('hex'),saveRecording}});
   const updated=await LiveStreamConfig.findOneAndUpdate({...owned(claimed),obsState:'preparing'},
    {obsUrl:connection.server,obsStreamKey:connection.streamKey,obsState:'waiting',obsExpiresAt:new Date(connection.expiresAt)},{new:true});
   if(!updated)throw new Error('OBS setup was cancelled');
   return res.status(201).json({item:serialize(updated)});
  } catch(error) {
   if(claimed)await stop(claimed).catch(()=>{});
   console.error('OVH OBS prepare failed:',error.status || error.name);
   return res.status(error.status===409?409:503).json({message:error.status?error.message:'OVH OBS setup did not finish. Try again shortly.'});
  }
 }
 return {stop,synchronize,prepare};
}
module.exports={createRelayBroadcast};
