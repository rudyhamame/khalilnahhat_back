const mongoose = require('mongoose');
const { ServiceRequest } = require('./models');
const { Equipment } = require('./equipment');
const { sendBookingConfirmation } = require('./brevo');
const { quoteTotals } = require('./quote-lifecycle');

const HOLD_MS = 30 * 60 * 1000; // Stripe Checkout's minimum session lifetime

const bookingSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    eventDate: { type: String, required: true },
    status: { type: String, enum: ['held', 'confirmed'], required: true },
    equipment: [{ _id: false, slug: String, quantity: Number }],
    holdExpiresAt: { type: Date, default: null },
    stripeSessionId: { type: String, default: '' },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// One event per date: a single DJ team. ponytail: per-crew capacity if a second team is added.
bookingSchema.index({ eventDate: 1 }, { unique: true });
const EventBooking = mongoose.models.EventBooking || mongoose.model('EventBooking', bookingSchema);

const toCents = (dollars) => Math.round(Number(dollars || 0) * 100);

// Equipment with stockTracked must fit alongside every other booking on that date.
async function stockProblem(sr, ignoreRequestId) {
  const wanted = sr.items.filter((i) => !i.serviceId.startsWith('svc-'));
  if (!wanted.length) return '';
  const tracked = await Equipment.find({ slug: { $in: wanted.map((i) => i.serviceId) }, stockTracked: true });
  if (!tracked.length) return '';
  const others = await EventBooking.find({ eventDate: sr.event.eventDate, requestId: { $ne: ignoreRequestId } });
  for (const eq of tracked) {
    const used = others.flatMap((b) => b.equipment).filter((e) => e.slug === eq.slug).reduce((s, e) => s + e.quantity, 0);
    const need = wanted.find((i) => i.serviceId === eq.slug).quantity;
    if (used + need > eq.quantityOwned) return `${eq.name} is not available in the requested quantity on that date.`;
  }
  return '';
}

async function holdDate(sr) {
  const { eventDate } = sr.event;
  await EventBooking.deleteMany({ eventDate, status: 'held', holdExpiresAt: { $lt: new Date() } });
  const equipment = sr.items.filter((i) => !i.serviceId.startsWith('svc-')).map((i) => ({ slug: i.serviceId, quantity: i.quantity }));
  const fields = { requestId: sr.externalId, userId: sr.userId, eventDate, status: 'held', equipment, holdExpiresAt: new Date(Date.now() + HOLD_MS) };
  const mine = await EventBooking.findOneAndUpdate({ requestId: sr.externalId, status: 'held' }, fields, { new: true });
  if (mine) return mine;
  try {
    return await EventBooking.create(fields);
  } catch (e) {
    if (e.code === 11000) return null;
    throw e;
  }
}

async function confirmFromSession(session) {
  const requestId = session.metadata?.serviceRequestId;
  const sr = await ServiceRequest.findOne({ externalId: requestId });
  if (!sr || sr.status === 'confirmed') return;
  const paidCents = session.amount_total || 0;
  let booking = await EventBooking.findOneAndUpdate(
    { requestId, status: 'held' }, { status: 'confirmed', paidAt: new Date(), holdExpiresAt: null, stripeSessionId: session.id }, { new: true });
  if (!booking) {
    // Hold lapsed before payment landed: take the date if still free, else flag for a manual refund.
    try {
      booking = await EventBooking.create({ requestId, userId: sr.userId, eventDate: sr.event.eventDate, status: 'confirmed', paidAt: new Date(), stripeSessionId: session.id,
        equipment: sr.items.filter((i) => !i.serviceId.startsWith('svc-')).map((i) => ({ slug: i.serviceId, quantity: i.quantity })) });
    } catch (e) {
      if (e.code !== 11000) throw e;
      sr.paymentIssue = 'Deposit was paid after the date hold lapsed and the date is now taken. Refund required.';
    }
  }
  sr.payments.push({ kind: 'deposit', amountCents: paidCents, sessionId: session.id, paymentIntentId: String(session.payment_intent || ''), paidAt: new Date() });
  if (booking) sr.status = 'confirmed';
  await sr.save();
  if (booking) sendBookingConfirmation(sr, paidCents).catch((e) => console.error('Booking confirmation email failed:', e));
}

const netPaidCents = (sr) => (sr.payments || []).reduce((s, p) => s + (p.amountCents || 0), 0);
const balanceCents = (sr) => Math.max(0, toCents(quoteTotals(sr).total) - netPaidCents(sr));

async function recordBalance(session) {
  const sr = await ServiceRequest.findOne({ externalId: session.metadata?.serviceRequestId });
  if (!sr || sr.payments.some((p) => p.sessionId === session.id)) return;
  sr.payments.push({ kind: 'balance', amountCents: session.amount_total || 0, sessionId: session.id, paymentIntentId: String(session.payment_intent || ''), paidAt: new Date() });
  await sr.save();
}

// Called by the Stripe webhook for sessions tagged kind=event-deposit or event-balance.
async function handleDepositWebhook(event) {
  const session = event.data.object;
  if (session.metadata?.kind === 'event-balance') {
    if (event.type !== 'checkout.session.expired' && session.payment_status === 'paid') await recordBalance(session);
    return;
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (session.payment_status === 'paid') await confirmFromSession(session);
  } else if (event.type === 'checkout.session.expired') {
    await EventBooking.deleteOne({ requestId: session.metadata?.serviceRequestId, status: 'held', stripeSessionId: session.id });
  }
}

function registerDeposits(app, { requireAuth, requireAdmin, serialize, stripe, getFrontendUrl }) {
  app.post('/api/service-requests/:id/pay-deposit', requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ message: 'Online payments are not configured yet.' });
    const sr = await ServiceRequest.findOne({ externalId: req.params.id });
    if (!sr || String(sr.userId) !== String(req.authUser._id)) return res.status(404).json({ message: 'Service request not found.' });
    if (sr.status !== 'accepted') return res.status(409).json({ message: 'Accept the quotation before paying the deposit.' });
    const depositCents = toCents(Math.min(sr.depositAmount, 1e7));
    if (depositCents <= 0 || !sr.event?.eventDate) return res.status(400).json({ message: 'This quote has no deposit or event date.' });

    const problem = await stockProblem(sr, sr.externalId);
    if (problem) return res.status(409).json({ message: problem });
    const hold = await holdDate(sr);
    if (!hold) return res.status(409).json({ message: 'Sorry, that date is no longer available.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: sr.customerEmail,
      expires_at: Math.floor((Date.now() + HOLD_MS + 60 * 1000) / 1000),
      line_items: [{ quantity: 1, price_data: { currency: 'cad', unit_amount: depositCents,
        product_data: { name: `Event deposit ${sr.requestNumber || sr.externalId}`, description: `Event date ${sr.event.eventDate}` } } }],
      metadata: { kind: 'event-deposit', serviceRequestId: sr.externalId },
      payment_intent_data: { metadata: { kind: 'event-deposit', serviceRequestId: sr.externalId } },
      success_url: `${getFrontendUrl()}/dashboard/services?deposit=success`,
      cancel_url: `${getFrontendUrl()}/dashboard/services?deposit=cancelled`,
    });
    await EventBooking.updateOne({ _id: hold._id }, { stripeSessionId: session.id });
    return res.json({ url: session.url });
  });

  app.post('/api/service-requests/:id/pay-balance', requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ message: 'Online payments are not configured yet.' });
    const sr = await ServiceRequest.findOne({ externalId: req.params.id });
    if (!sr || String(sr.userId) !== String(req.authUser._id)) return res.status(404).json({ message: 'Service request not found.' });
    if (sr.status !== 'confirmed') return res.status(409).json({ message: 'Pay the deposit to confirm the booking first.' });
    const remaining = balanceCents(sr);
    if (remaining <= 0) return res.status(409).json({ message: 'Nothing left to pay.' });
    const asked = req.body?.amount === undefined ? remaining : toCents(req.body.amount);
    if (!Number.isFinite(asked) || asked < 100 || asked > remaining) return res.status(400).json({ message: 'Enter an amount between $1.00 and the remaining balance.' });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: sr.customerEmail,
      line_items: [{ quantity: 1, price_data: { currency: 'cad', unit_amount: asked, product_data: { name: `Event payment ${sr.requestNumber || sr.externalId}` } } }],
      metadata: { kind: 'event-balance', serviceRequestId: sr.externalId },
      payment_intent_data: { metadata: { kind: 'event-balance', serviceRequestId: sr.externalId } },
      success_url: `${getFrontendUrl()}/dashboard/services?payment=success`,
      cancel_url: `${getFrontendUrl()}/dashboard/services?payment=cancelled`,
    });
    return res.json({ url: session.url });
  });

  app.post('/api/service-requests/:id/refund', requireAdmin, async (req, res) => {
    if (!stripe) return res.status(503).json({ message: 'Online payments are not configured yet.' });
    const sr = await ServiceRequest.findOne({ externalId: req.params.id });
    const pay = sr?.payments.find((p) => p.sessionId === req.body?.sessionId && p.kind !== 'refund');
    if (!pay?.paymentIntentId) return res.status(404).json({ message: 'Payment not found.' });
    const refunded = sr.payments.filter((p) => p.kind === 'refund' && p.sessionId === pay.sessionId).reduce((s, p) => s - p.amountCents, 0);
    const amount = req.body.amountCents === undefined ? pay.amountCents - refunded : Number(req.body.amountCents);
    if (!Number.isInteger(amount) || amount < 1 || amount > pay.amountCents - refunded) return res.status(400).json({ message: 'Invalid refund amount.' });
    await stripe.refunds.create({ payment_intent: pay.paymentIntentId, amount });
    sr.payments.push({ kind: 'refund', amountCents: -amount, sessionId: pay.sessionId, paymentIntentId: pay.paymentIntentId, paidAt: new Date() });
    await sr.save();
    return res.json({ item: serialize(sr, true) });
  });

  // Printable receipt for one payment; owner or admin.
  app.get('/api/service-requests/:id/receipt/:sessionId', requireAuth, async (req, res) => {
    const sr = await ServiceRequest.findOne({ externalId: req.params.id });
    const u = req.authUser;
    if (!sr || (String(sr.userId) !== String(u._id) && !u.isAdmin)) return res.status(404).json({ message: 'Receipt not found.' });
    const pay = sr.payments.find((p) => p.sessionId === req.params.sessionId);
    if (!pay) return res.status(404).json({ message: 'Receipt not found.' });
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = (c) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(c / 100);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Receipt ${esc(sr.requestNumber)}</title>
      <body style="font-family:sans-serif;max-width:560px;margin:40px auto"><h1>Echo Event Entertainment</h1><h2>Receipt</h2>
      <p>Booking: <strong>${esc(sr.requestNumber || sr.externalId)}</strong><br>Customer: ${esc(sr.customerName)}<br>Event date: ${esc(sr.event?.eventDate)}</p>
      <p>${esc(pay.kind)} payment: <strong>${money(pay.amountCents)}</strong><br>Paid: ${esc(new Date(pay.paidAt).toLocaleString('en-CA', { timeZone: 'America/Toronto' }))}<br>Reference: ${esc(pay.sessionId)}</p></body>`);
  });

  app.get('/api/bookings/confirmed', requireAdmin, async (_req, res) => {
    const items = await EventBooking.find({ status: 'confirmed' }).sort({ eventDate: 1 });
    const reqs = await ServiceRequest.find({ externalId: { $in: items.map((b) => b.requestId) } });
    const byId = new Map(reqs.map((r) => [r.externalId, r]));
    res.json({ items: items.map((b) => ({ eventDate: b.eventDate, requestId: b.requestId, customerName: byId.get(b.requestId)?.customerName || '',
      venue: byId.get(b.requestId)?.event?.venueName || '', equipment: b.equipment, paidAt: b.paidAt })) });
  });
}

module.exports = { EventBooking, handleDepositWebhook, registerDeposits };
