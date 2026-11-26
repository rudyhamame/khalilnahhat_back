const { z } = require('zod');
const { ServiceRequest } = require('./models');
const { sendQuoteExpiryReminder } = require('./brevo');
const { sendBookingDecision, sendBookingRequested } = require('./booking-process-mail');
const { notifyBooking } = require('./booking-events-mail');
const { notificationEmails } = require('./notification-emails');

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;

const {quoteTotals}=require('./quote-totals');
const journey = require('./booking-journey');
const { STATUS } = journey;

const isExpired = (sr) => journey.rule(sr.status).expires && sr.expiresAt && sr.expiresAt <= new Date();

// Expire overdue quotes and send each enabled reminder within its configured window.
async function sweepQuotes({notifications=notificationEmails,Model=ServiceRequest,send=sendQuoteExpiryReminder,clock=Date.now,notify=notifyBooking} = {}) {
  const now = new Date(clock());
  const expiring = typeof Model.find === 'function' ? await Model.find({ status: { $in: journey.statusesWhere('expires') }, expiresAt: { $lte: now } }) : [];
  await Model.updateMany({ status: { $in: journey.statusesWhere('expires') }, expiresAt: { $lte: now } }, { status: STATUS.EXPIRED });
  for (const sr of expiring) { sr.status = STATUS.EXPIRED; void notify(sr, 'booking-quote-expired'); }
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

function registerQuoteLifecycle(app, { requireAuth, requireAdmin, serialize, Model = ServiceRequest, sendDecision = sendBookingDecision, sendRequested = sendBookingRequested, notify = notifyBooking }) {
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
    sr.status = STATUS.PENDING; sr.acceptedAt = null; sr.expiresAt = null; sr.reminderSentAt = null; sr.changeRequestedAt = null;
    sr.quoteRevision = (sr.quoteRevision || 0) + 1; // stale client accept/negotiate calls on the withdrawn quote fail
    try { await sr.save(); } catch (error) { if (error.name === 'VersionError') return res.status(409).json({ message: 'The booking changed. Reload before continuing.' }); throw error; }
    void notify(sr, parsed.data.to === 'requested' ? 'booking-step-back-requested' : 'booking-step-back-available');
    return res.json({ item: serialize(sr, true) });
  });

  // The client edits ONE data atom of their own booking. Atoms that change what was priced or checked (date, time, venue, guests, event type)
  // send the booking back for a new availability check and withdraw the quote, only after the client acknowledges it; they are refused once a payment exists.
  // Service/equipment selections are priced items, so they stay on the "Request changes" flow.
  const eventOrder = require('./event-order');
  const PRICED = new Set(['services', 'equipment', 'music.djRequested', 'music.mcRequested', 'rental.requested']);
  const READ_ONLY = new Set(['customer.email', 'event.venue.latitude', 'event.venue.longitude', 'event.venue.source', 'event.venue.sourceId', 'event.venue.sourceAttribution']);
  const AFFECTS_AVAILABILITY = path => /^event\.(type|title|date|startTime|endTime|guestCount|venue\.|setup\.)/.test(path);
  // One handler for both: the owner edits their own booking; an administrator edits any booking from the admin Booking pages.
  const orderEdit = (admin) => async (req, res) => {
    const parsed = z.object({ path: z.string().max(80), value: z.any(), quoteRevision: z.number().int().nonnegative().optional(), acknowledgeReset: z.boolean().optional(), place: z.record(z.any()).optional(), countsAsModification: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Choose a detail and its new value.' });
    const { path } = parsed.data; const value = path === 'event.venue.postalCode' && typeof parsed.data.value === 'string' ? parsed.data.value.toUpperCase() : parsed.data.value; // postal codes are always capitals
    const sr = await find(req.params.id);
    if (!admin && !own(req, sr)) return notFound(res);
    if (!sr) return notFound(res);
    if (!sr.order || sr.status === STATUS.CANCELLED) return res.status(409).json({ message: 'This booking can no longer be edited.' });
    const field = eventOrder.fields.find(item => item.key === path);
    if (!field || READ_ONLY.has(path) || path.startsWith('customer.')) return res.status(400).json({ message: 'Personal info comes from your account. Change it in your account, not in the booking.' });
    if (PRICED.has(path)) return res.status(400).json({ message: 'Use "Request changes" to change your services or equipment.' });
    if (!eventOrder.validValue(field, value)) return res.status(400).json({ message: 'That value is not valid for this detail.' });
    if (parsed.data.quoteRevision !== undefined && parsed.data.quoteRevision !== (sr.quoteRevision || 0)) return res.status(409).json({ message: 'The booking changed. Reload before editing.' });
    const availability = require('./booking-availability'), previous = availability.availabilityFor(sr);
    const reset = AFFECTS_AVAILABILITY(path) && (previous.informedAt || journey.rule(sr.status).showsPrices);
    if (AFFECTS_AVAILABILITY(path) && (sr.payments || []).some(p => !p.voided)) return res.status(409).json({ message: 'This detail changes your date, venue or event. Contact us to change it after a payment.' });
    if (reset && !parsed.data.acknowledgeReset) return res.status(409).json({ code: 'RESET_REQUIRED', message: 'Changing this sends your booking back for a new availability check and withdraws the quote.' });
    const next = structuredClone(sr.order.toObject ? sr.order.toObject() : sr.order);
    const keys = path.split('.'); let target = next; for (const key of keys.slice(0, -1)) target = target[key] = target[key] && typeof target[key] === 'object' ? target[key] : {};
    target[keys.at(-1)] = value;
    // A venue picked from the place search also carries its address, city and map position (the read-only atoms are only ever set this way).
    if (path === 'event.venue.name' && parsed.data.place) { const p = parsed.data.place; for (const k of ['address', 'city', 'postalCode', 'country', 'source', 'sourceId', 'sourceAttribution']) if (typeof p[k] === 'string') target[k] = (k === 'postalCode' ? p[k].toUpperCase() : p[k]).slice(0, 240); for (const k of ['latitude', 'longitude']) if (Number.isFinite(p[k])) target[k] = p[k]; }
    const errors = eventOrder.validateEventOrder(next);
    if (errors.length) return res.status(400).json({ message: 'That change leaves the booking incomplete or invalid.', fields: errors });
    const legacy = require('./quote-validation').eventSchema.safeParse(eventOrder.orderToLegacy(next));
    if (!legacy.success) return res.status(400).json({ message: 'Event details failed validation.' });
    // One history entry per Save modification: the order before it and, once its edits are in, the order after it. Undo reverts just that entry's changes.
    let history = [...(sr.modificationHistory || [])];
    if (parsed.data.countsAsModification !== false) {
      history = history.slice(-19).concat({ at: new Date(), before: structuredClone(sr.order.toObject ? sr.order.toObject() : sr.order), event: structuredClone(sr.event?.toObject ? sr.event.toObject() : sr.event), after: null });
      sr.modificationCount = (sr.modificationCount || 0) + 1;
    }
    if (history.length) history[history.length - 1] = { ...history.at(-1), after: structuredClone(next) };
    sr.modificationHistory = history;
    sr.order = next; sr.event = legacy.data; sr.modifiedAt = new Date();
    if (reset) {
      if (previous.informedAt) sr.availabilityHistory = [...(sr.availabilityHistory || []), { ...previous, window: sr.availabilityWindow, changedAt: new Date() }];
      sr.availabilityAcceptedAt = null; sr.availabilityUnavailableAt = null; sr.availabilityReason = ''; sr.availabilityWindow = '';
      sr.status = STATUS.PENDING; sr.acceptedAt = null; sr.expiresAt = null; sr.reminderSentAt = null; sr.quoteRevision = (sr.quoteRevision || 0) + 1;
    }
    try { await sr.save(); } catch (error) { if (error.name === 'VersionError') return res.status(409).json({ message: 'The booking changed. Reload before continuing.' }); throw error; }
    // A client's modification sends no notification email.
    return res.json({ item: serialize(sr, admin), reset });
  };
  app.post('/api/service-requests/:id/order-edit', requireAuth, orderEdit(false));
  app.post('/api/service-requests/:id/admin-order-edit', requireAdmin, orderEdit(true));

  // Reverts ONE saved modification (by its position in the list; the newest that can be undone when none is given). It stays in the list, struck through.
  const changedPaths = (before, after) => { const out = []; const walk = (x, y, path) => {
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) { for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[key], y[key], path ? `${path}.${key}` : key); }
    else if (path && JSON.stringify(x) !== JSON.stringify(y)) out.push(path);
  }; walk(before, after, ''); return out; };
  const valueAt = (source, path) => path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), source);
  app.post('/api/service-requests/:id/undo-modification', requireAuth, async (req, res) => {
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    const history = [...(sr.modificationHistory || [])];
    const before = (entry) => entry.before || entry.order; // entries saved by the first version kept only "order"
    let index = Number.isInteger(req.body?.index) ? req.body.index : -1;
    if (index < 0) history.forEach((entry, i) => { if (!entry.undoneAt && before(entry)) index = i; });
    const entry = history[index];
    if (!entry || entry.undoneAt || !before(entry) || sr.status === STATUS.CANCELLED) return res.status(409).json({ message: 'There is no modification to undo.' });
    if ((sr.payments || []).some(p => !p.voided)) return res.status(409).json({ message: 'This booking has a payment. Contact us to change it.' });
    const after = entry.after || (history[index + 1] && before(history[index + 1])) || (sr.order.toObject ? sr.order.toObject() : sr.order);
    const next = structuredClone(sr.order.toObject ? sr.order.toObject() : sr.order);
    for (const path of changedPaths(before(entry), after)) { // put back only what this modification changed
      const keys = path.split('.'); let target = next; for (const key of keys.slice(0, -1)) target = target[key] = target[key] && typeof target[key] === 'object' ? target[key] : {};
      const old = valueAt(before(entry), path); target[keys.at(-1)] = old === undefined ? null : structuredClone(old);
    }
    if (eventOrder.validateEventOrder(next).length) return res.status(409).json({ message: 'Undoing that would leave the booking incomplete. Undo the later changes first.' });
    const legacy = require('./quote-validation').eventSchema.safeParse(eventOrder.orderToLegacy(next));
    if (!legacy.success) return res.status(409).json({ message: 'Event details failed validation.' });
    history[index] = { at: entry.at, undoneAt: new Date() };
    sr.order = next; sr.event = legacy.data; sr.modificationHistory = history; sr.modificationCount = Math.max(0, (sr.modificationCount || 1) - 1);
    sr.modifiedAt = history.some((item) => !item.undoneAt) ? new Date() : null; // everything undone: the booking is no longer "modified"
    try { await sr.save(); } catch (error) { if (error.name === 'VersionError') return res.status(409).json({ message: 'The booking changed. Reload before continuing.' }); throw error; }
    return res.json({ item: serialize(sr, false) });
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
    if (isExpired(sr) || sr.status === STATUS.EXPIRED || !journey.rule(sr.status).cancellable) return res.status(409).json({message:'This request can no longer be canceled.'});
    { const d = journey.describeRequest(sr); sr.cancelledAtStage = (d.clientStatus === 'modified' ? d.previousClientStatus : d.clientStatus) || ''; } sr.cancelledAt = new Date(); // the step the booking was really at (a client edit is not a step of its own)
    sr.cancelledFromStatus = sr.status; sr.status = STATUS.CANCELLED; sr.declinedBy = 'client';
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    const mail = await notify(sr,'booking-withdrawn'); void notify(sr,'booking-withdrawn-admin');
    return res.json({item:serialize(sr,false),notificationSent:!!mail?.sent});
  });

  // The client steps BACK through their own decisions (never the team's): undo the acceptance or the best-offer request (the quote awaits their decision again),
  // or restore a booking they cancelled to the status it had. Refused once money is recorded, once the quote lapsed, or when the date could have been taken (a confirmed booking).
  app.post('/api/service-requests/:id/client-step-back', requireAuth, async (req, res) => {
    const parsed = z.object({ to: z.enum(['quote', 'restore']), quoteRevision: z.number().int().nonnegative().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Choose a step to go back to.' });
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    const paid = (sr.payments || []).some(p => !p.voided);
    if (parsed.data.quoteRevision !== undefined && parsed.data.quoteRevision !== (sr.quoteRevision || 0)) return res.status(409).json({ message: 'The booking changed. Reload before continuing.' });
    if (parsed.data.to === 'quote') {
      if (![STATUS.ACCEPTED, STATUS.CHANGES_REQUESTED].includes(sr.status) || paid) return res.status(409).json({ message: 'This decision can no longer be undone.' });
      if (sr.expiresAt && sr.expiresAt <= new Date()) return res.status(409).json({ message: 'This quote has expired. Contact us to reactivate it.' });
      sr.status = STATUS.QUOTED; sr.acceptedAt = null; sr.changeRequest = ''; sr.changeRequestedAt = null;
    } else {
      const back = sr.cancelledFromStatus;
      if (sr.status !== STATUS.CANCELLED || sr.declinedBy !== 'client' || !back || !journey.rule(back).cancellable || journey.rule(back).isBooked || paid) return res.status(409).json({ message: 'This booking can no longer be restored. Contact us.' });
      sr.status = back; sr.declinedBy = ''; sr.cancelledAt = null; sr.cancelledAtStage = ''; sr.cancelledFromStatus = '';
    }
    try { await sr.save(); } catch (error) { if (error.name === 'VersionError') return res.status(409).json({ message: 'The booking changed. Reload before continuing.' }); throw error; }
    return res.json({ item: serialize(sr, false) });
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
    void notify(sr,'booking-quote-accepted'); void notify(sr,'booking-accepted-admin');
    return res.json({ item: serialize(sr, false) });
  });

  app.post('/api/service-requests/:id/request-changes', requireAuth, async (req, res) => {
    const parsed = z.object({ message: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Describe the changes you need.' });
    const sr = await find(req.params.id);
    if (!own(req, sr)) return notFound(res);
    if (isExpired(sr) || !journey.rule(sr.status).awaitingClient) return res.status(409).json({ message: 'Only an active quote can be changed.' });
    sr.status = STATUS.CHANGES_REQUESTED;
    sr.changeRequest = parsed.data.message; sr.changeRequestedAt = new Date();
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    void notify(sr,'booking-changes-requested',{message:sr.changeRequest}); void notify(sr,'booking-changes-requested-admin',{message:sr.changeRequest});
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
    void notify(sr,'booking-quote-extended');
    return res.json({ item: serialize(sr, true) });
  });

  app.post('/api/service-requests/:id/cancel', requireAdmin, async (req, res) => {
    const sr = await find(req.params.id);
    if (!sr) return notFound(res);
    { const d = journey.describeRequest(sr); sr.cancelledAtStage = (d.clientStatus === 'modified' ? d.previousClientStatus : d.clientStatus) || ''; } sr.cancelledAt = new Date(); // the step the booking was really at (a client edit is not a step of its own)
    sr.status = STATUS.CANCELLED;
    try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Reload before continuing.'});throw error;}
    void notify(sr,'booking-cancelled');
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
