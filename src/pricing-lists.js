// Admin-managed lists in the Pricing tab: Fee categories (what we charge for) and Pricing factors (what changes those fees).
const crypto = require('crypto');
const mongoose = require('mongoose');
const { z } = require('zod');

const { MODES } = require('./pricing-engine');
const LISTS = ['feeCategories', 'pricingFactors', 'pricingModes'];
const norm = (value) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const Item = mongoose.models.PricingListItem || mongoose.model('PricingListItem', new mongoose.Schema({
  id: { type: String, required: true, unique: true }, list: { type: String, enum: LISTS, required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 }, normalizedName: { type: String, required: true },
  description: { type: String, default: '', maxlength: 500 }, basis: { type: String, default: '' }, order: { type: Number, default: 0 }, // pricing modes: the engine mode they price by
  affects: { type: [String], default: [] }, // pricing factors: ids of the fee categories they change
}, { timestamps: true }));
Item.schema.index({ list: 1, normalizedName: 1 }, { unique: true });
const State = mongoose.models.PricingListState || mongoose.model('PricingListState', new mongoose.Schema({ _id: String }));

// The first five are the fee types policies already used; the rest are common extras.
const feeSeeds = ['Rental fee', 'Installation fee', 'Delivery fee', 'Loading fee', 'Performance fee', 'Overtime fee', 'Travel fee'];
const factorSeeds = [
  ['Event date / season', ['Rental fee']], ['Event duration', ['Rental fee', 'Performance fee', 'Overtime fee']],
  ['Distance to venue', ['Delivery fee', 'Travel fee']], ['Guest count', ['Rental fee', 'Performance fee']],
  ['Venue access (stairs, floor)', ['Installation fee', 'Loading fee']], ['Equipment quantity', ['Rental fee', 'Delivery fee', 'Installation fee']],
];

const modeSeeds = [['Fixed', 'fixed'], ['Per hour', 'hourly'], ['Per day', 'daily'], ['Per unit', 'per_unit'], ['Per unit per day', 'per_unit_per_day'], ['Tiered', 'tiered'], ['Custom quote', 'custom_quote'], ['Included', 'included']];
async function ensureModes() {
  if (await State.findById('modes-v1')) return;
  for (const [name, basis] of modeSeeds) await Item.findOneAndUpdate({ list: 'pricingModes', normalizedName: norm(name) }, { $setOnInsert: { id: crypto.randomUUID(), list: 'pricingModes', name, normalizedName: norm(name), basis } }, { upsert: true });
  await State.updateOne({ _id: 'modes-v1' }, { $set: { done: true } }, { upsert: true });
}

// Seeded once; after that the admin owns the lists (even if they delete everything).
async function ensureSeeded() {
  await ensureModes();
  if (await State.findById('seeded-v1')) return;
  const ids = new Map();
  for (const name of feeSeeds) {
    const row = await Item.findOneAndUpdate({ list: 'feeCategories', normalizedName: norm(name) }, { $setOnInsert: { id: crypto.randomUUID(), list: 'feeCategories', name, normalizedName: norm(name) } }, { upsert: true, new: true });
    ids.set(name, row.id);
  }
  for (const [name, fees] of factorSeeds) {
    await Item.findOneAndUpdate({ list: 'pricingFactors', normalizedName: norm(name) }, { $setOnInsert: { id: crypto.randomUUID(), list: 'pricingFactors', name, normalizedName: norm(name), affects: fees.map((fee) => ids.get(fee)) } }, { upsert: true });
  }
  await State.updateOne({ _id: 'seeded-v1' }, { $set: { done: true } }, { upsert: true });
}

const input = z.object({ name: z.string().trim().min(1, 'Enter a name.').max(120), description: z.string().trim().max(500).optional(), affects: z.array(z.string().max(64)).max(100).optional(), basis: z.enum(MODES).optional() }).strict();
const listName = (value) => { if (!LISTS.includes(value)) throw Object.assign(new Error('Unknown list.'), { status: 404 }); return value; };

async function snapshot() {
  await ensureSeeded();
  const rows = await Item.find().sort({ order: 1, _id: 1 }).lean();
  const out = (list) => rows.filter((row) => row.list === list).map(({ id, name, description, affects, basis }) => ({ id, name, description, ...(list === 'pricingFactors' ? { affects } : {}), ...(list === 'pricingModes' ? { basis } : {}) }));
  return { feeCategories: out('feeCategories'), pricingFactors: out('pricingFactors'), pricingModes: out('pricingModes') };
}

function registerPricingListRoutes(app, requireAdmin) {
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.issues[0].message });
      if (e?.code === 11000) return res.status(409).json({ message: 'This name already exists.' });
      res.status(e?.status || 500).json({ message: e?.status ? e.message : 'Pricing lists are unavailable.' });
    }
  };
  const base = '/api/admin/pricing/lists';
  app.get(base, requireAdmin, wrap(async (_req, res) => res.set('Cache-Control', 'no-store').json(await snapshot())));
  const write = (id) => async (req, res) => {
    const list = listName(req.params.list), data = input.parse(req.body);
    await ensureSeeded();
    if (data.affects) {
      if (list !== 'pricingFactors') throw Object.assign(new Error('Only pricing factors affect fee categories.'), { status: 400 });
      if (await Item.countDocuments({ list: 'feeCategories', id: { $in: data.affects } }) !== new Set(data.affects).size) throw Object.assign(new Error('Choose existing fee categories.'), { status: 400 });
    }
    const set = { name: data.name, normalizedName: norm(data.name), ...(data.description !== undefined ? { description: data.description } : {}), ...(data.affects ? { affects: [...new Set(data.affects)] } : {}), ...(data.basis ? { basis: data.basis } : {}) };
    if (list === 'pricingModes' && !id && !data.basis) set.basis = 'fixed';
    if (data.basis && list !== 'pricingModes') throw Object.assign(new Error('Only pricing modes have a basis.'), { status: 400 });
    const row = id
      ? await Item.findOneAndUpdate({ list, id }, { $set: set }, { new: true, runValidators: true })
      : await Item.create({ id: crypto.randomUUID(), list, ...set, order: ((await Item.findOne({ list }).sort({ order: -1 }).select('order').lean())?.order || 0) + 1 });
    if (!row) throw Object.assign(new Error('Item not found.'), { status: 404 });
    res.status(id ? 200 : 201).json(await snapshot());
  };
  // Reorder one list: the body is every id of that list in the new order.
  app.put(`${base}/:list/order`, requireAdmin, wrap(async (req, res) => {
    const list = listName(req.params.list), { ids } = z.object({ ids: z.array(z.string().max(64)).max(500) }).strict().parse(req.body);
    await ensureSeeded();
    const current = (await Item.find({ list }).select('id').lean()).map((row) => row.id);
    if (new Set(ids).size !== ids.length || ids.length !== current.length || !ids.every((id) => current.includes(id))) throw Object.assign(new Error('The list changed. Reload and try again.'), { status: 409 });
    await Item.bulkWrite(ids.map((id, index) => ({ updateOne: { filter: { list, id }, update: { $set: { order: index + 1 } } } })));
    res.json(await snapshot());
  }));
  app.post(`${base}/:list`, requireAdmin, wrap(write(null)));
  app.put(`${base}/:list/:id`, requireAdmin, wrap((req, res) => write(req.params.id)(req, res)));
  app.delete(`${base}/:list/:id`, requireAdmin, wrap(async (req, res) => {
    const list = listName(req.params.list);
    if (!(await Item.deleteOne({ list, id: req.params.id })).deletedCount) throw Object.assign(new Error('Item not found.'), { status: 404 });
    if (list === 'feeCategories') await Item.updateMany({ list: 'pricingFactors' }, { $pull: { affects: req.params.id } });
    res.json(await snapshot());
  }));
}

const modeById = async (id) => { await ensureSeeded(); return Item.findOne({ list: 'pricingModes', id }).select('id name basis').lean(); };
const feeCategoryNames = async () => { await ensureSeeded(); return (await Item.find({ list: 'feeCategories' }).select('name').lean()).map((row) => row.name); };
// For validating a policy's fee lines: fee name -> the ids of the pricing factors that affect it, plus the known factor ids.
async function feeFactorRules() {
  await ensureSeeded();
  const rows = await Item.find({ list: { $in: ['feeCategories', 'pricingFactors'] } }).lean();
  const fees = rows.filter((row) => row.list === 'feeCategories'), factors = rows.filter((row) => row.list === 'pricingFactors');
  return { allowed: new Map(fees.map((fee) => [fee.name, new Set(factors.filter((factor) => factor.affects.includes(fee.id)).map((factor) => factor.id))])), factorIds: new Set(factors.map((factor) => factor.id)) };
}

module.exports = { registerPricingListRoutes, feeCategoryNames, feeFactorRules, modeById };
