const mongoose = require('mongoose');
const {meetingJoinWindow}=require('./meeting-attendance');
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
  async function access(req, res,recordJoin=false) {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ message: 'Meeting not found.' }); return null; }
    let meeting = await Meeting.findById(req.params.id);
    const user = req.authUser, admin = Boolean(user.isAdmin);
    if (!meeting || meeting.status !== 'booked' || (!admin && String(meeting.bookedBy) !== String(user._id))) { res.status(404).json({ message: 'Meeting not found.' }); return null; }
    if (meeting.mode !== 'online') { res.status(409).json({ message: 'This is an in-person meeting.' }); return null; }
    const at=now(),window=meetingJoinWindow(meeting);
    if(!admin&&at<window.opensAt.getTime()){res.status(403).json({message:'The meeting room opens 30 minutes before the start time.'});return null;}
    if(!admin&&at>window.closesAt.getTime()){res.status(403).json({message:'The meeting join window has closed.'});return null;}
    if(!admin&&recordJoin&&!meeting.clientJoinedAt){
      const joinedAt=new Date(at);
      const result=await Meeting.updateOne({_id:meeting._id||req.params.id,status:'booked',mode:'online',bookedBy:user._id,clientJoinedAt:null},{$set:{clientJoinedAt:joinedAt}});
      if(!result.matchedCount){
        meeting=await Meeting.findById(req.params.id);
        if(!meeting||meeting.status!=='booked'||meeting.mode!=='online'||String(meeting.bookedBy)!==String(user._id)||!meeting.clientJoinedAt){res.status(404).json({message:'Meeting not found.'});return null;}
      }else meeting.clientJoinedAt=joinedAt;
    }
    return { meeting, role: admin ? 'host' : 'guest', name: admin ? 'Khalil' : (user.firstName || meeting.bookedByName || 'Client') };
  }
  const other = role => (role === 'host' ? 'guest' : 'host');

  // Admin only: calls from clients that are ringing right now (an offer in the last minute that nobody has answered, declined or ended).
  app.get('/api/meetings/room/incoming', requireAuth, async (req, res) => {
    if (!req.authUser?.isAdmin) return res.status(403).json({ message: 'Admins only.' });
    const live = [...rooms].filter(([, room]) => room.ringing?.from === 'guest' && now() - room.ringing.at < 60 * 1000).filter(([id]) => mongoose.isValidObjectId(id));
    const meetings = live.length ? await Meeting.find({ _id: { $in: live.map(([id]) => id) }, status: 'booked' }) : [];
    res.set('Cache-Control', 'no-store').json({ items: meetings.flatMap(m=>{
      const ringing=rooms.get(m.id)?.ringing;
      return ringing?.from==='guest'&&now()-ringing.at<60000?[{meetingId:m.id,clientName:m.bookedByName,kind:ringing.kind,at:new Date(ringing.at).toISOString()}]:[];
    }) });
  });
  app.get('/api/meetings/:id/room', requireAuth, async (req, res) => {
    const ctx = await access(req, res,true); if (!ctx) return;
    res.set('Cache-Control', 'no-store').json({ role: ctx.role, name: ctx.name, meeting: { id: ctx.meeting.id, start: ctx.meeting.start, durationMin: ctx.meeting.durationMin, topic: ctx.meeting.topic, clientName: ctx.meeting.bookedByName,clientJoinedAt:ctx.meeting.clientJoinedAt||null }, iceServers: iceServers(env) });
  });
  app.post('/api/meetings/:id/end',requireAuth,async(req,res)=>{
    if(!req.authUser?.isAdmin)return res.status(403).json({message:'Only the host can end a meeting.'});
    const ctx=await access(req,res);if(!ctx)return;
    if(!ctx.meeting.clientJoinedAt)return res.status(409).json({message:'The client has not joined this meeting yet.'});
    const removed=await Meeting.findOneAndDelete({_id:ctx.meeting._id||req.params.id,status:'booked',mode:'online',clientJoinedAt:{$type:'date'}});
    if(!removed)return res.status(404).json({message:'Meeting not found.'});
    rooms.delete(req.params.id);return res.json({ok:true,ended:true});
  });
  // Poll: returns what is new for me (signals, chat) and whether the other person is in the room.
  app.get('/api/meetings/:id/room/poll', requireAuth, async (req, res) => {
    const ctx = await access(req, res,true); if (!ctx) return;
    const room = roomOf(req.params.id), after = Number(req.query.signal) || 0, afterMessage = Number(req.query.message) || 0;
    room.seen[ctx.role] = now();
    const mine = room.signals[ctx.role];
    res.set('Cache-Control', 'no-store').json({
      peerOnline: now() - room.seen[other(ctx.role)] < 8000,
      clientJoinedAt:ctx.meeting.clientJoinedAt||null,
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
    // Who is being rung: set by an offer, cleared once it is answered, declined or hung up (the admin's incoming-call check reads this).
    if (type === 'offer') room.ringing = { from: ctx.role, kind: data?.kind === 'video' ? 'video' : 'voice', at: now() }; else if (['answer', 'hangup', 'decline'].includes(type)) room.ringing = null; // candidates follow an offer and must not stop the ringing
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
module.exports = { registerMeetingRoom, iceServers,forgetMeetingRoom:id=>rooms.delete(String(id)) };
