const { z } = require('zod');
const { ServiceRequest } = require('./models');
const { sendQuoteExpiryReminder } = require('./brevo');
const { notificationEmails } = require('./notification-emails');

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;

const {quoteTotals}=require('./quote-totals');
const journey = require('./booking-journey');
const { STATUS } = journey;

const isExpired = (sr) => journey.rule(sr.status).expires && sr.expiresAt && sr.expiresAt <= new Date();

// Expire overdue quotes and send each enabled reminder within its configured window.
async function sweepQuotes({notifications=notificationEmails,Model=ServiceRequest,send=sendQuoteExpiryReminder,clock=Date.now} = {}) {
  const now = new Date(clock());
  await Model.updateMany({ status: { $in: journey.statusesWhere('expires') }, expiresAt: { $lte: now } }, { status: STATUS.EXPIRED });
  const rule = await notifications.get('quote-expiry-reminder');
  if (!rule.enabled) return;
  const due = await Model.find({
    status: { $in: journey.statusesWhere('awaitingClient') }, reminderSentAt: null, expiresAt: { $gt: now, $lte: new Date(now.getTime() + rule.leadHours * 60 * 60 * 1000) },
  });
  for (const sr of due) {
    try {
      const r = await send(sr, sr.expiresAt);
      if (r.sent) await Model.updateOne({ _id: sr._id }, { reminderSentAt: new Date(clock()) });
    } catch (e) {
      console.error('Quote reminder failed:', e);
    }
  }
}

function registerQuoteLifecycle(app, { requireAuth, requireAdmin, serialize, Model = ServiceRequest }) {
  const find = (id) => Model.findOne({ externalId: id });
  const notFound = (res) => res.status(404).json({ message: 'Service request not found.' });
  const own = (req, sr) => sr && String(sr.userId) === String(req.authUser._id);

  app.post('/api/service-requests/:id/accept', requireAuth, async (req, res) => {
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    if (isExpired(sr)) {
      sr.status = STATUS.EXPIRED;
      await sr.save();
    }
    if (!journey.rule(sr.status).awaitingClient) return res.status(409).json({ message: `This quote is ${sr.status.replace('_', ' ')} and cannot be accepted.` });
    sr.status = STATUS.ACCEPTED;
    sr.acceptedAt = new Date();
    await sr.save();
    return res.json({ item: serialize(sr, false) });
  });

  app.post('/api/service-requests/:id/request-changes', requireAuth, async (req, res) => {
    const parsed = z.object({ message: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Describe the changes you need.' });
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    if (isExpired(sr) || !journey.rule(sr.status).awaitingClient) return res.status(409).json({ message: 'Only an active quote can be changed.' });
    sr.status = STATUS.CHANGES_REQUESTED;
    sr.changeRequest = parsed.data.message;
    await sr.save();
    return res.json({ item: serialize(sr, false) });
  });

  // Extend an active quote, or reactivate an expired one: new expiry = from now (expired) or from current expiry (active).
  app.post('/api/service-requests/:id/extend', requireAdmin, async (req, res) => {
    const parsed = z.object({ days: z.coerce.number().int().min(1).max(60).default(7) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Days must be between 1 and 60.' });
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    if (!journey.rule(sr.status).extendable || !sr.quotedAt) {
      return res.status(409).json({ message: 'Only a sent quote can be extended or reactivated.' });
    }
    const base = journey.rule(sr.status).expires && sr.expiresAt > new Date() ? sr.expiresAt.getTime() : Date.now();
    sr.expiresAt = new Date(base + parsed.data.days * DAY_MS);
    sr.status = STATUS.QUOTED;
    sr.reminderSentAt = null;
    await sr.save();
    return res.json({ item: serialize(sr, true) });
  });

  app.post('/api/service-requests/:id/cancel', requireAdmin, async (req, res) => {
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    sr.status = STATUS.CANCELLED;
    await sr.save();
    return res.json({ item: serialize(sr, true) });
  });

  if (require.main?.filename?.endsWith('server.js')) {
    setInterval(() => sweepQuotes().catch((e) => console.error('Quote sweep failed:', e)), SWEEP_MS).unref();
  }
}

module.exports = { DAY_MS, quoteTotals, registerQuoteLifecycle, sweepQuotes, isExpired };
