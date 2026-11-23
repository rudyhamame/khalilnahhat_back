const { z } = require('zod');
const { ServiceRequest } = require('./models');
const { sendQuoteExpiryReminder } = require('./brevo');
const { sendBookingDecision } = require('./booking-process-mail');
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

// Permanently removes a booking, and with it everything the client sees of it. It also releases what the booking held: its date and
// equipment (the confirmed-booking record) and any call booked for it. Uploaded files are cleaned up by the shared permanent-deletion path.
// A booking with recorded payments is refused: void them first, so a financial record is never lost by accident.
async function deleteBooking(sr, { EventBooking, Meeting, remove }) {
  if ((sr.payments || []).some((payment) => !payment.voided)) throw Object.assign(new Error('This booking has recorded payments. Void them first, then delete it.'), { status: 409 });
  await EventBooking.deleteOne({ requestId: sr.externalId });
  await Meeting.updateMany({ bookingRequestId: sr.externalId }, { status: 'open', bookedBy: null, bookedByName: '', bookedByEmail: '', topic: '', bookingRequestId: null, callMethod: '', contactPhone: '', reminderSentAt: null });
  const removed = await remove({ externalId: sr.externalId });
  return { deleted: Boolean(removed), cloudinaryCleanupPending: Boolean(removed?.cloudinaryCleanupPending) };
}

function registerQuoteLifecycle(app, { requireAuth, requireAdmin, serialize, Model = ServiceRequest, sendDecision = sendBookingDecision }) {
  const find = (id) => Model.findOne({ externalId: id });
  const notFound = (res) => res.status(404).json({ message: 'Service request not found.' });
  const own = (req, sr) => sr && String(sr.userId) === String(req.authUser._id);

  app.post('/api/service-requests/:id/admin-review', requireAdmin, async (req, res) => {
    const parsed = z.object({ decision: z.enum(['accept', 'decline']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({message:'Choose Accept or Decline.'});
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    if (sr.status !== STATUS.PENDING || sr.availabilityAcceptedAt) return res.status(409).json({message:'This request has already been reviewed.'});
    if (parsed.data.decision === 'accept') sr.availabilityAcceptedAt = new Date();
    else { sr.status = STATUS.CANCELLED; sr.declinedBy = 'admin'; }
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    const mail = await sendDecision(sr, parsed.data.decision === 'accept' ? 'available' : 'declined').catch(() => ({sent:false}));
    return res.json({item:serialize(sr,true), notificationSent:!!mail.sent});
  });

  app.post('/api/service-requests/:id/decline', requireAuth, async (req,res) => {
    const sr = await find(req.params.id);
    if (!own(req,sr)) return notFound(res);
    if (isExpired(sr) || !journey.rule(sr.status).canNegotiate) return res.status(409).json({message:'This request can no longer be declined.'});
    sr.status = STATUS.CANCELLED; sr.declinedBy = 'client';
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    const mail = await sendDecision(sr,'declined').catch(() => ({sent:false}));
    return res.json({item:serialize(sr,false),notificationSent:!!mail.sent});
  });

  app.post('/api/service-requests/:id/accept', requireAuth, async (req, res) => {
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    if (isExpired(sr)) {
      sr.status = STATUS.EXPIRED;
      try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    }
    if (!journey.rule(sr.status).awaitingClient) return res.status(409).json({ message: `This quote is ${sr.status.replace('_', ' ')} and cannot be accepted.` });
    if(req.body?.quoteRevision!==undefined && req.body.quoteRevision!==(sr.quoteRevision||0))return res.status(409).json({message:'The quote changed. Review the latest prices before accepting.'});
    sr.status = STATUS.ACCEPTED;
    sr.acceptedAt = new Date();
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
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
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
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
    if(sr.negotiation && !sr.negotiation.resolvedAt)return res.status(409).json({message:'Review the client offer and publish a revised quote before extending.'});
    const base = journey.rule(sr.status).expires && sr.expiresAt > new Date() ? sr.expiresAt.getTime() : Date.now();
    sr.expiresAt = new Date(base + parsed.data.days * DAY_MS);
    sr.status = STATUS.QUOTED;
    sr.quoteRevision=(sr.quoteRevision||0)+1;
    sr.reminderSentAt = null;
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    return res.json({ item: serialize(sr, true) });
  });

  app.post('/api/service-requests/:id/cancel', requireAdmin, async (req, res) => {
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    sr.status = STATUS.CANCELLED;
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    return res.json({ item: serialize(sr, true) });
  });

  app.post('/api/service-requests/:id/delete', requireAdmin, async (req, res) => {
    if (req.body?.confirmation !== 'DELETE') return res.status(400).json({ message: 'Confirm that you want to permanently delete this booking.' });
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    try {
      const { EventBooking } = require('./payments'), { Meeting } = require('./meetings'), permanent = require('./permanent-deletion');
      const result = await deleteBooking(sr, { EventBooking, Meeting, remove: (filter) => permanent.remove(Model, filter) });
      console.info('Booking deleted by an administrator:', sr.externalId);
      return res.json(result);
    } catch (error) {
      if (error.status === 409) return res.status(409).json({ message: error.message });
      throw error;
    }
  });

  if (require.main?.filename?.endsWith('server.js')) {
    setInterval(() => sweepQuotes().catch((e) => console.error('Quote sweep failed:', e)), SWEEP_MS).unref();
  }
}

module.exports = { DAY_MS, quoteTotals, registerQuoteLifecycle, sweepQuotes, isExpired, deleteBooking };
