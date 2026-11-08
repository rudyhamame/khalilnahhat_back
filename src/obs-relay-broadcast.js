const relay=require('./obs-relay-client');
function createRelayBroadcast(deps) {
 const {LiveStreamConfig,getLiveStreamConfig,defaults}=deps;
 const owned=row=>({key:defaults.key,obsRoomName:row.obsRoomName,broadcastMode:'whep'});
 async function stop(row) {
  const ending=await LiveStreamConfig.findOneAndUpdate(owned(row),{isLive:false,obsState:'ending',streamUrl:'',statusLabel:defaults.statusLabel},{new:true});
  if(!ending)return getLiveStreamConfig();
  await relay.request(relay.sessionRoute(row.obsRoomName),{method:'DELETE',allowMissing:true});
  return await LiveStreamConfig.findOneAndUpdate(owned(row),{isLive:false,webrtcRoomName:'',obsRoomName:'',obsIngressId:'',obsUrl:'',obsStreamKey:'',obsState:'',obsExpiresAt:null,streamUrl:'',statusLabel:defaults.statusLabel},{new:true}) || getLiveStreamConfig();
 }
 async function synchronize(row) {
  if(row.obsState==='ending')return stop(row);
  const status=await relay.request(relay.sessionRoute(row.obsRoomName),{allowMissing:true});
  if(!status && row.obsState==='preparing' && new Date(row.obsExpiresAt).getTime()>Date.now())return row;
  if(!status || status.state==='ended') {
   const cleared=await stop(row);
   return status?.error?Object.assign(cleared,{_obsRelayError:status.error}):cleared;
  }
  const live=status.state==='live';
  const updated=await LiveStreamConfig.findOneAndUpdate({...owned(row),obsState:{$in:['preparing','waiting','live']}},
   {isLive:live,obsState:live?'live':'waiting',streamUrl:live?status.playbackUrl:'',statusLabel:live?'Live now — DJ Khalil is on air.':defaults.statusLabel},{new:true});
  if(updated)await deps.notifyLiveTransition?.(row,updated);
  return updated || getLiveStreamConfig();
 }
 // New relay connections are retired; retain legacy reconciliation and cleanup.
 return {stop,synchronize};
}
module.exports={createRelayBroadcast};
