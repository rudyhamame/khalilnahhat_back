const STALE_RESERVATION_MS = 90000, RECONCILE_AFTER_MS = 120000;
// Atomic room ownership prevents a delayed phone stop from ending a newer broadcast.
const { audienceFromBody } = require('./live-audience');
function registerLiveBroadcastRoutes(app, deps) {
  const { requireAdmin, getLiveStreamConfig, LiveStreamConfig, defaults, createToken, getConfig, serialize, RoomServiceClient, randomUUID, verifyWebhook, serializePublic } = deps;
  const obs = deps.IngressClient ? require('./obs-broadcast').registerObsBroadcastRoutes(app, deps) : null;
  if(obs)require('./ovh-browser-broadcast').registerOvhBrowserRoutes(app,deps,obs);
  // Missed room_finished webhook (deploy, outage): the site must not stay "live" for a room LiveKit no longer has.
  // Only a definitive "room is gone" answer clears it; any error keeps the status.
  async function reconcile() {
    const current = await getLiveStreamConfig(), room = current.webrtcRoomName;
    if (!room || current.obsRoomName || !current.updatedAt || Date.now() - new Date(current.updatedAt) < RECONCILE_AFTER_MS) return false;
    const { wsUrl, apiKey, apiSecret } = getConfig();
    if ((await new RoomServiceClient(wsUrl, apiKey, apiSecret).listRooms([room])).length) return false;
    return Boolean(await LiveStreamConfig.findOneAndUpdate({ key: defaults.key, broadcastMode: 'webrtc', webrtcRoomName: room }, { isLive: false, webrtcRoomName: '', statusLabel: defaults.statusLabel }, { new: true }));
  }
  if (!deps.disableLiveReconcile) { const timer = setInterval(() => reconcile().catch(() => {}), 30000); timer.unref?.(); }
  app.get('/api/live-stream', async (request, response) => {
    try {
      const config = await getLiveStreamConfig(), restricted = config.audience && config.audience !== 'all';
      if (restricted) response.set('Cache-Control', 'no-store');
      return response.json({ item: serializePublic(config, restricted ? await deps.authFromRequest?.(request).catch(() => null) : null) });
    }
    catch { return response.status(503).json({ message: 'Live status is temporarily unavailable.' }); }
  });
  app.post('/api/live-stream/webrtc/webhook', async (request, response) => {
    let event;
    try { event = await verifyWebhook(request.rawBody, request.headers.authorization); }
    catch { return response.status(401).json({ message: 'Invalid webhook signature.' }); }
    try { if (obs && await obs.webhook(event)) return response.json({ received: true }); }
    catch { return response.status(503).json({ message: 'Could not update OBS status.' }); }
    const roomName = event.room?.name;
    // A browser refresh briefly removes the publisher. Keep the reservation
    // until LiveKit closes the empty room so the dashboard can reconnect it.
    const ended = event.event === 'room_finished';
    if (!ended || !roomName) return response.json({ received: true });
    try {
      await LiveStreamConfig.findOneAndUpdate(
        { key: defaults.key, broadcastMode: 'webrtc', webrtcRoomName: roomName },
        { isLive: false, webrtcRoomName: '', statusLabel: defaults.statusLabel }, { new: true },
      );
      return response.json({ received: true });
    } catch { return response.status(503).json({ message: 'Could not update live stream status.' }); }
  });
  app.post('/api/live-stream/webrtc/go-live', requireAdmin, async (request, response) => {
    try {
      const current = await getLiveStreamConfig();
      // A reservation that never went on air is dead once its 60s expiry is past, even if the timer died with a server restart.
      const stale = !current.isLive && current.webrtcRoomName && !current.obsRoomName && current.updatedAt && Date.now() - new Date(current.updatedAt) > STALE_RESERVATION_MS;
      if ((current.isLive || current.webrtcRoomName || current.obsRoomName) && !stale) return response.status(409).json({ message: 'A live stream is already active. End it before starting another.' });
      const setList=await deps.prepareSetList?.(request.body?.setListId);
      if (stale) await new RoomServiceClient(getConfig().wsUrl, getConfig().apiKey, getConfig().apiSecret).deleteRoom(current.webrtcRoomName).catch(() => {});
      const roomName = `khalil-live-${randomUUID()}`;
      const config = getConfig();
      const token = await createToken({ roomName, identity: 'khalil-broadcaster', name: 'Khalil Nahhat', canPublish: true });
      const source = request.body?.source === 'android' ? 'android' : 'browser';
      const title = typeof request.body?.title === 'string' ? request.body.title.trim().slice(0, 180) : '';
      // getLiveStreamConfig creates the singleton first. Never upsert a conditional claim.
      const updated = await LiveStreamConfig.findOneAndUpdate(
        { key: defaults.key, isLive: { $ne: true }, webrtcRoomName: stale ? current.webrtcRoomName : { $in: ['', null] }, obsRoomName: { $in: ['', null] } },
        { isLive: false, title: title || current.title || defaults.title, streamUrl: '',
          statusLabel: 'Connecting browser…', broadcastMode: 'webrtc', broadcastSource: source, webrtcRoomName: roomName, ...audienceFromBody(request.body), liveSetListId:setList?.id||'none' },
        { new: true },
      );
      if (!updated) return response.status(409).json({ message: 'Another source started first. Refresh your live status.' });
      try{await setList?.install(roomName);}catch(error){
        await LiveStreamConfig.findOneAndUpdate({key:defaults.key,webrtcRoomName:roomName},{isLive:false,webrtcRoomName:'',statusLabel:defaults.statusLabel},{new:true});
        throw Object.assign(new Error('Could not prepare the selected set list. No live was started.'),{status:503});
      }
      const expiry = setTimeout(async () => {
        try {
          const expired = await LiveStreamConfig.findOneAndUpdate({key:defaults.key,webrtcRoomName:roomName,isLive:false}, {webrtcRoomName:'',statusLabel:defaults.statusLabel},{new:true});
          if(expired) await new RoomServiceClient(config.wsUrl,config.apiKey,config.apiSecret).deleteRoom(roomName);
        } catch { /* The exact-room webhook can still reconcile a disconnected publisher. */ }
      },60000); expiry.unref?.();
      return response.status(201).json({ serverTime:Date.now(),item: serialize(updated), token, url: config.wsUrl, roomName,recording:{mode:'none'} });
    } catch (error) {
      console.error('WebRTC go-live failed:', error.message);
      const status = error.status || 500;
      const actionable = [400,409,503,507].includes(status);
      return response.status(status).json({ message: actionable ? error.message : 'Could not start the live stream.' });
    }
  });
  app.post('/api/live-stream/webrtc/ready', requireAdmin, async (request,response) => {
    try {
      const current=await getLiveStreamConfig(),roomName=request.body?.roomName;
      if(!roomName||roomName!==current.webrtcRoomName||!['browser','android'].includes(current.broadcastSource)||current.obsRoomName)return response.status(409).json({message:'This browser connection has been replaced.'});
      const {wsUrl,apiKey,apiSecret}=getConfig();
      const client=new RoomServiceClient(wsUrl,apiKey,apiSecret);
      let mediaReady=false;
      for(let attempt=0;attempt<3;attempt++){
        const participants=await client.listParticipants(roomName);
        mediaReady=participants.some(row=>row.identity==='khalil-broadcaster'&&row.tracks?.length);
        if(mediaReady)break;
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!mediaReady)return response.status(409).json({message:'Publish a camera or microphone before going on air.'});
      const updated=await LiveStreamConfig.findOneAndUpdate({key:defaults.key,webrtcRoomName:roomName,broadcastSource:current.broadcastSource}, {isLive:true,statusLabel:'Live now — DJ Khalil is on air.'},{new:true});
      if(!updated)return response.status(409).json({message:'The live stream changed.'});
      if((updated.audience||'all')==='all')await deps.notifyLiveTransition?.(current,updated);
      return response.json({item:serialize(updated)});
    }catch{return response.status(503).json({message:'Could not confirm the browser live stream. Retry its status.'});}
  });
  app.post('/api/live-stream/webrtc/resume', requireAdmin, async (_request,response)=>{
    try{
      const current=await getLiveStreamConfig();
      if(!current.isLive||!current.webrtcRoomName||current.broadcastSource!=='browser'||current.obsRoomName)return response.status(409).json({message:'There is no browser live stream to reconnect.'});
      const config=getConfig(),token=await createToken({roomName:current.webrtcRoomName,identity:'khalil-broadcaster',name:'Khalil Nahhat',canPublish:true});
      return response.json({serverTime:Date.now(),item:serialize(current),token,url:config.wsUrl,roomName:current.webrtcRoomName,recording:{mode:'none'}});
    }catch(error){console.error('WebRTC resume failed:',error.message);return response.status(503).json({message:'Could not reconnect this browser to the live stream.'});}
  });
  app.post('/api/live-stream/webrtc/end', requireAdmin, async (request, response) => {
    try {
      const current = await getLiveStreamConfig();
      if (current.obsRoomName) return response.status(409).json({ message: 'End this broadcast using the OBS controls.' });
      const expected = request.body?.roomName;
      if (typeof expected !== 'string' || !expected.trim()) return response.status(400).json({ message: 'A valid room name is required.' });
      if (expected && expected !== current.webrtcRoomName) return response.json({ item: serialize(current), ended: false });
      // Revoke media before releasing its reservation. A failed remote stop remains retryable.
      if (current.webrtcRoomName) {
        try {
          const { apiKey, apiSecret, wsUrl } = getConfig();
          await new RoomServiceClient(wsUrl, apiKey, apiSecret).deleteRoom(current.webrtcRoomName);
        } catch (error) {
          if (!['not_found','NOT_FOUND'].includes(error.code) && error.status !== 404) return response.status(503).json({message:'Media could not be disconnected. Retry ending this broadcast.'});
        }
      }
      const updated = await LiveStreamConfig.findOneAndUpdate(
        { key: defaults.key, webrtcRoomName: current.webrtcRoomName || '' },
        { isLive: false, statusLabel: defaults.statusLabel, webrtcRoomName: '', audience: 'all', audienceUserIds: [] }, { new: true },
      );
      if (!updated) {
        const latest=await getLiveStreamConfig();
        if(latest.webrtcRoomName!==expected)return response.json({item:serialize(latest),ended:true});
        return response.status(409).json({message:'The broadcast state changed. Refresh before retrying.'});
      }
      return response.json({ item: serialize(updated), ended: true });
    } catch (error) {
      console.error('WebRTC end failed:', error.message);
      return response.status(500).json({ message: 'Could not clear the broadcast status. Try again.' });
    }
  });
  return { reconcile };
}
module.exports = { registerLiveBroadcastRoutes };
