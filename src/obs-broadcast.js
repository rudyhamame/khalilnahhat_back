// Each OBS connection owns one room, one recording and one revocable ingress key.
// Public serializers never receive connection secrets through this module.
const IDENTITY = 'khalil-obs';
function registerObsBroadcastRoutes(app, deps) {
  const { requireAdmin, getLiveStreamConfig, LiveStreamConfig, defaults, getConfig,
    serialize, IngressClient, RoomServiceClient, randomUUID, prepareRecording } = deps;
  const client = Class => { const c = getConfig(); return new Class(c.wsUrl, c.apiKey, c.apiSecret); };
  const filter = row => ({ key: defaults.key, obsRoomName: row.obsRoomName });
  const change = (row, values, extra = {}) => LiveStreamConfig.findOneAndUpdate({ ...filter(row), ...extra }, values, { new: true });
  const missing = error => error?.status === 404 || error?.code === 'not_found' || error?.code === 5;
  async function stop(row) {
    if (!row.obsRoomName) return row;
    const ending = await change(row, { isLive: false, obsState: 'ending', statusLabel: defaults.statusLabel });
    if (!ending) return getLiveStreamConfig();
    // Keep the reservation if revocation fails. The worker retries; no second broadcaster can steal it.
    if (ending.obsIngressId) {
      try { await client(IngressClient).deleteIngress(ending.obsIngressId); } catch (error) { if (!missing(error)) throw error; }
    }
    try { await client(RoomServiceClient).deleteRoom(ending.obsRoomName); } catch (error) { if (!missing(error)) throw error; }
    return await change(ending, { isLive: false, webrtcRoomName: '', obsRoomName: '', obsIngressId: '',
      obsUrl: '', obsStreamKey: '', obsState: '', obsExpiresAt: null, statusLabel: defaults.statusLabel }) || getLiveStreamConfig();
  }
  async function synchronize() {
    let row = await getLiveStreamConfig();
    if (!row.obsRoomName) return row;
    if (row.obsState === 'ending') return stop(row);
    if (!row.obsIngressId) {
      if (new Date(row.obsExpiresAt).getTime() <= Date.now()) return stop(row);
      return row;
    }
    let ingress;
    try { ingress = (await client(IngressClient).listIngress({ ingressId: row.obsIngressId }))[0]; }
    catch (error) { if (missing(error)) return stop(row); throw error; }
    if (!ingress || [3, 4].includes(ingress.state?.status)) return stop(row);
    if (ingress.state?.status === 2) {
      // The ingress endpoint can connect before tracks exist. Only published media makes the site live.
      let participants;
      try { participants = await client(RoomServiceClient).listParticipants(row.obsRoomName); }
      catch (error) { if (missing(error)) return stop(row); throw error; }
      const publishing = participants.some(p => p.identity === IDENTITY && p.tracks?.length);
      if (!publishing && (row.obsState === 'live' || new Date(row.obsExpiresAt).getTime() <= Date.now())) return stop(row);
      if (publishing && row.obsState !== 'live') {
        row = await change(row, { isLive: true, obsState: 'live', statusLabel: 'Live now — DJ Khalil is on air.' },
          { obsState: { $in: ['waiting', 'live'] } }) || await getLiveStreamConfig();
      }
      return row;
    }
    if (row.obsState === 'live' || new Date(row.obsExpiresAt).getTime() <= Date.now()) return stop(row);
    return row;
  }
  app.get('/api/live-stream/obs', requireAdmin, async (_req, res) => {
    res.set?.('Cache-Control', 'no-store');
    try { return res.json({ item: serialize(await synchronize()) }); }
    catch { return res.status(503).json({ message: 'Could not check OBS. Try again shortly.' }); }
  });
  app.post('/api/live-stream/obs/prepare', requireAdmin, async (req, res) => {
    res.set?.('Cache-Control', 'no-store');
    let claimed, ingress;
    try {
      getConfig();
      const current = await getLiveStreamConfig();
      if (current.isLive || current.obsRoomName) return res.status(409).json({ message: 'End the existing broadcast or OBS session first.' });
      const roomName = `khalil-obs-${randomUUID()}`;
      const title = (typeof req.body?.title === 'string' && req.body.title.trim().slice(0, 180)) || current.title || defaults.title;
      claimed = await LiveStreamConfig.findOneAndUpdate({ key: defaults.key, isLive: { $ne: true }, obsRoomName: { $in: ['', null] } },
        { isLive: false, title, streamUrl: '', broadcastMode: 'webrtc', broadcastSource: 'obs',
          webrtcRoomName: roomName, obsRoomName: roomName, obsState: 'preparing', obsExpiresAt: new Date(Date.now() + 120000) }, { new: true });
      if (!claimed) return res.status(409).json({ message: 'Another broadcaster started first.' });
      await prepareRecording(roomName, title);
      // RTMP_INPUT = 0. LiveKit Cloud supplies the actual RTMP endpoint and secret.
      ingress = await client(IngressClient).createIngress(0, { name: roomName, roomName, participantIdentity: IDENTITY,
        participantName: 'DJ Khalil · OBS', enableTranscoding: true });
      if (!ingress.ingressId || !ingress.url || !ingress.streamKey) throw new Error('Incomplete ingress');
      const updated = await change(claimed, { obsIngressId: ingress.ingressId, obsUrl: ingress.url,
        obsStreamKey: ingress.streamKey, obsState: 'waiting' }, { obsState: 'preparing' });
      if (!updated) throw new Error('OBS setup was cancelled');
      return res.status(201).json({ item: serialize(updated) });
    } catch (error) {
      if (claimed) {
        // Persist a created ingress before cleanup, so failed revocation remains retryable.
        if (ingress?.ingressId) {
          const saved = await change(claimed, { obsIngressId: ingress.ingressId, obsState: 'ending' });
          if (!saved) { try { await client(IngressClient).deleteIngress(ingress.ingressId); } catch { /* independently scoped orphan; never reuse */ } }
        }
        try { await stop(await getLiveStreamConfig().then(row => row.obsRoomName === claimed.obsRoomName ? row : { obsRoomName: '' })); } catch { /* retry by worker */ }
      }
      return res.status(503).json({ message: error.status === 503 ? error.message : 'OBS setup did not finish. Retry shortly.' });
    }
  });
  app.post('/api/live-stream/obs/end', requireAdmin, async (req, res) => {
    res.set?.('Cache-Control', 'no-store');
    if (typeof req.body?.roomName !== 'string' || !req.body.roomName) return res.status(400).json({ message: 'The OBS session is required.' });
    try {
      const current = await getLiveStreamConfig();
      if (req.body.roomName !== current.obsRoomName) return res.json({ item: serialize(current), ended: false });
      return res.json({ item: serialize(await stop(current)), ended: true });
    } catch { return res.status(503).json({ message: 'OBS is stopping. Connection revocation will retry automatically.' }); }
  });
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await synchronize(); } catch { /* retain last status on transient API failure */ } finally { busy = false; } };
  const timer = deps.disableObsTimer ? null : setInterval(tick, 10000);
  timer?.unref();
  return {
    synchronize, stop,
    async webhook(event) {
      const name = event.room?.name || event.ingressInfo?.roomName;
      if (!name?.startsWith('khalil-obs-')) return false;
      const current = await getLiveStreamConfig();
      if (current.obsRoomName !== name) return true;
      // Read authoritative current media state; delayed start/end events cannot overwrite it.
      await synchronize();
      return true;
    },
  };
}
module.exports = { registerObsBroadcastRoutes };
