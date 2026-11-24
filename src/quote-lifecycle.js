const { z } = require('zod');
const { ServiceRequest } = require('./models');
const { sendQuoteExpiryReminder } = require('./brevo');
const { sendBookingDecision, sendBookingRequested } = require('./booking-process-mail');
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

function registerQuoteLifecycle(app, { requireAuth, requireAdmin, serialize, Model = ServiceRequest, sendDecision = sendBookingDecision, sendRequested = sendBookingRequested }) {
  const find = (id) => Model.findOne({ externalId: id });
  const notFound = (res) => res.status(404).json({ message: 'Service request not found.' });
  const own = (req, sr) => sr && String(sr.userId) === String(req.authUser._id);

  app.post('/api/service-requests/:id/admin-review', requireAdmin, async (req, res) => {
    const parsed = z.object({ decision: z.enum(['accept', 'decline', 'unavailable']), reason:z.string().trim().max(2000).optional(), quoteRevision:z.number().int().nonnegative().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({message:'Choose an availability decision and a valid reason.'});
    if(parsed.data.decision==='unavailable'&&!parsed.data.reason)return res.status(400).json({message:'Explain why the requested date and time are not available.'});
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    if(!journey.rule(sr.status).repriceable||(sr.payments||[]).some(p=>!p.voided))return res.status(409).json({message:'Availability cannot be changed for a paid or closed booking.'});
    if(parsed.data.quoteRevision!==undefined&&parsed.data.quoteRevision!==(sr.quoteRevision||0))return res.status(409).json({message:'The booking changed. Reload before informing availability.'});
    const availability=require('./booking-availability'),previous=availability.availabilityFor(sr);
    if(parsed.data.decision==='accept'&&previous.status==='available')return res.status(409).json({message:'Availability has already been confirmed for this date and time.'});
    if(previous.informedAt)sr.availabilityHistory=[...(sr.availabilityHistory||[]),{...previous,window:sr.availabilityWindow,changedAt:new Date()}];
    if (parsed.data.decision === 'accept') {sr.availabilityAcceptedAt = new Date();sr.availabilityUnavailableAt=null;sr.availabilityReason='';}
    else if(parsed.data.decision==='unavailable'){
      sr.availabilityAcceptedAt=null;sr.availabilityUnavailableAt=new Date();sr.availabilityReason=parsed.data.reason;
      sr.status=STATUS.PENDING;sr.acceptedAt=null;sr.expiresAt=null;sr.reminderSentAt=null;
    }else{sr.status=STATUS.CANCELLED;sr.declinedBy='admin';}
    sr.availabilityWindow=availability.windowKey(sr);
    if(parsed.data.decision!=='accept')sr.quoteRevision=(sr.quoteRevision||0)+1;
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    const decision=parsed.data.decision==='accept'?'available':parsed.data.decision==='unavailable'?'unavailable':'declined';
    const mail = await sendDecision(sr, decision).catch(() => ({sent:false}));
    return res.json({item:serialize(sr,true), notificationSent:!!mail.sent});
  });

  // Admin steps a booking back one stage: quote ready -> availability confirmed ("available"), or availability -> requested.
  // Refused once a payment is recorded (same rule as admin-review), so a booked/paid request is never rolled back.
  app.post('/api/service-requests/:id/step-back', requireAdmin, async (req, res) => {
    const parsed = z.object({ to: z.enum(['available', 'requested']), quoteRevision: z.number().int().nonnegative().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Choose a stage to go back to.' });
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    if (!journey.rule(sr.status).repriceable || (sr.payments || []).some(p => !p.voided)) return res.status(409).json({ message: 'A paid, booked or closed booking cannot be taken back.' });
    if (parsed.data.quoteRevision !== undefined && parsed.data.quoteRevision !== (sr.quoteRevision || 0)) return res.status(409).json({ message: 'The booking changed. Reload before continuing.' });
    const availability = require('./booking-availability'), previous = availability.availabilityFor(sr);
    if (parsed.data.to === 'available' && (previous.status !== 'available' || !journey.rule(sr.status).showsPrices)) return res.status(409).json({ message: 'Only a booking with a quote ready can go back to availability.' });
    if (parsed.data.to === 'requested' && !previous.informedAt) return res.status(409).json({ message: 'This booking is already at the requested stage.' });
    if (previous.informedAt) sr.availabilityHistory = [...(sr.availabilityHistory || []), { ...previous, window: sr.availabilityWindow, changedAt: new Date() }];
    if (parsed.data.to === 'requested') { sr.availabilityAcceptedAt = null; sr.availabilityUnavailableAt = null; sr.availabilityReason = ''; }
    sr.status = STATUS.PENDING; sr.acceptedAt = null; sr.expiresAt = null; sr.reminderSentAt = null;
    sr.quoteRevision = (sr.quoteRevision || 0) + 1; // stale client accept/negotiate calls on the withdrawn quote fail
    try { await sr.save(); } catch (error) { if (error.name === 'VersionError') return res.status(409).json({ message: 'The booking changed. Reload before continuing.' }); throw error; }
    return res.json({ item: serialize(sr, true) });
  });

  // The client edits ONE data atom of their own booking. Atoms that change what was priced or checked (date, time, venue, guests, event type)
  // send the booking back for a new availability check and withdraw the quote, only after the client acknowledges it; they are refused once a payment exists.
  // Service/equipment selections are priced items, so they stay on the "Request changes" flow.
  const eventOrder = require('./event-order');
  const PRICED = new Set(['services', 'equipment', 'music.djRequested', 'music.mcRequested', 'rental.requested']);
  const READ_ONLY = new Set(['customer.email', 'event.venue.latitude', 'event.venue.longitude', 'event.venue.source', 'event.venue.sourceId', 'event.venue.sourceAttribution']);
  const AFFECTS_AVAILABILITY = path => /^event\.(type|title|date|startTime|endTime|guestCount|venue\.|setup\.)/.test(path);
  app.post('/api/service-requests/:id/order-edit', requireAuth, async (req, res) => {
    const parsed = z.object({ path: z.string().max(80), value: z.any(), quoteRevision: z.number().int().nonnegative().optional(), acknowledgeReset: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Choose a detail and its new value.' });
    const { path, value } = parsed.data;
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    if (!sr.order || sr.status === STATUS.CANCELLED) return res.status(409).json({ message: 'This booking can no longer be edited.' });
    const field = eventOrder.fields.find(item => item.key === path);
    if (!field || READ_ONLY.has(path) || path.startsWith('customer.')) return res.status(400).json({ message: 'Personal info comes from your account. Change it in your account, not in the booking.' });
    if (PRICED.has(path) || field.type === 'attachments') return res.status(400).json({ message: 'Use "Request changes" to change your services, equipment or files.' });
    if (!eventOrder.validValue(field, value)) return res.status(400).json({ message: 'That value is not valid for this detail.' });
    if (parsed.data.quoteRevision !== undefined && parsed.data.quoteRevision !== (sr.quoteRevision || 0)) return res.status(409).json({ message: 'The booking changed. Reload before editing.' });
    const availability = require('./booking-availability'), previous = availability.availabilityFor(sr);
    const reset = AFFECTS_AVAILABILITY(path) && (previous.informedAt || journey.rule(sr.status).showsPrices);
    if (AFFECTS_AVAILABILITY(path) && (sr.payments || []).some(p => !p.voided)) return res.status(409).json({ message: 'This detail changes your date, venue or event. Contact us to change it after a payment.' });
    if (reset && !parsed.data.acknowledgeReset) return res.status(409).json({ code: 'RESET_REQUIRED', message: 'Changing this sends your booking back for a new availability check and withdraws the quote.' });
    const next = structuredClone(sr.order.toObject ? sr.order.toObject() : sr.order);
    const keys = path.split('.'); let target = next; for (const key of keys.slice(0, -1)) target = target[key] = target[key] && typeof target[key] === 'object' ? target[key] : {};
    target[keys.at(-1)] = value;
    const errors = eventOrder.validateEventOrder(next);
    if (errors.length) return res.status(400).json({ message: 'That change leaves the booking incomplete or invalid.', fields: errors });
    const legacy = require('./quote-validation').eventSchema.safeParse(eventOrder.orderToLegacy(next));
    if (!legacy.success) return res.status(400).json({ message: 'Event details failed validation.' });
    sr.order = next; sr.event = legacy.data;
    if (reset) {
      if (previous.informedAt) sr.availabilityHistory = [...(sr.availabilityHistory || []), { ...previous, window: sr.availabilityWindow, changedAt: new Date() }];
      sr.availabilityAcceptedAt = null; sr.availabilityUnavailableAt = null; sr.availabilityReason = ''; sr.availabilityWindow = '';
      sr.status = STATUS.PENDING; sr.acceptedAt = null; sr.expiresAt = null; sr.reminderSentAt = null; sr.quoteRevision = (sr.quoteRevision || 0) + 1;
    }
    try { await sr.save(); } catch (error) { if (error.name === 'VersionError') return res.status(409).json({ message: 'The booking changed. Reload before continuing.' }); throw error; }
    return res.json({ item: serialize(sr, false), reset });
  });

  app.post('/api/service-requests/:id/reschedule-request',requireAuth,async(req,res)=>{
    const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
    const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
    const parsed=z.object({date,startTime:time,endTime:time,quoteRevision:z.number().int().nonnegative()}).strict().safeParse(req.body);
    if(!parsed.success||parsed.data.startTime===parsed.data.endTime)return res.status(400).json({message:'Choose a valid date, start time and end time.'});
    const sr=await find(req.params.id);if(!own(req,sr))return notFound(res);
    const availability=require('./booking-availability'),previous=availability.availabilityFor(sr);
    if(previous.status!=='unavailable'||!journey.rule(sr.status).repriceable||(sr.payments||[]).some(p=>!p.voided))return res.status(409).json({message:'A different date can only be requested after the current date is marked not available.'});
    if(parsed.data.quoteRevision!==(sr.quoteRevision||0))return res.status(409).json({message:'The booking changed. Reload before choosing another date.'});
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(parsed.data.date<today)return res.status(400).json({message:'Choose today or a future date.'});
    const next={...availability.windowFor(sr),date:parsed.data.date,startTime:parsed.data.startTime,endTime:parsed.data.endTime};
    if(JSON.stringify(next)===availability.windowKey(sr))return res.status(400).json({message:'Choose a different date or time.'});
    sr.availabilityHistory=[...(sr.availabilityHistory||[]),{...previous,window:sr.availabilityWindow,changedAt:new Date()}];
    sr.order={...(sr.order||{}),event:{...(sr.order?.event||{}),...next}};
    sr.event={...(sr.event||{}),eventDate:next.date,startTime:next.startTime,endTime:next.endTime,timezone:next.timezone};
    sr.availabilityAcceptedAt=null;sr.availabilityUnavailableAt=null;sr.availabilityReason='';sr.availabilityWindow='';
    sr.status=STATUS.PENDING;sr.acceptedAt=null;sr.expiresAt=null;sr.reminderSentAt=null;sr.quoteRevision=(sr.quoteRevision||0)+1;
    sr.markModified?.('order');sr.markModified?.('event');
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before trying again.'});throw error;}
    const notification=await sendRequested(sr).catch(()=>({sent:false}));
    return res.json({item:serialize(sr,false),notificationSent:Boolean(notification.sent)});
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
    try{require('./booking-availability').requireAvailability(sr);}catch(error){return res.status(error.status).json({message:error.message,code:error.code});}
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
