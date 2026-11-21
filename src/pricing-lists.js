// Admin-managed lists in the Pricing tab: Fee categories (what we charge for) and Pricing factors (what changes those fees).
const crypto = require('crypto');
const mongoose = require('mongoose');
const { z } = require('zod');

const LISTS = ['feeCategories', 'pricingFactors'];
const norm = (value) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const Item = mongoose.models.PricingListItem || mongoose.model('PricingListItem', new mongoose.Schema({
  id: { type: String, required: true, unique: true }, list: { type: String, enum: LISTS, required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 }, normalizedName: { type: String, required: true },
  description: { type: String, default: '', maxlength: 500 }, affects: { type: [String], default: [] }, // pricing factors: ids of the fee categories they change
}, { timestamps: true }));
Item.schema.index({ list: 1, normalizedName: 1 }, { unique: true });
const State = mongoose.models.PricingListState || mongoose.model('PricingListState', new mongoose.Schema({ _id: String }));

const feeSeeds = ['Rental fee', 'Delivery fee', 'Setup fee', 'Technician fee', 'Overtime fee', 'Travel fee'];
const factorSeeds = [
  ['Event date / season', ['Rental fee']], ['Event duration', ['Rental fee', 'Technician fee', 'Overtime fee']],
  ['Distance to venue', ['Delivery fee', 'Travel fee']], ['Guest count', ['Rental fee', 'Technician fee']],
  ['Venue access (stairs, floor)', ['Setup fee', 'Technician fee']], ['Equipment quantity', ['Rental fee', 'Delivery fee', 'Setup fee']],
];

// Seeded once; after that the admin owns both lists (even if they delete everything).
async function ensureSeeded() {
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

const input = z.object({ name: z.string().trim().min(1, 'Enter a name.').max(120), description: z.string().trim().max(500).optional(), affects: z.array(z.string().max(64)).max(100).optional() }).strict();
const listName = (value) => { if (!LISTS.includes(value)) throw Object.assign(new Error('Unknown list.'), { status: 404 }); return value; };

async function snapshot() {
  await ensureSeeded();
  const rows = await Item.find().sort({ _id: 1 }).lean();
  const out = (list) => rows.filter((row) => row.list === list).map(({ id, name, description, affects }) => ({ id, name, description, ...(list === 'pricingFactors' ? { affects } : {}) }));
  return { feeCategories: out('feeCategories'), pricingFactors: out('pricingFactors') };
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
    const set = { name: data.name, normalizedName: norm(data.name), ...(data.description !== undefined ? { description: data.description } : {}), ...(data.affects ? { affects: [...new Set(data.affects)] } : {}) };
    const row = id
      ? await Item.findOneAndUpdate({ list, id }, { $set: set }, { new: true, runValidators: true })
      : await Item.create({ id: crypto.randomUUID(), list, ...set });
    if (!row) throw Object.assign(new Error('Item not found.'), { status: 404 });
    res.status(id ? 200 : 201).json(await snapshot());
  };
  app.post(`${base}/:list`, requireAdmin, wrap(write(null)));
  app.put(`${base}/:list/:id`, requireAdmin, wrap((req, res) => write(req.params.id)(req, res)));
  app.delete(`${base}/:list/:id`, requireAdmin, wrap(async (req, res) => {
    const list = listName(req.params.list);
    if (!(await Item.deleteOne({ list, id: req.params.id })).deletedCount) throw Object.assign(new Error('Item not found.'), { status: 404 });
    if (list === 'feeCategories') await Item.updateMany({ list: 'pricingFactors' }, { $pull: { affects: req.params.id } });
    res.json(await snapshot());
  }));
}

module.exports = { registerPricingListRoutes };
