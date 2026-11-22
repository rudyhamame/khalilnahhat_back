// Pure pricing engine: no database, no HTTP. Money is integer cents; percentages are integer basis points of cents rounded half-up.
// Offering = what is sold, Policy = how it is priced, booking = what is selected, ctx = catalog + taxes. See pricing-catalog.js for the loader.
const MODES = ['fixed', 'hourly', 'daily', 'per_unit', 'per_unit_per_day', 'tiered', 'custom_quote', 'included'];
const OPERATORS = ['eq', 'neq', 'gt', 'lt', 'between', 'contains', 'in'];
const ADJUSTMENTS = ['fixed', 'percent', 'per_additional_unit', 'per_additional_hour', 'override'];
const round = (n) => Math.round(n); // half-up for the non-negative values used here
const isCents = (n) => Number.isSafeInteger(n) && n >= 0;

function matches(cond, facts) {
  const actual = facts[cond.field], v = cond.value;
  switch (cond.operator) {
    case 'eq': return actual === v;
    case 'neq': return actual !== v;
    case 'gt': return Number(actual) > Number(v);
    case 'lt': return Number(actual) < Number(v);
    case 'between': return Array.isArray(v) && Number(actual) >= Number(v[0]) && Number(actual) <= Number(v[1]);
    case 'contains': return Array.isArray(actual) ? actual.includes(v) : String(actual ?? '').includes(String(v));
    case 'in': return Array.isArray(v) && v.includes(actual);
    default: return false;
  }
}

// Dates are compared as YYYY-MM-DD strings (event-local), so there is no timezone drift.
const inWindow = (p, date) => (!p.effectiveFrom || date >= p.effectiveFrom) && (!p.effectiveUntil || date <= p.effectiveUntil);

// Highest priority wins; equal priorities are a configuration conflict, reported and resolved by id so the result is deterministic.
function pickPolicy(offeringId, ctx, date, warnings) {
  const rows = ctx.policies.filter((p) => p.offeringId === offeringId && p.status === 'active' && inWindow(p, date));
  if (!rows.length) return null;
  rows.sort((a, b) => b.priority - a.priority || String(a.id).localeCompare(String(b.id)));
  if (rows[1] && rows[1].priority === rows[0].priority) warnings.push(`Conflicting pricing policies for ${offeringId}; "${rows[0].name}" was used.`);
  return rows[0];
}

function baseCharge(p, qty, hours, days) {
  switch (p.pricingMode) {
    case 'fixed': return { amount: p.baseAmountCents * qty, basis: qty > 1 ? `${qty} × fixed` : 'per event' };
    case 'hourly': {
      if (hours == null) return { missing: 'hours' };
      return { amount: p.baseAmountCents * Math.max(hours, p.minimumDuration || 0), basis: `${hours} h` };
    }
    case 'daily': {
      if (days == null) return { missing: 'days' };
      return { amount: p.baseAmountCents * days, basis: `${days} day(s)` };
    }
    case 'per_unit': return { amount: p.baseAmountCents * qty, basis: `${qty} unit(s)` };
    case 'per_unit_per_day': {
      if (days == null) return { missing: 'days' };
      return { amount: p.baseAmountCents * qty * days, basis: `${qty} unit(s) × ${days} day(s)` };
    }
    case 'tiered': { // tier is chosen by quantity; the whole quantity is charged at that tier's rate
      const tier = (p.tiers || []).find((t) => qty >= t.from && (t.to == null || qty <= t.to));
      if (!tier) return { missing: 'tier' };
      return { amount: tier.rateCents * qty, basis: `${qty} unit(s) at tier ${tier.from}${tier.to == null ? '+' : '–' + tier.to}` };
    }
    case 'included': return { amount: 0, basis: 'included' };
    default: return { quote: true };
  }
}

// Extra units beyond includedQuantity are charged at additionalUnitRateCents (per_unit / fixed policies only).
function extraUnits(p, qty) {
  if (!p.includedQuantity || !p.additionalUnitRateCents || qty <= p.includedQuantity) return 0;
  return (qty - p.includedQuantity) * p.additionalUnitRateCents;
}

// Overrides first, then every other matching adjustment in priority order. A percentage always applies to the line's base charge.
function applyConditions(p, base, facts, qty, hours) {
  const rules = (p.conditions || []).filter((c) => matches(c, facts)).sort((a, b) => (a.priority || 0) - (b.priority || 0));
  let amount = base, deltas = [];
  for (const c of rules.filter((r) => r.adjustmentType === 'override')) { deltas.push({ label: c.field, change: c.adjustmentValue - amount }); amount = c.adjustmentValue; }
  const start = amount;
  for (const c of rules.filter((r) => r.adjustmentType !== 'override')) {
    const v = c.adjustmentValue;
    const change = c.adjustmentType === 'fixed' ? v
      : c.adjustmentType === 'percent' ? round(start * v / 10000) // v in basis points
      : c.adjustmentType === 'per_additional_unit' ? v * Math.max(0, qty - (p.includedQuantity || 1))
      : v * Math.max(0, (hours ?? 0) - (p.minimumDuration || 0));
    amount += change; deltas.push({ label: `${c.field} ${c.operator}`, change });
  }
  return { amount: Math.max(0, amount), adjustments: deltas };
}

const bucketOf = (o) => o.bucket || (o.type === 'service' ? 'service' : o.type === 'package' ? 'package' : 'equipment');

function calculateBookingPrice(booking, ctx) {
  const warnings = [], items = [], event = booking.event || {};
  const date = event.date || ctx.today;
  const hours = Number.isFinite(event.hours) ? event.hours : null, days = Number.isFinite(event.days) ? event.days : (hours != null ? 1 : null);
  const facts = { ...event, hours, days };
  const byId = new Map(ctx.offerings.map((o) => [o.id, o]));
  const used = new Map();
  const totals = { service: 0, equipment: 0, package: 0 };
  let quoteRequired = false;

  const price = (offering, qty, parent, path) => {
    if (path.includes(offering.id)) throw new Error(`Circular package: ${[...path, offering.id].join(' → ')}`);
    const line = { offeringId: offering.id, name: offering.name, type: offering.type, quantity: qty, parent: parent || null, rate: null, billingBasis: '', policyId: null, adjustments: [], total: 0, status: 'priced' };
    items.push(line);
    const policy = pickPolicy(offering.id, ctx, date, warnings);
    const components = offering.components || [];
    const isPackage = offering.type === 'package' || components.length > 0;
    if (policy) {
      line.policyId = policy.id; used.set(policy.id, policy.version || 1);
      const base = baseCharge(policy, qty, hours, days);
      if (base.quote) { line.status = 'quote_required'; quoteRequired = true; }
      else if (base.missing) { line.status = 'quote_required'; quoteRequired = true; warnings.push(`${offering.name}: ${base.missing} is required for ${policy.pricingMode} pricing.`); }
      else {
        const units = policy.pricingUnits || [];
        const unitCharge = units.reduce((sum, unit) => sum + unit.amountCents * qty, 0);
        const { amount, adjustments } = applyConditions(policy, base.amount + extraUnits(policy, qty) + unitCharge, { ...facts, quantity: qty }, qty, hours);
        line.rate = policy.baseAmountCents; line.billingBasis = base.basis; line.adjustments = [...adjustments, ...units.map((unit) => ({ label: unit.type, change: unit.amountCents * qty }))]; line.total = amount;
      }
      // Fixed/included package price covers its required components; only components marked "priced" are charged again (explicit upgrades).
      for (const c of components) {
        const child = byId.get(c.offeringId);
        if (!child) { warnings.push(`${offering.name}: component ${c.offeringId} is missing from the catalog.`); continue; }
        if (c.inclusion === 'priced') price(child, c.quantity * qty, offering.id, [...path, offering.id]);
        else includeOnly(child, c.quantity * qty, offering.id, [...path, offering.id]);
      }
    } else if (isPackage && components.length) { // derived package: the sum of its components
      line.billingBasis = 'sum of components'; line.rate = null;
      for (const c of components) {
        const child = byId.get(c.offeringId);
        if (!child) { warnings.push(`${offering.name}: component ${c.offeringId} is missing from the catalog.`); line.status = 'quote_required'; quoteRequired = true; continue; }
        price(child, c.quantity * qty, offering.id, [...path, offering.id]);
      }
    } else {
      line.status = 'quote_required'; quoteRequired = true;
      warnings.push(`${offering.name}: no pricing policy applies; an administrator must quote it.`);
    }
    return line;
  };
  // Included components appear on the quote at no charge but still count for inventory (see `reserve`).
  const includeOnly = (offering, qty, parent, path) => {
    if (path.includes(offering.id)) throw new Error(`Circular package: ${[...path, offering.id].join(' → ')}`);
    items.push({ offeringId: offering.id, name: offering.name, type: offering.type, quantity: qty, parent, rate: 0, billingBasis: 'included in package', policyId: null, adjustments: [], total: 0, status: 'included' });
    for (const c of offering.components || []) { const child = byId.get(c.offeringId); if (child) includeOnly(child, c.quantity * qty, offering.id, [...path, offering.id]); }
  };

  const seen = new Set();
  for (const sel of booking.selections || []) {
    const offering = byId.get(sel.offeringId);
    if (!offering || offering.isActive === false) { warnings.push(`Offering ${sel.offeringId} is not available.`); quoteRequired = true; continue; }
    if (seen.has(sel.offeringId)) { warnings.push(`${offering.name} was selected twice; only the first selection was priced.`); continue; }
    seen.add(sel.offeringId);
    if (!Number.isSafeInteger(sel.quantity) || sel.quantity < 1) { warnings.push(`${offering.name}: quantity must be a whole number of at least 1.`); quoteRequired = true; continue; }
    if (sel.quantity < (offering.minQuantity || 1)) { warnings.push(`${offering.name}: minimum quantity is ${offering.minQuantity}.`); quoteRequired = true; continue; }
    price(offering, sel.quantity, null, []);
  }
  for (const i of items) totals[bucketOf(byId.get(i.offeringId))] += i.total; // lines are the single source of truth

  let running = totals.service + totals.equipment + totals.package, discountTotal = 0;
  const discounts = [];
  for (const d of booking.discounts || []) {
    const amount = d.type === 'percent' ? round(running * d.value / 10000) : Math.min(d.value, running);
    if (!isCents(amount)) { warnings.push(`Discount "${d.name}" is invalid.`); continue; }
    running -= amount; discountTotal += amount; discounts.push({ name: d.name, amount });
  }
  const fees = (booking.fees || []).filter((f) => isCents(f.amountCents));
  const additionalFees = fees.reduce((s, f) => s + f.amountCents, 0);
  const subtotalBeforeTax = running + additionalFees;
  const taxes = (ctx.taxes || []).map((t) => ({ name: t.name, rateBps: t.rateBps, amount: round(subtotalBeforeTax * t.rateBps / 10000) }));
  const total = subtotalBeforeTax + taxes.reduce((s, t) => s + t.amount, 0);
  if (quoteRequired) warnings.push('Some items need an administrator quote, so this total is an estimate, not a confirmed price.');

  return {
    currency: ctx.currency || 'CAD', status: quoteRequired ? 'quote_required' : 'estimate', items,
    serviceSubtotal: totals.service, equipmentSubtotal: totals.equipment, packageSubtotal: totals.package, additionalFees,
    fees: fees.map((f) => ({ name: f.name, amount: f.amountCents })), discounts, discountTotal, subtotalBeforeTax, taxes, total,
    quoteRequired, warnings, policyVersion: [...used].map(([id, v]) => `${id}@${v}`).sort().join(',') || 'none',
  };
}

// Equipment and staffed services a booking needs (included package members count, charges do not): input for availability checks.
function reservationDemand(result) {
  const demand = new Map();
  for (const i of result.items) if (i.type === 'equipment' || i.type === 'addon' || i.type === 'service') demand.set(i.offeringId, (demand.get(i.offeringId) || 0) + i.quantity);
  return demand;
}

// Admin validation: reject contradictory or unsafe policies before they are saved.
function validatePolicy(p, existing = []) {
  const errors = [];
  if (!MODES.includes(p.pricingMode)) errors.push('Unknown pricing mode.');
  const unitTypes = (p.pricingUnits || []).map((unit) => unit.type);
  if (new Set(unitTypes).size !== unitTypes.length) errors.push('A pricing unit can only be added once.');
  if ((p.pricingUnits || []).some((unit) => !unit.type || !isCents(unit.amountCents))) errors.push('A pricing unit is invalid.');
  if (['fixed', 'hourly', 'daily', 'per_unit', 'per_unit_per_day'].includes(p.pricingMode) && !isCents(p.baseAmountCents)) errors.push('Enter a valid amount.');
  if (p.pricingMode === 'tiered') {
    const t = [...(p.tiers || [])].sort((a, b) => a.from - b.from);
    if (!t.length) errors.push('Tiered pricing needs at least one tier.');
    t.forEach((x, i) => { if (!isCents(x.rateCents) || x.from < 1 || (x.to != null && x.to < x.from)) errors.push('A tier is invalid.'); if (i && (t[i - 1].to == null || x.from <= t[i - 1].to)) errors.push('Tiers overlap.'); });
  }
  for (const c of p.conditions || []) {
    if (!OPERATORS.includes(c.operator)) errors.push(`Unknown operator ${c.operator}.`);
    if (!ADJUSTMENTS.includes(c.adjustmentType)) errors.push(`Unknown adjustment ${c.adjustmentType}.`);
    if (!Number.isFinite(c.adjustmentValue)) errors.push('An adjustment value is invalid.');
  }
  if (p.effectiveFrom && p.effectiveUntil && p.effectiveUntil < p.effectiveFrom) errors.push('The end date is before the start date.');
  if (p.status === 'active') {
    const clash = existing.find((o) => o.id !== p.id && o.offeringId === p.offeringId && o.status === 'active' && o.priority === p.priority
      && (!o.effectiveFrom || !p.effectiveUntil || o.effectiveFrom <= p.effectiveUntil) && (!p.effectiveFrom || !o.effectiveUntil || p.effectiveFrom <= o.effectiveUntil));
    if (clash) errors.push(`Another active policy ("${clash.name}") has the same priority and overlapping dates.`);
  }
  return errors;
}

// Hours between "HH:MM" start and end; an end earlier than the start means the event runs past midnight. null when either is missing/invalid.
function eventHours(event = {}) {
  const t = (v) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const a = t(event.startTime), b = t(event.endTime);
  if (a == null || b == null) return null;
  return ((b - a + 1440) % 1440 || 1440) / 60;
}

// One suggested unit price per selected line (package/derived lines include their descendants). null = needs a human quote or is not a whole number of cents.
function suggestUnitPrices(result, selections) {
  const tops = result.items.map((item, i) => ({ item, i })).filter(({ item }) => !item.parent);
  return selections.map((sel) => {
    const at = tops.findIndex(({ item }) => item.offeringId === sel.offeringId);
    if (at < 0) return { serviceId: sel.offeringId, unitPrice: null, note: 'Not priced by the engine.' };
    const end = tops[at + 1] ? tops[at + 1].i : result.items.length;
    const group = result.items.slice(tops[at].i, end);
    if (group.some((g) => g.status === 'quote_required')) return { serviceId: sel.offeringId, unitPrice: null, note: 'Needs a manual quote.' };
    const total = group.reduce((s, g) => s + g.total, 0);
    if (total % sel.quantity) return { serviceId: sel.offeringId, unitPrice: null, note: 'Total does not divide into whole cents per unit.' };
    return { serviceId: sel.offeringId, unitPrice: total / sel.quantity / 100, note: '' };
  });
}

module.exports = { eventHours, suggestUnitPrices, calculateBookingPrice, reservationDemand, validatePolicy, MODES, OPERATORS, ADJUSTMENTS };
