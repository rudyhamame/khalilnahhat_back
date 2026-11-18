// Loads the existing catalog (Equipment, services, ServicePrice) as engine offerings and manages admin-defined pricing policies.
// Existing prices are exposed as "legacy" policies (priority -1) so nothing needs migrating and no rate is invented: price 0 = no policy.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { z } = require('zod');
const { checkAvailability, reservationWindow } = require('./inventory-availability');
const { calculateBookingPrice, eventHours, suggestUnitPrices, reservationDemand, validatePolicy, MODES, OPERATORS, ADJUSTMENTS } = require('./pricing-engine');

const policySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true }, offeringId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true }, pricingMode: { type: String, enum: MODES, required: true },
  currency: { type: String, default: 'CAD' }, baseAmountCents: { type: Number, default: 0 }, minimumDuration: Number,
  includedQuantity: Number, additionalUnitRateCents: Number, tiers: { type: [new mongoose.Schema({ from: Number, to: Number, rateCents: Number }, { _id: false })], default: [] },
  effectiveFrom: String, effectiveUntil: String, priority: { type: Number, default: 0 }, status: { type: String, enum: ['active', 'draft'], default: 'draft' },
  conditions: { type: [new mongoose.Schema({ field: String, operator: String, value: mongoose.Schema.Types.Mixed, adjustmentType: String, adjustmentValue: Number, priority: Number }, { _id: false })], default: [] },
  version: { type: Number, default: 1 },
}, { timestamps: true });
const PricingPolicy = mongoose.models.PricingPolicy || mongoose.model('PricingPolicy', policySchema);

const cents = z.number().int().min(0).max(100000000);
const policyInput = z.object({
  offeringId: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160), pricingMode: z.enum(MODES), currency: z.enum(['CAD', 'USD']).default('CAD'),
  baseAmountCents: cents.default(0), minimumDuration: z.number().min(0).max(240).optional(), includedQuantity: z.number().int().min(1).optional(), additionalUnitRateCents: cents.optional(),
  tiers: z.array(z.object({ from: z.number().int().min(1), to: z.number().int().nullable().optional(), rateCents: cents })).max(20).default([]),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), effectiveUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  priority: z.number().int().min(0).max(1000).default(0), status: z.enum(['active', 'draft']).default('draft'),
  conditions: z.array(z.object({ field: z.string().trim().min(1).max(60), operator: z.enum(OPERATORS), value: z.any(), adjustmentType: z.enum(ADJUSTMENTS), adjustmentValue: z.number().finite(), priority: z.number().int().default(0) })).max(30).default([]),
}).strict();

async function loadContext() {
  const { Equipment } = require('./equipment'), { ServicePrice } = require('./models'), setup = require('./setup-catalog');
  const [equipment, services, prices, explicit] = await Promise.all([Equipment.find().lean(), setup.list(true), ServicePrice.find().lean(), PricingPolicy.find().lean()]);
  const priceBy = new Map(prices.map((p) => [p.serviceId, p.amountCents]));
  const offerings = [], legacy = [];
  const legacyPolicy = (offeringId, name, mode, amount) => amount > 0 && legacy.push({ id: `legacy:${offeringId}`, offeringId, name: `${name} (existing price)`, pricingMode: mode, baseAmountCents: amount, status: 'active', priority: -1, version: 1, legacy: true });
  for (const s of services.filter((row) => row.kind === 'service')) {
    const id = `svc-${s.id}`;
    offerings.push({ id, name: s.name, type: 'service', category: s.category || 'service', isActive: s.isActive !== false, stock: 1, components: [] }); // one performer per service: staff capacity 1
    legacyPolicy(id, s.name, 'fixed', priceBy.get(s.priceId) || 0);
  }
  for (const e of equipment) {
    const pkg = Boolean(e.isSet || (e.setItems || []).length);
    offerings.push({ id: e.slug, name: e.name, type: pkg ? 'package' : 'equipment', category: e.category, brandModel: e.brandModel || '', isActive: e.isActive !== false, minQuantity: e.minQuantity || 1,
      stock: e.stockTracked ? e.quantityOwned : null, components: (e.setItems || []).map((m) => ({ offeringId: m.equipmentId, quantity: m.quantity, inclusion: 'included' })) });
    legacyPolicy(e.slug, e.name, pkg ? 'fixed' : 'per_unit', e.priceCents || priceBy.get(e.slug) || 0);
  }
  return { offerings, policies: [...explicit.map(({ _id, __v, ...p }) => p), ...legacy], explicit: explicit.map(({ _id, __v, ...p }) => p), today: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Data-quality report for administrators. Nothing is merged or changed automatically.
function review(ctx) {
  const issues = [], add = (severity, offeringId, message) => issues.push({ severity, offeringId, message });
  const byId = new Map(ctx.offerings.map((o) => [o.id, o]));
  const priced = new Set(ctx.policies.filter((p) => p.status === 'active').map((p) => p.offeringId));
  for (const o of ctx.offerings.filter((x) => x.isActive)) {
    if (!priced.has(o.id) && !(o.components.length)) add('warning', o.id, `${o.name}: no price set up; bookings will need a manual quote.`);
    for (const c of o.components) if (!byId.has(c.offeringId)) add('error', o.id, `${o.name}: component "${c.offeringId}" does not exist.`);
    if (/led|screen|wall/.test(norm(o.category + ' ' + o.name)) && o.type === 'equipment') add('info', o.id, `${o.name}: the measurement unit (panel, m², screen) needs verification before pricing.`);
    if (o.type === 'package' && o.stock != null) add('info', o.id, `${o.name}: a package's availability should come from its components, not its own stock count.`);
    try { calculateBookingPrice({ selections: [{ offeringId: o.id, quantity: o.minQuantity || 1 }] }, ctx); } catch (e) { add('error', o.id, `${o.name}: ${e.message}`); }
  }
  const groups = new Map();
  for (const o of ctx.offerings.filter((x) => x.type !== 'service')) { const k = norm(o.name); groups.set(k, [...(groups.get(k) || []), o]); }
  for (const [name, rows] of groups) if (rows.length > 1) add('warning', rows[0].id, `Possible duplicates for review: ${rows.map((r) => `${r.name} [${r.id}, ${r.category}]`).join('; ')}.`);
  const models = new Map();
  for (const o of ctx.offerings.filter((x) => x.brandModel)) models.set(norm(o.brandModel), [...(models.get(norm(o.brandModel)) || []), o]);
  for (const rows of models.values()) if (rows.length > 1 && new Set(rows.map((r) => r.id)).size > 1 && !groups.has(norm(rows[0].name))) add('info', rows[0].id, `Same brand/model on ${rows.map((r) => r.name).join(', ')}; check whether they are one item.`);
  for (const p of ctx.explicit) for (const err of validatePolicy(p, ctx.explicit)) add('error', p.offeringId, `Policy "${p.name}": ${err}`);
  return issues;
}

// Other confirmed bookings within a day of `date`, as time windows with their equipment and staffed-service demand.
async function loadReservations(date, excludeRequestId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return [];
  const { EventBooking } = require('./payments'), { ServiceRequest } = require('./models');
  const d = Date.parse(`${date}T00:00:00Z`), near = [-1, 0, 1].map((n) => new Date(d + n * 86400000).toISOString().slice(0, 10));
  const rows = await EventBooking.find({ eventDate: { $in: near }, requestId: { $ne: excludeRequestId || '' } }).lean();
  const requests = new Map((await ServiceRequest.find({ externalId: { $in: rows.map((r) => r.requestId) } }).select('externalId event items').lean()).map((r) => [r.externalId, r]));
  return rows.map((r) => {
    const sr = requests.get(r.requestId), demand = new Map();
    for (const e of r.equipment || []) demand.set(e.slug, (demand.get(e.slug) || 0) + e.quantity);
    for (const i of sr?.items || []) if (i.serviceId.startsWith('svc-')) demand.set(i.serviceId, (demand.get(i.serviceId) || 0) + 1);
    return { window: reservationWindow({ date: r.eventDate, startTime: sr?.event?.startTime, endTime: sr?.event?.endTime }), demand };
  });
}
// buffers are explicit admin input; nothing is assumed when they are absent.
async function availabilityFor(result, event, ctx, excludeRequestId, buffers) {
  const demand = reservationDemand(result);
  if (!event.date) return { ok: true, needsConfirmation: false, lines: [], problems: [], checked: false };
  const window = reservationWindow(event, buffers);
  if (!window) return { ok: true, needsConfirmation: false, lines: [], problems: ['The event date is invalid; availability was not checked.'], checked: false };
  return { ...checkAvailability({ demand, offerings: ctx.offerings, reservations: await loadReservations(event.date, excludeRequestId), window }), checked: true };
}

function registerPricingRoutes(app, requireAdmin) {
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e instanceof z.ZodError ? 400 : 500).json({ message: e instanceof z.ZodError ? e.issues[0].message : 'Pricing request failed.' }); } };
  app.get('/api/admin/pricing', requireAdmin, wrap(async (_req, res) => { const c = await loadContext(); res.set('Cache-Control', 'no-store').json({ offerings: c.offerings, policies: c.policies, modes: MODES, issues: review(c) }); }));
  const save = (id) => async (req, res) => {
    const data = policyInput.parse(req.body), c = await loadContext();
    if (!c.offerings.some((o) => o.id === data.offeringId)) return res.status(400).json({ message: 'Choose an existing offering.' });
    const current = id && c.explicit.find((p) => p.id === id);
    if (id && !current) return res.status(404).json({ message: 'Policy not found.' });
    const policy = { ...data, id: id || crypto.randomUUID(), version: current ? current.version + 1 : 1 };
    const errors = validatePolicy(policy, c.explicit);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    await PricingPolicy.updateOne({ id: policy.id }, { $set: policy }, { upsert: true });
    res.status(id ? 200 : 201).json({ policy });
  };
  app.post('/api/admin/pricing/policies', requireAdmin, wrap(save(null)));
  app.put('/api/admin/pricing/policies/:id', requireAdmin, wrap((req, res) => save(req.params.id)(req, res)));
  app.delete('/api/admin/pricing/policies/:id', requireAdmin, wrap(async (req, res) => res.json({ removed: (await PricingPolicy.deleteOne({ id: req.params.id })).deletedCount === 1 })));
  // Suggested quote prices for a client's request, from the engine. The admin still reviews and publishes the quote.
  app.post('/api/admin/pricing/suggest/:requestId', requireAdmin, wrap(async (req, res) => {
    const { items } = z.object({ items: z.array(z.object({ serviceId: z.string(), quantity: z.number().int().min(1) })).min(1).max(200) }).parse(req.body);
    const sr = await require('./models').ServiceRequest.findOne({ externalId: req.params.requestId }).lean();
    if (!sr) return res.status(404).json({ message: 'Booking not found.' });
    const hours = eventHours(sr.event || {}), c = await loadContext();
    const selections = items.map((i) => ({ offeringId: i.serviceId, quantity: i.quantity }));
    const event = { ...(sr.event || {}), date: sr.event?.eventDate || sr.event?.date || undefined, ...(hours != null ? { hours } : {}) };
    try { const result = calculateBookingPrice({ selections, event }, c); const availability = await availabilityFor(result, event, c, sr.externalId);
      res.json({ suggestions: suggestUnitPrices(result, selections), warnings: [...result.warnings, ...availability.problems], availability, hours }); }
    catch (e) { res.status(400).json({ message: e.message }); }
  }));
  const sim = z.object({
    selections: z.array(z.object({ offeringId: z.string(), quantity: z.number().int() })).max(100), event: z.object({ date: z.string().optional(), startTime: z.string().optional(), endTime: z.string().optional(), hours: z.number().min(0).max(48).optional(), days: z.number().int().min(1).max(30).optional() }).passthrough().default({}),
    prepMinutes: z.number().int().min(0).max(1440).default(0), dismantleMinutes: z.number().int().min(0).max(1440).default(0),
    discounts: z.array(z.object({ name: z.string().max(80), type: z.enum(['percent', 'fixed']), value: cents })).max(10).default([]), fees: z.array(z.object({ name: z.string().max(80), amountCents: cents })).max(10).default([]),
    taxes: z.array(z.object({ name: z.string().max(40), rateBps: z.number().int().min(0).max(5000) })).max(5).default([]),
  });
  app.post('/api/admin/pricing/simulate', requireAdmin, wrap(async (req, res) => {
    const { taxes, prepMinutes, dismantleMinutes, ...booking } = sim.parse(req.body), c = await loadContext();
    const event = { ...booking.event, ...(booking.event.hours == null && eventHours(booking.event) != null ? { hours: eventHours(booking.event) } : {}) };
    try { const result = calculateBookingPrice({ ...booking, event }, { ...c, taxes });
      const availability = await availabilityFor(result, event, c, '', { prepMinutes, dismantleMinutes });
      res.json({ result, demand: Object.fromEntries(reservationDemand(result)), availability }); }
    catch (e) { res.status(400).json({ message: e.message }); }
  }));
}
module.exports = { registerPricingRoutes, loadContext, review, PricingPolicy, policyInput };
