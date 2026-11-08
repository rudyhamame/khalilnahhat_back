// OBS is retired. Keep legacy session reconciliation and key revocation for cleanup.
// Public serializers never receive connection secrets through this module.
const IDENTITY = 'khalil-obs';
function registerObsBroadcastRoutes(app, deps) {
  const { requireAdmin, getLiveStreamConfig, LiveStreamConfig, defaults, getConfig,
    serialize, IngressClient, RoomServiceClient, ensureRecording } = deps;
  const relay = require('./obs-relay-broadcast').createRelayBroadcast(deps);
  const client = Class => { const c = getConfig(); return new Class(c.wsUrl, c.apiKey, c.apiSecret); };
  const filter = row => ({ key: defaults.key, obsRoomName: row.obsRoomName });
  const change = async (row, values, extra = {}) => {
    const updated=await LiveStreamConfig.findOneAndUpdate({ ...filter(row), ...extra }, values, { new: true });
    if(updated)await deps.notifyLiveTransition?.(row,updated);
    return updated;
  };
  const missing = error => error?.status === 404 || error?.code === 'not_found' || error?.code === 5;
  async function stop(row) {
    if (!row.obsRoomName) return row;
    if (row.broadcastMode === 'whep') return relay.stop(row);
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
    if (row.broadcastMode === 'whep') return relay.synchronize(row);
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
      // Media is flowing: make sure it is being recorded even if LiveKit recreated the room after it timed out empty.
      if (publishing && row.obsSaveRecording !== false) Promise.resolve(ensureRecording?.(row.obsRoomName)).catch(() => {});
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
    try { const row=await synchronize();const item=serialize(row);if(deps.recordingStatus)item.recording=await deps.recordingStatus(row.obsRoomName||row.webrtcRoomName);return res.json({item}); }
    catch { return res.status(503).json({ message: 'Could not check OBS. Try again shortly.' }); }
  });
  const discontinued = (_req, res) => {
    res.set?.('Cache-Control', 'no-store');
    return res.status(410).json({ code: 'OBS_DISCONTINUED', message: 'OBS broadcasting has been discontinued. Use Echo browser studio or the Android app.' });
  };
  app.patch('/api/live-stream/obs/recording', requireAdmin, discontinued);
  app.post('/api/live-stream/obs/prepare', requireAdmin, discontinued);
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
