const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const multer = require('multer');
const { z } = require('zod');
const { stockView } = require('./equipment-stock');

const equipmentSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true },
    category: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    brandModel: { type: String, default: '', trim: true },
    description: { type: String, default: '', trim: true },
    imageUrl: { type: String, default: '' },
    modelUrl:{type:String,default:''},modelJobId:{type:String,default:''},
    priceCents: { type: Number, default: 0, min: 0 }, // internal only, never in public output
    minQuantity: { type: Number, default: 1, min: 1 },
    quantityOwned: { type: Number, default: 1, min: 0 },
    stockTracked: { type: Boolean, default: false }, // enforce quantityOwned in availability checks once real stock is entered
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
const Equipment = mongoose.models.Equipment || mongoose.model('Equipment', equipmentSchema);

// Source: "Rental Price .pdf". quantityOwned is a placeholder until the owner enters real stock.
const SEED = [
  ['movingheads', 'lighting', 'Intelligent Moving Heads', '', 25000],
  ['trussing', 'lighting', 'Base Plates / Trussing', '', 7500],
  ['uplights', 'lighting', 'Uplights', '', 3500, 10],
  ['qsc-k122', 'sound', 'QSC K12.2', 'QSC K12.2', 10000],
  ['elite-15', 'sound', 'Elite 15" Speakers', '', 10000],
  ['es18p', 'sound', 'ES18P 18" Subwoofer', 'ES18P', 15000],
  ['shure-mics', 'sound', 'Shure Microphones', 'Shure', 7500],
  ['soundcraft', 'sound', 'Soundcraft Soundboard', 'Soundcraft', 7500],
  ['jbl-system', 'sound', 'JBL Concert Sound System', 'JBL SRX 725 tops + STX 828 bins', 80000],
  ['smoke', 'effects', 'Smoke Machine', '', 10000],
  ['sparklers', 'effects', 'Sparklers / Cold Spark Effects', '', 25000],
  ['dry-ice', 'effects', 'Dry Ice Machine', '', 40000],
  ['co2-gun', 'effects', 'CO₂ Gun With Tank', '', 60000],
  ['led-screen', 'video', 'LED Screen', 'Six-panel configuration', 80000],
  ['projector', 'video', 'Projector', '', 5000],
  ['dj-service', 'dj', 'DJ Service', 'DJ Khalil Nahhat', 100000],
].map(([slug, category, name, brandModel, priceCents, minQuantity = 1], sortOrder) => ({
  slug, category, name, brandModel, priceCents, minQuantity, sortOrder,
}));

let seeded = false;
async function ensureSeed() {
  if (seeded) return;
  await Equipment.bulkWrite(
    SEED.map((item) => ({ updateOne: { filter: { slug: item.slug }, update: { $setOnInsert: item }, upsert: true } })),
  );
  seeded = true;
}

const publicView = (e) => ({
  id: e.slug, category: e.category, name: e.name, brandModel: e.brandModel,
  description: e.description, imageUrl: e.imageUrl, modelUrl:e.modelUrl||'', minQuantity: e.minQuantity, ...stockView(e),
});
const adminView = (e) => ({
  ...publicView(e),modelJobId:e.modelJobId||'', priceCents: e.priceCents, quantityOwned: e.quantityOwned, stockTracked: e.stockTracked, isActive: e.isActive, sortOrder: e.sortOrder,
});

const fields = {
  modelJobId:z.string().max(80).nullable(),
  category: z.string().trim().min(1), name: z.string().trim().min(1),
  brandModel: z.string().trim(), description: z.string().trim(), imageUrl: z.string().trim(),
  priceCents: z.number().int().min(0), minQuantity: z.number().int().min(1),
  quantityOwned: z.number().int().min(0), stockTracked: z.boolean(), isActive: z.boolean(), sortOrder: z.number().int(),
};
const createSchema = z.object({ slug: z.string().trim().regex(/^[a-z0-9-]+$/), ...fields }).partial().required({ slug: true, category: true, name: true });
const updateSchema = z.object(fields).partial();

function registerEquipmentRoutes(app, requireAdmin) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const bad = (res, parsed) => res.status(400).json({ message: 'Equipment payload failed validation.', errors: parsed.error.flatten().fieldErrors });

  app.get('/api/equipment', async (_req, res) => {
    await ensureSeed();
    const items = await Equipment.find({ isActive: true }).sort({ sortOrder: 1 });
    res.json({ items: items.map(publicView) });
  });

  app.get('/api/equipment/admin', requireAdmin, async (_req, res) => {
    await ensureSeed();
    res.json({ items: (await Equipment.find().sort({ sortOrder: 1 })).map(adminView) });
  });

  app.post('/api/equipment', requireAdmin, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed);
    try {
      const {modelJobId,...data}=parsed.data;const model=await require('./equipment-3d').equipmentModelFields(req,modelJobId);
      return res.status(201).json({ item: adminView(await Equipment.create({...data,...model})) });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ message: 'Equipment id already exists.' });
      if(e.status)return res.status(e.status).json({message:e.message});
      throw e;
    }
  });

  app.patch('/api/equipment/:id', requireAdmin, async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed);
    const {modelJobId,...data}=parsed.data;let model;try{model=await require('./equipment-3d').equipmentModelFields(req,modelJobId);}catch(error){if(error.status)return res.status(error.status).json({message:error.message});throw error;}
    const item = await Equipment.findOneAndUpdate({ slug: req.params.id }, {...data,...model}, { new: true });
    return item ? res.json({ item: adminView(item) }) : res.status(404).json({ message: 'Equipment not found.' });
  });

  app.delete('/api/equipment/:id', requireAdmin, async (req, res) => {
    const item = await Equipment.findOneAndDelete({ slug: req.params.id });
    return item ? res.json({ ok: true }) : res.status(404).json({ message: 'Equipment not found.' });
  });

  app.post('/api/equipment/:id/photo', requireAdmin, upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Photo is required.' });
    try {
      const result = await new Promise((resolve, reject) =>
        cloudinary.uploader.upload_stream({ folder: 'khalil/equipment' }, (e, r) => (e ? reject(e) : resolve(r))).end(req.file.buffer));
      const item = await Equipment.findOneAndUpdate({ slug: req.params.id }, { imageUrl: result.secure_url }, { new: true });
      return item ? res.json({ item: adminView(item) }) : res.status(404).json({ message: 'Equipment not found.' });
    } catch (e) {
      console.error('Equipment photo upload failed:', e);
      return res.status(500).json({ message: 'Photo upload failed.' });
    }
  });
}

module.exports = { Equipment, registerEquipmentRoutes, publicView, ensureSeed };
