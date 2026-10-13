const mongoose = require('mongoose');
const { z } = require('zod');
const { sendSimpleEmail } = require('./brevo');

const DEFAULT_ADMIN_EMAIL = 'khalilnahhatdj@gmail.com';
const HOUR_MS = 60 * 60 * 1000;

const meetingSchema = new mongoose.Schema(
  {
    start: { type: Date, required: true, index: true },
    durationMin: { type: Number, default: 30, min: 5 },
    mode: { type: String, enum: ['online', 'in-person'], default: 'online' },
    link: { type: String, default: '' },
    location: { type: String, default: '' },
    status: { type: String, enum: ['open', 'booked'], default: 'open' },
    bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    bookedByName: { type: String, default: '' },
    bookedByEmail: { type: String, default: '' },
    topic: { type: String, default: '' },
    reminderSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);
const Meeting = mongoose.models.Meeting || mongoose.model('Meeting', meetingSchema);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (d) => new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Toronto' }).format(d);
const adminEmail = () => process.env.SERVICE_REQUEST_NOTIFICATION_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL;

const publicSlot = (m) => ({ id: m.id, start: m.start, durationMin: m.durationMin, mode: m.mode });
const bookedView = (m) => ({ ...publicSlot(m), link: m.link, location: m.location, topic: m.topic, bookedByName: m.bookedByName, bookedByEmail: m.bookedByEmail });

function mail(m, subject, intro) {
  const body = `<p>${esc(intro)}</p><p><strong>${esc(when(m.start))}</strong> (Toronto time, ${m.durationMin} min)<br>
    ${m.mode === 'online' ? `Online${m.link ? `: <a href="${esc(m.link)}">${esc(m.link)}</a>` : ''}` : `In person${m.location ? `: ${esc(m.location)}` : ''}`}</p><p>Echo Event Entertainment</p>`;
  return Promise.allSettled([
    sendSimpleEmail({ to: m.bookedByEmail, name: m.bookedByName, subject, html: body, tags: ['meeting'] }),
    sendSimpleEmail({ to: adminEmail(), subject: `${subject} — ${m.bookedByName}`, html: body, tags: ['meeting-admin'] }),
  ]);
}

async function bookSlot(id, user, topic) {
  return Meeting.findOneAndUpdate(
    { _id: id, status: 'open', start: { $gt: new Date(Date.now() + HOUR_MS) } },
    { status: 'booked', bookedBy: user._id, bookedByName: `${user.firstName} ${user.lastName}`.trim(), bookedByEmail: user.email, topic, reminderSentAt: null },
    { new: true },
  );
}
const freeSlot = (m) => Meeting.updateOne({ _id: m._id }, { status: 'open', bookedBy: null, bookedByName: '', bookedByEmail: '', topic: '', reminderSentAt: null });

async function sweepMeetings() {
  const now = new Date();
  const due = await Meeting.find({ status: 'booked', reminderSentAt: null, start: { $gt: now, $lte: new Date(now.getTime() + 24 * HOUR_MS) } });
  for (const m of due) {
    const r = await sendSimpleEmail({ to: m.bookedByEmail, name: m.bookedByName, subject: 'Meeting reminder', tags: ['meeting-reminder'],
      html: `<p>Reminder: your meeting is <strong>${esc(when(m.start))}</strong> (Toronto time).</p><p>Echo Event Entertainment</p>` }).catch(() => ({}));
    if (r.sent) await Meeting.updateOne({ _id: m._id }, { reminderSentAt: new Date() });
  }
}

function registerMeetings(app, { requireAuth, requireAdmin }) {
  const bad = (res, msg = 'Invalid request.') => res.status(400).json({ message: msg });
  const notFound = (res) => res.status(404).json({ message: 'Meeting not found.' });
  const mine = (m, u) => m && (u.isAdmin || String(m.bookedBy) === String(u._id));

  app.get('/api/meetings/slots', async (_req, res) => {
    const slots = await Meeting.find({ status: 'open', start: { $gt: new Date(Date.now() + HOUR_MS) } }).sort({ start: 1 }).limit(200);
    res.json({ items: slots.map(publicSlot) });
  });

  app.post('/api/meetings/slots', requireAdmin, async (req, res) => {
    const parsed = z.object({
      starts: z.array(z.coerce.date()).min(1).max(100), durationMin: z.coerce.number().int().min(5).max(240).default(30),
      mode: z.enum(['online', 'in-person']).default('online'), link: z.string().trim().max(300).default(''), location: z.string().trim().max(300).default(''),
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
    const m = await bookSlot(req.params.id, req.authUser, topic);
    if (!m) return res.status(409).json({ message: 'That time is no longer available.' });
    mail(m, 'Meeting confirmed', 'Your meeting is booked.');
    res.status(201).json({ item: bookedView(m) });
  });

  app.post('/api/meetings/:id/cancel', requireAuth, async (req, res) => {
    const m = await Meeting.findById(req.params.id);
    if (!mine(m, req.authUser) || m.status !== 'booked') return notFound(res);
    mail(m, 'Meeting cancelled', 'This meeting was cancelled.');
    await freeSlot(m);
    res.json({ ok: true });
  });

  // Book the new slot first so a failed reschedule never loses the existing meeting.
  app.post('/api/meetings/:id/reschedule', requireAuth, async (req, res) => {
    const old = await Meeting.findById(req.params.id);
    if (!mine(old, req.authUser) || old.status !== 'booked') return notFound(res);
    const next = await bookSlot(req.body?.toSlotId, req.authUser, old.topic);
    if (!next) return res.status(409).json({ message: 'That time is no longer available.' });
    await freeSlot(old);
    mail(next, 'Meeting rescheduled', 'Your meeting was moved to the time below.');
    res.json({ item: bookedView(next) });
  });

  app.get('/api/meetings/:id/ics', requireAuth, async (req, res) => {
    const m = await Meeting.findById(req.params.id);
    if (!mine(m, req.authUser) || m.status !== 'booked') return notFound(res);
    const f = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');
    res.type('text/calendar').send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Echo Event Entertainment//EN', 'BEGIN:VEVENT', `UID:${m.id}@echo`,
      `DTSTAMP:${f(new Date())}`, `DTSTART:${f(m.start)}`, `DTEND:${f(new Date(m.start.getTime() + m.durationMin * 60000))}`,
      'SUMMARY:Meeting with Echo Event Entertainment', `LOCATION:${(m.mode === 'online' ? m.link : m.location).replace(/[\r\n]/g, ' ')}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  });

  if (require.main?.filename?.endsWith('server.js')) {
    setInterval(() => sweepMeetings().catch((e) => console.error('Meeting sweep failed:', e)), 10 * 60 * 1000).unref();
  }
}

module.exports = { Meeting, registerMeetings, sweepMeetings };
