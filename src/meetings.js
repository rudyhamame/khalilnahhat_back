const mongoose = require('mongoose');
const {pruneMissedMeetings}=require('./meeting-attendance');
const {forgetMeetingRoom}=require('./meeting-room');
const { z } = require('zod');
const { ServiceRequest } = require('./models');
const journey = require('./booking-journey');
const { STATUS } = journey;
const CALL_MODES = ['phone', 'whatsapp-voice', 'whatsapp-video'];
const modeLabel = mode => ({phone:'Phone call','whatsapp-voice':'WhatsApp voice call','whatsapp-video':'WhatsApp video call',online:'Online','in-person':'In person'}[mode] || mode);
const { sendSimpleEmail } = require('./brevo');
const { notificationEmails } = require('./notification-emails');

const {notificationAddress} = require('./business-mail-identity');
const HOUR_MS = 60 * 60 * 1000;

const meetingSchema = new mongoose.Schema(
  {
    start: { type: Date, required: true, index: true },
    durationMin: { type: Number, default: 30, min: 5 },
    mode: { type: String, enum: ['online', 'in-person', ...CALL_MODES], default: 'online' },
    link: { type: String, default: '' },
    location: { type: String, default: '' },
    status: { type: String, enum: ['open', 'booked'], default: 'open' },
    bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    bookedByName: { type: String, default: '' },
    bookedByEmail: { type: String, default: '' },
    topic: { type: String, default: '' },
    bookingRequestId: {type:String, default:null},
    meetingPurpose: {type:String,enum:['planning','availability'],default:'planning'},
    callMethod: {type:String, enum:['', ...CALL_MODES], default:''},
    contactPhone: {type:String, default:''},
    reminderSentAt: { type: Date, default: null },
    clientJoinedAt: {type:Date,default:null},
    attendanceTrackingStartedAt: {type:Date,default:null},
  },
  { timestamps: true },
);
meetingSchema.index({bookingRequestId:1}, {unique:true,partialFilterExpression:{bookingRequestId:{$type:'string'},status:'booked'}});
const Meeting = mongoose.models.Meeting || mongoose.model('Meeting', meetingSchema);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (d) => new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Toronto' }).format(d);
const adminEmail = () => notificationAddress();

const publicSlot = (m) => ({ id: m.id, start: m.start, durationMin: m.durationMin, mode: m.mode });
const bookedView = (m) => ({ ...publicSlot(m), bookingRequestId:m.bookingRequestId, meetingPurpose:m.meetingPurpose||'planning', callMethod:m.callMethod, contactPhone:m.contactPhone, link: m.link, location: m.location, topic: m.topic, bookedByName: m.bookedByName, bookedByEmail: m.bookedByEmail,clientJoinedAt:m.clientJoinedAt||null });

function mail(m, subject, intro) {
  const event = subject.toLowerCase().replaceAll(' ', '-');
  const notificationContext = meetingEmailContext(m);
  const body = `<p>${esc(intro)}</p><p><strong>${esc(when(m.start))}</strong> (Toronto time, ${m.durationMin} min)<br>
    ${CALL_MODES.includes(m.callMethod || m.mode) ? `${esc(modeLabel(m.callMethod || m.mode))} — ${esc(m.contactPhone)}` : m.mode === 'online' ? `Online${m.link ? `: <a href="${esc(m.link)}">${esc(m.link)}</a>` : ''}` : `In person${m.location ? `: ${esc(m.location)}` : ''}`}</p><p>This confirms the meeting only, not your event booking. Your event is Booked only after its required deposit and final confirmation.</p><p>Echo Event Entertainment</p>`;
  return Promise.allSettled([
    sendSimpleEmail({ to: m.bookedByEmail, name: m.bookedByName, subject, html: body, tags: [event,'meeting'], notificationContext }),
    sendSimpleEmail({ to: adminEmail(), subject: `${subject} — ${m.bookedByName}`, html: body, tags: [`${event}-admin`,'meeting-admin'], notificationContext }),
  ]);
}

function meetingEmailContext(m) {
  return {customerName:m.bookedByName,meetingTime:`${when(m.start)} (Toronto time)`,duration:`${m.durationMin} minutes`,meetingLocation:CALL_MODES.includes(m.callMethod || m.mode)?`${modeLabel(m.callMethod || m.mode)} — ${m.contactPhone}`:m.mode==='online'?`Online${m.link?`: ${m.link}`:''}`:`In person${m.location?`: ${m.location}`:''}`,topic:m.topic||''};
}

async function bookSlot(id, user, topic, details = {}) {
  return Meeting.findOneAndUpdate(
    { _id: id, status: 'open', start: { $gt: new Date() } },
    { ...details, status: 'booked', bookedBy: user._id, bookedByName: `${user.firstName} ${user.lastName}`.trim(), bookedByEmail: user.email, topic, reminderSentAt: null,clientJoinedAt:null,attendanceTrackingStartedAt:new Date() },
    { new: true },
  );
}
const freeSlot = (m) => Meeting.updateOne({ _id: m._id }, { status: 'open', bookedBy: null, bookedByName: '', bookedByEmail: '', topic: '', bookingRequestId:null,callMethod:'',contactPhone:'', reminderSentAt: null,clientJoinedAt:null,attendanceTrackingStartedAt:null });

async function sweepMeetings({notifications=notificationEmails,Model=Meeting,send=sendSimpleEmail,clock=Date.now} = {}) {
  const rule = await notifications.get('meeting-reminder');
  if (!rule.enabled) return;
  const now = new Date(clock());
  const due = await Model.find({ status: 'booked', reminderSentAt: null, start: { $gt: now, $lte: new Date(now.getTime() + rule.leadHours * HOUR_MS) } });
  for (const m of due) {
    const r = await send({ to: m.bookedByEmail, name: m.bookedByName, subject: 'Meeting reminder', tags: ['meeting-reminder'],
      notificationContext:meetingEmailContext(m),
      html: `<p>Reminder: your meeting is <strong>${esc(when(m.start))}</strong> (Toronto time).</p><p>Echo Event Entertainment</p>` }).catch(() => ({}));
    if (r.sent) await Model.updateOne({ _id: m._id }, { reminderSentAt: new Date(clock()) });
  }
}

function registerMeetings(app, { requireAuth, requireAdmin, BookingModel=ServiceRequest, MeetingModel=Meeting, sendMail=mail, reserveSlot=bookSlot }) {
  const bad = (res, msg = 'Invalid request.') => res.status(400).json({ message: msg });
  const notFound = (res) => res.status(404).json({ message: 'Meeting not found.' });
  const mine = (m, u) => m && (u.isAdmin || String(m.bookedBy) === String(u._id));

  app.get('/api/meetings/slots', async (_req, res) => {
    // Every open time still ahead is listed and can be booked, however soon it is.
    const slots = await Meeting.find({ status: 'open', start: { $gt: new Date() } }).sort({ start: 1 }).limit(200);
    res.json({ items: slots.map(publicSlot) });
  });

  app.post('/api/meetings/slots', requireAdmin, async (req, res) => {
    const parsed = z.object({
      starts: z.array(z.coerce.date()).min(1).max(100), durationMin: z.coerce.number().int().min(5).max(240).default(30),
      mode: z.enum(['online', 'in-person', ...CALL_MODES]).default('online'), link: z.string().trim().max(300).default(''), location: z.string().trim().max(300).default(''),
    }).safeParse(req.body);
    if (!parsed.success) return bad(res, 'Slot payload failed validation.');
    const { starts, ...rest } = parsed.data;
    const items = await Meeting.insertMany(starts.map((start) => ({ start, ...rest })));
    res.status(201).json({ items: items.map(publicSlot) });
  });

  app.delete('/api/meetings/slots/:id', requireAdmin, async (req, res) => {
    const r = await Meeting.deleteOne({ _id: req.params.id, status: 'open' });
    return r.deletedCount ? res.json({ ok: true }) : res.status(409).json({ message: 'Only open slots can be removed. Cancel a booked meeting first.' });
  });

  app.get('/api/meetings/mine', requireAuth, async (req, res) => {
    const items = await Meeting.find({ bookedBy: req.authUser._id, status: 'booked' }).sort({ start: 1 });
    res.json({ items: items.map(bookedView) });
  });

  app.get('/api/meetings/admin', requireAdmin, async (_req, res) => {
    const items = await Meeting.find({ start: { $gt: new Date(Date.now() - 24 * HOUR_MS) } }).sort({ start: 1 });
    res.json({ items: items.map((m) => ({ ...bookedView(m), status: m.status })) });
  });

  app.post('/api/meetings/:id/book', requireAuth, async (req, res) => {
    const topic = String(req.body?.topic || '').slice(0, 500);
    const parsed = z.object({bookingRequestId:z.string().trim().min(1).max(200).optional(),callMethod:z.enum(CALL_MODES).optional(),contactPhone:z.string().trim().min(5).max(80).optional(),purpose:z.enum(['planning','availability']).default('planning')}).safeParse(req.body || {});
    if (!parsed.success) return bad(res,'Choose a call method and enter your contact number.');
    const {purpose,...details} = parsed.data;
    details.meetingPurpose=purpose;
    if (details.bookingRequestId) {
      const booking = await BookingModel.findOne({externalId:details.bookingRequestId,userId:req.authUser._id});
      const discussion=booking&&journey.describeRequest(booking).canDiscussAvailability;
      const planning=booking&&[STATUS.ACCEPTED,STATUS.CONFIRMED].includes(booking.status)&&!(booking.status===STATUS.ACCEPTED&&booking.expiresAt&&booking.expiresAt<=new Date());
      if(purpose==='availability'?!discussion:!planning)return res.status(409).json({message:purpose==='availability'?'Availability discussion meetings are only offered for your unavailable booking request.':'Accept your active quote before scheduling its planning meeting.'});
    }
    if(purpose==='availability'&&!details.bookingRequestId)return bad(res,'Choose the booking whose availability you want to discuss.');
    const slot = await MeetingModel.findById(req.params.id);
    if (!slot) return notFound(res);
    if(CALL_MODES.includes(slot.mode) && !details.bookingRequestId)return bad(res,'Accept your quote and schedule this call from your booking dashboard.');
    if (details.bookingRequestId && slot.mode!=='online' && !CALL_MODES.includes(slot.mode)) return bad(res,'Choose a Meet Echo, phone or WhatsApp appointment.');
    if (details.bookingRequestId && CALL_MODES.includes(slot.mode) && (!details.callMethod || !details.contactPhone)) return bad(res,'Choose a call method and enter your contact number.');
    if (CALL_MODES.includes(slot.mode) && details.callMethod && details.callMethod !== slot.mode) return bad(res,'This slot uses a different call method.');
    await MeetingModel.init();
    let m;
    try { m = await reserveSlot(req.params.id, req.authUser, topic, details); }
    catch(error) { if(error.code===11000)return res.status(409).json({message:'You already have a meeting for this booking.'}); throw error; }
    if (!m) return res.status(409).json({ message: 'That time is no longer available.' });
    sendMail(m, 'Meeting confirmed', 'Your meeting is booked.');
    res.status(201).json({ item: bookedView(m) });
  });

  app.post('/api/meetings/:id/cancel', requireAuth, async (req, res) => {
    const m = await MeetingModel.findById(req.params.id);
    if (!mine(m, req.authUser) || m.status !== 'booked') return notFound(res);
    mail(m, 'Meeting cancelled', 'This meeting was cancelled.');
    await freeSlot(m);
    res.json({ ok: true });
  });

  // Book the new slot first so a failed reschedule never loses the existing meeting.
  app.post('/api/meetings/:id/reschedule', requireAuth, async (req, res) => {
    const old = await MeetingModel.findById(req.params.id);
    if (!mine(old, req.authUser) || old.status !== 'booked') return notFound(res);
    if(old.bookingRequestId){const booking=await BookingModel.findOne({externalId:old.bookingRequestId,userId:old.bookedBy});const eligible=booking&&(old.meetingPurpose==='availability'?journey.describeRequest(booking).canDiscussAvailability:[STATUS.ACCEPTED,STATUS.CONFIRMED].includes(booking.status)&&!(booking.status===STATUS.ACCEPTED&&booking.expiresAt&&booking.expiresAt<=new Date()));if(!eligible)return res.status(409).json({message:'This booking no longer permits a meeting.'});const slot=await MeetingModel.findById(req.body?.toSlotId);if(!slot||!CALL_MODES.includes(slot.mode))return bad(res,'Choose a phone or WhatsApp appointment.');}
    if(!old.bookingRequestId){const slot=await MeetingModel.findById(req.body?.toSlotId);if(slot&&CALL_MODES.includes(slot.mode))return bad(res,'Schedule booking calls from an accepted booking.');}
    const next = await bookSlot(req.body?.toSlotId, req.authUser, old.topic);
    if (!next) return res.status(409).json({ message: 'That time is no longer available.' });
    await freeSlot(old);
    next.meetingPurpose=old.meetingPurpose; next.bookingRequestId=old.bookingRequestId; next.callMethod=CALL_MODES.includes(next.mode)?next.mode:old.callMethod; next.contactPhone=old.contactPhone; await next.save();
    mail(next, 'Meeting rescheduled', 'Your meeting was moved to the time below.');
    res.json({ item: bookedView(next) });
  });

  app.get('/api/meetings/:id/ics', requireAuth, async (req, res) => {
    const m = await MeetingModel.findById(req.params.id);
    if (!mine(m, req.authUser) || m.status !== 'booked') return notFound(res);
    const f = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');
    res.type('text/calendar').send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Echo Event Entertainment//EN', 'BEGIN:VEVENT', `UID:${m.id}@echo`,
      `DTSTAMP:${f(new Date())}`, `DTSTART:${f(m.start)}`, `DTEND:${f(new Date(m.start.getTime() + m.durationMin * 60000))}`,
      'SUMMARY:Meeting with Echo Event Entertainment', `LOCATION:${(m.callMethod ? `${modeLabel(m.callMethod)} ${m.contactPhone}` : m.mode === 'online' ? m.link : m.location).replace(/[\r\n]/g, ' ')}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  });

  if (require.main?.filename?.endsWith('server.js')) {
    setInterval(()=>pruneMissedMeetings({Model:MeetingModel,onDeleted:forgetMeetingRoom}).catch(error=>console.error('Meeting attendance cleanup failed:',error)),60000).unref();
    setInterval(() => sweepMeetings().catch((e) => console.error('Meeting sweep failed:', e)), 10 * 60 * 1000).unref();
  }
}

module.exports = { Meeting, registerMeetings, sweepMeetings,pruneMissedMeetings };
