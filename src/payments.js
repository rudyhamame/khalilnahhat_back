const mongoose = require('mongoose');
const { z } = require('zod');
const { ServiceRequest } = require('./models');
const { Equipment } = require('./equipment');
const { sendBookingConfirmation } = require('./brevo');
const { quoteTotals, isExpired } = require('./quote-lifecycle');

const bookingSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    eventDate: { type: String, required: true },
    equipment: [{ _id: false, slug: String, quantity: Number }],
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// One event per date: a single DJ team. ponytail: per-crew capacity if a second team is added.
bookingSchema.index({ eventDate: 1 }, { unique: true });
const EventBooking = mongoose.models.EventBooking || mongoose.model('EventBooking', bookingSchema);

// Cash is deliberately not accepted. Payments are recorded by the admin after they arrive.
const METHODS = ['etransfer', 'cheque', 'bank_transfer', 'other'];
const toCents = (dollars) => Math.round(Number(dollars || 0) * 100);
const livePayments = (sr) => (sr.payments || []).filter((p) => !p.voided);
const netPaidCents = (sr) => livePayments(sr).reduce((s, p) => s + p.amountCents, 0);

const recordSchema = z.object({
  kind: z.enum(['deposit', 'balance', 'refund']),
  amount: z.coerce.number().positive().max(1e6),
  method: z.enum(METHODS),
  reference: z.string().trim().max(200).default(''),
  receivedAt: z.coerce.date().optional(),
});

// Equipment with stockTracked must fit alongside every other booking on that date.
async function stockProblem(sr) {
  const wanted = sr.items.filter((i) => !i.serviceId.startsWith('svc-'));
  if (!wanted.length) return '';
  const tracked = await Equipment.find({ slug: { $in: wanted.map((i) => i.serviceId) }, stockTracked: true });
  if (!tracked.length) return '';
  const others = await EventBooking.find({ eventDate: sr.event.eventDate, requestId: { $ne: sr.externalId } });
  for (const eq of tracked) {
    const used = others.flatMap((b) => b.equipment).filter((e) => e.slug === eq.slug).reduce((s, e) => s + e.quantity, 0);
    if (used + wanted.find((i) => i.serviceId === eq.slug).quantity > eq.quantityOwned) return `${eq.name} is not available in the requested quantity on that date.`;
  }
  return '';
}

function registerPayments(app, { requireAuth, requireAdmin, serialize }) {
  const find = (id) => ServiceRequest.findOne({ externalId: id });
  const fail = (res, code, message) => res.status(code).json({ message });

  app.post('/api/service-requests/:id/payments', requireAdmin, async (req, res) => {
    const parsed = recordSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Enter an amount and a payment method (e-transfer, cheque, bank transfer or other).');
    const { kind, amount, method, reference, receivedAt } = parsed.data;
    const sr = await find(req.params.id);
    if (!sr) return fail(res, 404, 'Service request not found.');
    const cents = toCents(amount);
    const net = netPaidCents(sr);
    const totalCents = toCents(quoteTotals(sr).total);

    if (kind === 'deposit' && isExpired(sr)) return fail(res, 409, 'This quote has expired. Extend and accept it again before recording a deposit.');
    if (kind !== 'refund' && net + cents > totalCents) return fail(res, 400, 'That is more than the remaining balance.');
    if (kind === 'deposit' && sr.status !== 'accepted') return fail(res, 409, 'A deposit can be recorded once the customer has accepted the quote.');
    if (kind !== 'deposit' && sr.status !== 'confirmed') return fail(res, 409, 'Confirm the booking with a deposit first.');
    if (kind === 'balance' && net + cents > totalCents) return fail(res, 400, 'That is more than the remaining balance.');
    if (kind === 'refund' && cents > net) return fail(res, 400, 'Refund is larger than the amount received.');

    let booking = null;
    if (kind === 'deposit' && net + cents >= toCents(sr.depositAmount)) {
      if (!sr.event?.eventDate) return fail(res, 400, 'This request has no event date.');
      const problem = await stockProblem(sr);
      if (problem) return fail(res, 409, problem);
      try {
        booking = await EventBooking.create({
          requestId: sr.externalId, userId: sr.userId, eventDate: sr.event.eventDate, paidAt: receivedAt || new Date(),
          equipment: sr.items.filter((i) => !i.serviceId.startsWith('svc-')).map((i) => ({ slug: i.serviceId, quantity: i.quantity })),
        });
      } catch (e) {
        if (e.code === 11000) return fail(res, 409, 'That date is already booked by another confirmed event.');
        throw e;
      }
    }

    sr.payments.push({ kind, amountCents: kind === 'refund' ? -cents : cents, method, reference, paidAt: receivedAt || new Date() });
    if (booking) sr.status = 'confirmed';
    try {
      await sr.save();
    } catch (e) {
      if (booking) await EventBooking.deleteOne({ _id: booking._id });
      throw e;
    }
    if (booking) sendBookingConfirmation(sr, cents).catch((e) => console.error('Booking confirmation email failed:', e));
    return res.status(201).json({ item: serialize(sr, true) });
  });

  // Entries are never deleted, only voided, so the history stays auditable.
  app.post('/api/service-requests/:id/payments/:paymentId/void', requireAdmin, async (req, res) => {
    const sr = await find(req.params.id);
    const p = sr?.payments.id(req.params.paymentId);
    if (!p || p.voided) return fail(res, 404, 'Payment not found.');
    p.voided = true;
    await sr.save();
    return res.json({ item: serialize(sr, true) });
  });

  // Printable receipt for one payment; the owner or an admin.
  app.get('/api/service-requests/:id/receipt/:paymentId', requireAuth, async (req, res) => {
    const sr = await find(req.params.id);
    const u = req.authUser;
    const p = sr && (String(sr.userId) === String(u._id) || u.isAdmin) ? sr.payments.id(req.params.paymentId) : null;
    if (!p || p.voided) return fail(res, 404, 'Receipt not found.');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = (c) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(c / 100);
    return res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Receipt ${esc(sr.requestNumber)}</title>
      <body style="font-family:sans-serif;max-width:560px;margin:40px auto"><h1>Echo Event Entertainment</h1><h2>Receipt</h2>
      <p>Booking: <strong>${esc(sr.requestNumber || sr.externalId)}</strong><br>Customer: ${esc(sr.customerName)}<br>Event date: ${esc(sr.event?.eventDate)}</p>
      <p>${esc(p.kind)}: <strong>${money(p.amountCents)}</strong><br>Method: ${esc(p.method)}${p.reference ? ` (${esc(p.reference)})` : ''}<br>
      Received: ${esc(new Date(p.paidAt).toLocaleString('en-CA', { timeZone: 'America/Toronto' }))}</p></body>`);
  });

  app.get('/api/bookings/confirmed', requireAdmin, async (_req, res) => {
    const items = await EventBooking.find().sort({ eventDate: 1 });
    const reqs = await ServiceRequest.find({ externalId: { $in: items.map((b) => b.requestId) } });
    const byId = new Map(reqs.map((r) => [r.externalId, r]));
    res.json({ items: items.map((b) => ({ eventDate: b.eventDate, requestId: b.requestId, customerName: byId.get(b.requestId)?.customerName || '',
      venue: byId.get(b.requestId)?.event?.venueName || '', equipment: b.equipment, paidAt: b.paidAt })) });
  });

  // Admin payment ledger across all requests, newest first.
  app.get('/api/transactions', requireAdmin, async (_req, res) => {
    const reqs = await ServiceRequest.find({ 'payments.0': { $exists: true } });
    const items = reqs.flatMap((sr) => sr.payments.map((p) => ({
      id: String(p._id), type: p.method, status: p.voided ? 'void' : 'recorded', paymentStatus: p.voided ? 'void' : p.kind === 'refund' ? 'refunded' : 'paid',
      amountTotal: p.amountCents, currency: 'CAD', customerEmail: sr.customerEmail, requestGroupId: sr.externalId, serviceId: p.kind,
      serviceName: `${sr.requestNumber || sr.externalId} · ${p.kind}${p.reference ? ` · ${p.reference}` : ''}`, requestCount: 0, requestTitles: [], confirmationCodes: [],
      createdAt: p.paidAt, receiptSent: false, paymentIntentId: '',
    })));
    res.json({ items: items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
  });
}

module.exports = { EventBooking, registerPayments };
