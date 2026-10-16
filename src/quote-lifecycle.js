const { z } = require('zod');
const { ServiceRequest } = require('./models');
const { sendQuoteExpiryReminder } = require('./brevo');

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_MS = 48 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

function quoteTotals(sr) {
  const subtotal = sr.items.reduce((sum, i) => sum + Number(i.unitPrice || 0) * i.quantity, 0);
  const tax = round2((subtotal * (sr.taxPercent ?? 0)) / 100);
  const total = round2(subtotal + tax);
  const deposit = Math.min(Number(sr.depositAmount || 0), total);
  return { subtotal: round2(subtotal), taxPercent: sr.taxPercent ?? 0, tax, total, deposit, balance: round2(total - deposit) };
}

const isExpired = (sr) => ['quoted', 'accepted'].includes(sr.status) && sr.expiresAt && sr.expiresAt <= new Date();

// Marks overdue quotes Expired and sends the one-time 48h reminder. Safe to run repeatedly.
async function sweepQuotes() {
  const now = new Date();
  await ServiceRequest.updateMany({ status: { $in: ['quoted', 'accepted'] }, expiresAt: { $lte: now } }, { status: 'expired' });
  const due = await ServiceRequest.find({
    status: 'quoted', reminderSentAt: null, expiresAt: { $gt: now, $lte: new Date(now.getTime() + REMINDER_MS) },
  });
  for (const sr of due) {
    try {
      const r = await sendQuoteExpiryReminder(sr, sr.expiresAt);
      if (r.sent) await ServiceRequest.updateOne({ _id: sr._id }, { reminderSentAt: new Date() });
    } catch (e) {
      console.error('Quote reminder failed:', e);
    }
  }
}

function registerQuoteLifecycle(app, { requireAuth, requireAdmin, serialize }) {
  const find = (id) => ServiceRequest.findOne({ externalId: id });
  const notFound = (res) => res.status(404).json({ message: 'Service request not found.' });
  const own = (req, sr) => sr && String(sr.userId) === String(req.authUser._id);

  app.post('/api/service-requests/:id/accept', requireAuth, async (req, res) => {
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    if (isExpired(sr)) {
      sr.status = 'expired';
      await sr.save();
    }
    if (sr.status !== 'quoted') return res.status(409).json({ message: `This quote is ${sr.status.replace('_', ' ')} and cannot be accepted.` });
    sr.status = 'accepted';
    sr.acceptedAt = new Date();
    await sr.save();
    return res.json({ item: serialize(sr, false) });
  });

  app.post('/api/service-requests/:id/request-changes', requireAuth, async (req, res) => {
    const parsed = z.object({ message: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Describe the changes you need.' });
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    if (isExpired(sr) || sr.status !== 'quoted') return res.status(409).json({ message: 'Only an active quote can be changed.' });
    sr.status = 'changes_requested';
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
    if (!['quoted', 'expired', 'changes_requested'].includes(sr.status) || !sr.quotedAt) {
      return res.status(409).json({ message: 'Only a sent quote can be extended or reactivated.' });
    }
    const base = ['quoted', 'accepted'].includes(sr.status) && sr.expiresAt > new Date() ? sr.expiresAt.getTime() : Date.now();
    sr.expiresAt = new Date(base + parsed.data.days * DAY_MS);
    sr.status = 'quoted';
    sr.reminderSentAt = null;
    await sr.save();
    return res.json({ item: serialize(sr, true) });
  });

  app.post('/api/service-requests/:id/cancel', requireAdmin, async (req, res) => {
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    sr.status = 'cancelled';
    await sr.save();
    return res.json({ item: serialize(sr, true) });
  });

  if (require.main?.filename?.endsWith('server.js')) {
    setInterval(() => sweepQuotes().catch((e) => console.error('Quote sweep failed:', e)), SWEEP_MS).unref();
  }
}

module.exports = { DAY_MS, quoteTotals, registerQuoteLifecycle, sweepQuotes, isExpired };
