// Atomic room ownership prevents a delayed phone stop from ending a newer broadcast.
function registerLiveBroadcastRoutes(app, deps) {
  const { requireAdmin, getLiveStreamConfig, LiveStreamConfig, defaults, createToken, getConfig, serialize, RoomServiceClient, randomUUID, verifyWebhook, serializePublic, prepareRecording } = deps;
  app.get('/api/live-stream', async (_request, response) => {
    try { return response.json({ item: serializePublic(await getLiveStreamConfig()) }); }
    catch { return response.status(503).json({ message: 'Live status is temporarily unavailable.' }); }
  });
  app.post('/api/live-stream/webrtc/webhook', async (request, response) => {
    let event;
    try { event = await verifyWebhook(request.rawBody, request.headers.authorization); }
    catch { return response.status(401).json({ message: 'Invalid webhook signature.' }); }
    const roomName = event.room?.name;
    const ended = event.event === 'room_finished' || (event.event === 'participant_left' && event.participant?.identity === 'khalil-broadcaster');
    if (!ended || !roomName) return response.json({ received: true });
    try {
      await LiveStreamConfig.findOneAndUpdate(
        { key: defaults.key, broadcastMode: 'webrtc', webrtcRoomName: roomName },
        { isLive: false, webrtcRoomName: '', statusLabel: defaults.statusLabel }, { new: true },
      );
      return response.json({ received: true });
    } catch { return response.status(503).json({ message: 'Could not update broadcast status.' }); }
  });
  app.post('/api/live-stream/webrtc/go-live', requireAdmin, async (request, response) => {
    try {
      const current = await getLiveStreamConfig();
      if (current.isLive) return response.status(409).json({ message: 'A broadcast is already live. End it before starting another.' });
      const roomName = `khalil-live-${randomUUID()}`;
      const config = getConfig();
      const token = await createToken({ roomName, identity: 'khalil-broadcaster', name: 'Khalil Nahhat', canPublish: true });
      const title = typeof request.body?.title === 'string' ? request.body.title.trim().slice(0, 180) : '';
      // getLiveStreamConfig creates the singleton first. Never upsert a conditional claim.
      const updated = await LiveStreamConfig.findOneAndUpdate(
        { key: defaults.key, isLive: { $ne: true } },
        { isLive: true, title: title || current.title || defaults.title, streamUrl: '',
          statusLabel: 'Live now — DJ Khalil is on air.', broadcastMode: 'webrtc', webrtcRoomName: roomName },
        { new: true },
      );
      if (!updated) return response.status(409).json({ message: 'Another broadcaster started first. Refresh your live status.' });
      if (prepareRecording) {
        try { await prepareRecording(roomName, title || current.title || defaults.title); }
        catch (error) {
          await LiveStreamConfig.findOneAndUpdate({ key: defaults.key, webrtcRoomName: roomName }, { isLive: false, webrtcRoomName: '', statusLabel: defaults.statusLabel }, { new: true });
          throw error;
        }
      }
      return response.status(201).json({ item: serialize(updated), token, url: config.wsUrl, roomName });
    } catch (error) {
      console.error('WebRTC go-live failed:', error.message);
      return response.status(error.status || 500).json({ message: error.status === 503 ? error.message : 'Could not start the broadcast.' });
    }
  });
  app.post('/api/live-stream/webrtc/end', requireAdmin, async (request, response) => {
    try {
      const current = await getLiveStreamConfig();
      const expected = request.body?.roomName;
      if (expected !== undefined && (typeof expected !== 'string' || !expected.trim())) return response.status(400).json({ message: 'A valid room name is required.' });
      if (expected && expected !== current.webrtcRoomName) return response.json({ item: serialize(current), ended: false });
      const updated = await LiveStreamConfig.findOneAndUpdate(
        { key: defaults.key, webrtcRoomName: current.webrtcRoomName || '' },
        { isLive: false, statusLabel: defaults.statusLabel, webrtcRoomName: '' }, { new: true },
      );
      if (!updated) return response.status(409).json({ message: 'The active broadcast changed. Refresh its status.' });
      if (current.webrtcRoomName) {
        try {
          const { apiKey, apiSecret, wsUrl } = getConfig();
          await new RoomServiceClient(wsUrl, apiKey, apiSecret).deleteRoom(current.webrtcRoomName);
        } catch (error) { console.error('Failed to close LiveKit room:', error.message); }
      }
      return response.json({ item: serialize(updated), ended: true });
    } catch (error) {
      console.error('WebRTC end failed:', error.message);
      return response.status(500).json({ message: 'Could not clear the broadcast status. Try again.' });
    }
  });
}
module.exports = { registerLiveBroadcastRoutes };
