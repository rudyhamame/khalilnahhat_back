// Push notifications for CLIENTS (the Echo client Android app). Separate from the admin push in ai-admin/push.js:
// a client device belongs to one user account and only ever receives that user's own booking updates.
const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const { GoogleAuth } = require('google-auth-library');
const { z } = require('zod');
const { STATUS } = require('./booking-journey');
const {availabilityFor} = require('./booking-availability');

const hash = (v) => createHash('sha256').update(v).digest('hex');
const Device = mongoose.models.EchoClientDevice || mongoose.model('EchoClientDevice', new mongoose.Schema({
  _id: String, userId: { type: String, index: true }, token: { type: String, select: false }, tokenHash: { type: String, unique: true, sparse: true }, active: Boolean,
}, { timestamps: true }));
const input = z.object({ installationId: z.uuid(), token: z.string().min(20).max(4096), platform: z.literal('android') }).strict();

const creds = (env) => (env.FCM_SERVICE_ACCOUNT_JSON ? JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) : undefined);
const configured = (env = process.env) => { try { return !!(env.FCM_PROJECT_ID || creds(env)?.project_id) && !!(env.FCM_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS); } catch { return false; } };
let auth;

// What a booking status change means to the client. Changes the client makes themselves (accept, request changes, decline) never notify.
const MESSAGES = {
  quoted: ['Booking quote ready', 'Review your quote in the Echo app. Your event is Booked after the required deposit and confirmation.'],
  confirmed: ['Booked', 'Your event booking is confirmed. Open the Echo app for details.'],
  expired: ['Your quote expired', 'Contact us to reactivate it.'],
};
function messageFor(sr) {
  if (sr.status === STATUS.CANCELLED) return sr.declinedBy === 'admin' ? ['Request declined', 'Your booking request could not be accepted.'] : null;
  if(sr.status===STATUS.PENDING){
    const availability=availabilityFor(sr);
    if(availability.status==='available')return ['Booking date available', 'Your booking is waiting for quote. We will notify you when it is ready.'];
    if(availability.status==='unavailable')return ['Booking date unavailable', 'Open your booking for the reason. You may book an optional meeting or suggest another date and time.'];
  }
  return MESSAGES[sr.status] || null;
}

async function notifyUser(userId, { title, body, requestId }, { fetchImpl = fetch, env = process.env, accessToken } = {}) {
  if (!configured(env) || !userId) return 0;
  if (!auth && !accessToken) auth = new GoogleAuth({ credentials: creds(env), scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  const token = accessToken ? await accessToken() : await auth.getAccessToken();
  const project = env.FCM_PROJECT_ID || creds(env).project_id;
  let sent = 0;
  for (const d of await Device.find({ userId: String(userId), active: true }).select('+token').lean()) {
    if (!d.token) continue;
    const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: d.token, data: { kind: 'booking', title, body, requestId: String(requestId || '') }, android: { priority: 'HIGH' } } }),
    });
    if (r?.ok) { sent++; continue; }
    if ((await r?.json().catch(() => ({})))?.error?.details?.some((x) => x.errorCode === 'UNREGISTERED')) await Device.updateOne({ _id: d._id }, { $set: { active: false }, $unset: { token: 1 } });
  }
  return sent;
}

// One hook on the schema covers every place a status can change (quote sent, confirmed, declined, expired by the sweep).
// Attach it BEFORE mongoose.model() compiles the schema; models.js does this.
function watchSchema(schema, send = notifyUser) {
  schema.pre('save', function () { this.$locals.pushStatus = !this.isNew && this.isModified('status'); this.$locals.pushQuote = !this.isNew && this.isModified('quoteRevision'); this.$locals.pushAvailability = !this.isNew && ['availabilityAcceptedAt','availabilityUnavailableAt','availabilityReason','availabilityWindow'].some(key=>this.isModified(key)); });
  schema.post('save', function (doc) {
    const m = (doc.$locals.pushStatus || doc.$locals.pushQuote || doc.$locals.pushAvailability) ? messageFor(doc) : null;
    if (m) send(doc.userId, { title: m[0], body: m[1], requestId: doc.externalId || doc.id }).catch((e) => console.error('Client push failed:', e.message));
  });
}

function registerClientPush(app, { requireAuth }) {
  app.put('/api/client/devices', requireAuth, async (req, res) => {
    const p = input.safeParse(req.body);
    if (!p.success) return res.status(400).json({ message: 'Invalid device.' });
    const userId = String(req.authUser._id), tokenHash = hash(p.data.token);
    // A token or installation moving to another account is reassigned, never shared.
    await Device.deleteMany({ tokenHash, _id: { $ne: p.data.installationId } });
    await Device.updateOne({ _id: p.data.installationId }, { $set: { userId, token: p.data.token, tokenHash, active: true } }, { upsert: true });
    res.json({ ok: true, configured: configured() });
  });
  app.delete('/api/client/devices/:id', requireAuth, async (req, res) => {
    await Device.updateOne({ _id: req.params.id, userId: String(req.authUser._id) }, { $set: { active: false }, $unset: { token: 1 } });
    res.json({ ok: true });
  });
}

module.exports = { registerClientPush, watchSchema, messageFor, notifyUser, Device };
