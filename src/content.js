const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const multer = require('multer');
const { z } = require('zod');

const testimonialSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    eventType: { type: String, default: '', trim: true },
    text: { type: String, required: true, trim: true },
    textAr: { type: String, default: '', trim: true },
    reply: { type: String, default: '', trim: true, maxlength: 2000 },
    repliedAt: { type: Date, default: null },
    imageUrl: { type: String, default: '' },
    isPublished: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
const mediaSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['mix', 'video', 'photo'], required: true },
    category: { type: String, default: '', trim: true },
    title: { type: String, required: true, trim: true },
    titleAr: { type: String, default: '', trim: true },
    coverUrl: { type: String, default: '' },
    mediaUrl: { type: String, required: true }, // uploaded file URL, or a YouTube/Vimeo page URL
    durationSec: { type: Number, default: 0 },
    downloadable: { type: Boolean, default: false }, // UI hint only: the stored file URL is public
    isPublished: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
const Testimonial = mongoose.models.Testimonial || mongoose.model('Testimonial', testimonialSchema);
const MediaItem = mongoose.models.MediaItem || mongoose.model('MediaItem', mediaSchema);

const str = (max) => z.string().trim().max(max);
const testimonialFields = { name: str(120).min(1), eventType: str(80), text: str(2000).min(1), textAr: str(2000), reply: str(2000), imageUrl: str(500), isPublished: z.boolean(), sortOrder: z.number().int() };
const mediaFields = {
  kind: z.enum(['mix', 'video', 'photo']), category: str(80), title: str(160).min(1), titleAr: str(160), coverUrl: str(500),
  mediaUrl: str(500).min(1), durationSec: z.number().int().min(0), downloadable: z.boolean(), isPublished: z.boolean(), sortOrder: z.number().int(),
};

const view = (d) => ({ id: d.id, ...d.toObject({ versionKey: false, transform: (_doc, o) => { delete o._id; delete o.createdAt; delete o.updatedAt; return o; } }) });

function crud(app, requireAdmin, base, Model, fields, required, publicFilter) {
  const create = z.object(fields).partial().required(required);
  const update = z.object(fields).partial();
  const bad = (res) => res.status(400).json({ message: 'Content failed validation.' });
  app.get(`${base}/admin`, requireAdmin, async (_req, res) => res.json({ items: (await Model.find().sort({ sortOrder: 1, createdAt: -1 })).map(view) }));
  app.post(base, requireAdmin, async (req, res) => {
    const p = create.safeParse(req.body);
    return p.success ? res.status(201).json({ item: view(await Model.create(p.data)) }) : bad(res);
  });
  app.patch(`${base}/:id`, requireAdmin, async (req, res) => {
    const p = update.safeParse(req.body);
    if (!p.success) return bad(res);
    const changes = { ...p.data };
    if (Model === Testimonial && Object.hasOwn(changes, 'reply')) changes.repliedAt = changes.reply ? new Date() : null;
    const d = await Model.findByIdAndUpdate(req.params.id, { $set: changes }, { new: true, runValidators: true }).catch(() => null);
    return d ? res.json({ item: view(d) }) : res.status(404).json({ message: 'Not found.' });
  });
  app.delete(`${base}/:id`, requireAdmin, async (req, res) => {
    const d = await Model.findByIdAndDelete(req.params.id).catch(() => null);
    return d ? res.json({ ok: true }) : res.status(404).json({ message: 'Not found.' });
  });
  app.get(base, async (req, res) => res.json({ items: (await Model.find({ isPublished: true, ...publicFilter(req) }).sort({ sortOrder: 1, createdAt: -1 })).map(view) }));
}

function registerContent(app, requireAdmin) {
  crud(app, requireAdmin, '/api/content/testimonials', Testimonial, testimonialFields, { name: true, text: true }, () => ({}));
  crud(app, requireAdmin, '/api/content/media', MediaItem, mediaFields, { kind: true, title: true, mediaUrl: true },
    (req) => (['mix', 'video', 'photo'].includes(req.query.kind) ? { kind: req.query.kind } : {}));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
  app.post('/api/content/upload', requireAdmin, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'File is required.' });
    try {
      const r = await new Promise((resolve, reject) =>
        cloudinary.uploader.upload_stream({ folder: 'khalil/content', resource_type: 'auto' }, (e, out) => (e ? reject(e) : resolve(out))).end(req.file.buffer));
      return res.status(201).json({ url: r.secure_url, durationSec: Math.round(r.duration || 0) });
    } catch (e) {
      console.error('Content upload failed:', e);
      return res.status(500).json({ message: 'Upload failed.' });
    }
  });
}

module.exports = { MediaItem, Testimonial, registerContent };
