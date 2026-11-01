const {signViewer,verifyViewer}=require('../deploy/obs-relay/live-access.cjs');
const {sessionKey,memberName}=require('./live-interactions');
function registerLiveAccess(app,{requireAuth,getLiveStreamConfig,createToken,getConfig,relay=require('./obs-relay-client'),env=process.env}) {
 const playback=async(req,res)=>{
  res.set('Cache-Control','no-store');
  try {
   const current=await getLiveStreamConfig(),session=sessionKey(current);
   if(!session||req.body?.session!==session)return res.status(409).json({message:'The broadcast changed. Refresh before reconnecting.'});
   if(current.broadcastMode==='whep'&&current.obsRoomName&&relay.configured()) {
    // Construct the URL from trusted relay configuration, never from an arbitrary saved URL.
    const origin=new URL(env.ECHO_OBS_RELAY_URL);if(origin.protocol!=='https:')throw new Error('Invalid relay');
    return res.json({session,mode:'whep',url:origin.origin+'/live/'+encodeURIComponent(current.obsRoomName)+'/whep',token:signViewer(current.obsRoomName,req.authUser._id,env.ECHO_OBS_RELAY_TOKEN)});
   }
   if(current.broadcastMode!=='webrtc'||!current.webrtcRoomName)return res.status(409).json({message:'This source does not support members-only playback. Use OBS or browser broadcasting.'});
   const token=await createToken({roomName:current.webrtcRoomName,identity:`member-${req.authUser._id}-${require('node:crypto').randomUUID()}`,name:memberName(req.authUser),canPublish:false});
   return res.json({session,mode:'webrtc',token,url:getConfig().wsUrl,roomName:current.webrtcRoomName});
  }catch{return res.status(503).json({message:'Live playback is temporarily unavailable. Please reconnect.'});}
 };
 app.post('/api/live-stream/playback',requireAuth,playback);
 // Keep old clients behind the identical authentication and session boundary.
 app.post('/api/live-stream/webrtc/viewer-token',requireAuth,playback);
}
module.exports={signViewer,verifyViewer,registerLiveAccess};
