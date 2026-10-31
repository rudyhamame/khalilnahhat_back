const mongoose = require('mongoose');
// Online meeting room between the booked client and Khalil: WebRTC calls (voice/video) plus text chat.
// Signalling and chat go through this server by polling; the media itself flows peer to peer.
const MINUTE = 60 * 1000;
const rooms = new Map();
const MAX_MESSAGES = 300, MAX_SIGNALS = 400, ROOM_IDLE_MS = 6 * 60 * MINUTE;

const roomOf = id => {
  let room = rooms.get(id);
  if (!room) { room = { signals: { host: [], guest: [] }, messages: [], seen: { host: 0, guest: 0 }, seq: 0, touched: Date.now() }; rooms.set(id, room); }
  room.touched = Date.now();
  if (rooms.size > 500) for (const [key, value] of rooms) if (Date.now() - value.touched > ROOM_IDLE_MS) rooms.delete(key);
  return room;
};
const iceServers = (env = process.env) => {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const urls = String(env.MEETING_TURN_URLS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (urls.length && env.MEETING_TURN_USERNAME && env.MEETING_TURN_CREDENTIAL) servers.push({ urls, username: env.MEETING_TURN_USERNAME, credential: env.MEETING_TURN_CREDENTIAL });
  return servers;
};

function registerMeetingRoom(app, { requireAuth, Meeting, env = process.env, now = Date.now }) {
  // Only the client who booked an online meeting, or an admin, may enter; clients from 30 minutes before the start until an hour after the end.
  async function access(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ message: 'Meeting not found.' }); return null; }
    const meeting = await Meeting.findById(req.params.id);
    const user = req.authUser, admin = Boolean(user.isAdmin);
    if (!meeting || meeting.status !== 'booked' || (!admin && String(meeting.bookedBy) !== String(user._id))) { res.status(404).json({ message: 'Meeting not found.' }); return null; }
    if (meeting.mode !== 'online') { res.status(409).json({ message: 'This is an in-person meeting.' }); return null; }
    const start = meeting.start.getTime(), end = start + meeting.durationMin * MINUTE;
    if (!admin && (now() < start - 30 * MINUTE || now() > end + 60 * MINUTE)) { res.status(403).json({ message: 'The meeting room opens 30 minutes before the start time.' }); return null; }
    return { meeting, role: admin ? 'host' : 'guest', name: admin ? 'Khalil' : (user.firstName || meeting.bookedByName || 'Client') };
  }
  const other = role => (role === 'host' ? 'guest' : 'host');

  app.get('/api/meetings/:id/room', requireAuth, async (req, res) => {
    const ctx = await access(req, res); if (!ctx) return;
    res.set('Cache-Control', 'no-store').json({ role: ctx.role, name: ctx.name, meeting: { id: ctx.meeting.id, start: ctx.meeting.start, durationMin: ctx.meeting.durationMin, topic: ctx.meeting.topic, clientName: ctx.meeting.bookedByName }, iceServers: iceServers(env) });
  });
  // Poll: returns what is new for me (signals, chat) and whether the other person is in the room.
  app.get('/api/meetings/:id/room/poll', requireAuth, async (req, res) => {
    const ctx = await access(req, res); if (!ctx) return;
    const room = roomOf(req.params.id), after = Number(req.query.signal) || 0, afterMessage = Number(req.query.message) || 0;
    room.seen[ctx.role] = now();
    const mine = room.signals[ctx.role];
    res.set('Cache-Control', 'no-store').json({
      peerOnline: now() - room.seen[other(ctx.role)] < 8000,
      signals: mine.filter(item => item.seq > after),
      messages: room.messages.filter(item => item.seq > afterMessage),
    });
  });
  app.post('/api/meetings/:id/room/signal', requireAuth, async (req, res) => {
    const ctx = await access(req, res); if (!ctx) return;
    const { type, data } = req.body || {};
    if (!['offer', 'answer', 'candidate', 'hangup', 'decline'].includes(type)) return res.status(400).json({ message: 'Invalid signal.' });
    const size = JSON.stringify(data ?? null).length;
    if (size > 20000) return res.status(413).json({ message: 'Signal too large.' });
    const room = roomOf(req.params.id), queue = room.signals[other(ctx.role)];
    queue.push({ seq: ++room.seq, type, data: data ?? null });
    if (queue.length > MAX_SIGNALS) queue.splice(0, queue.length - MAX_SIGNALS);
    res.json({ ok: true });
  });
  app.post('/api/meetings/:id/room/message', requireAuth, async (req, res) => {
    const ctx = await access(req, res); if (!ctx) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
    if (!text) return res.status(400).json({ message: 'Write a message first.' });
    const room = roomOf(req.params.id), item = { seq: ++room.seq, from: ctx.role, name: ctx.name, text, at: new Date(now()).toISOString() };
    room.messages.push(item);
    if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    res.status(201).json({ item });
  });
}
module.exports = { registerMeetingRoom, iceServers };
