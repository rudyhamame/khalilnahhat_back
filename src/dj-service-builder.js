const mongoose = require('mongoose');
const { z } = require('zod');
const { ArchiveItem } = require('./models');

const PlanStore = mongoose.models.DjServiceBuilder || mongoose.model('DjServiceBuilder', new mongoose.Schema({
  _id: String,
  plans: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true }));
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const segment = z.object({
  id: z.string().min(1).max(100), title: z.string().trim().min(1).max(120), startsAt: z.union([time, z.literal('')]),
  endsAt: z.union([time, z.literal('')]), recordingIds: z.array(z.string().min(1).max(120)).max(500).default([]),
}).strict();
const plan = z.object({
  id: z.string().min(1).max(100), title: z.string().trim().min(1).max(200),
  date: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).default(''), venue: z.string().trim().max(240).default(''),
  workIds: z.array(z.string().min(1).max(120)).max(500).default([]), segments: z.array(segment).max(100).default([]),
}).strict();
const input = z.object({ plans: z.array(plan).max(100) }).strict();

function registerDjServiceBuilder(app, { requireAdmin, ArchiveModel = ArchiveItem, Store = PlanStore }) {
  app.get('/api/admin/dj-service-builder', requireAdmin, async (_req, res) => {
    try {
      const saved = await Store.findById('main').lean();
      res.set('Cache-Control', 'no-store').json({ plans: saved?.plans || [] });
    } catch { res.status(503).json({ message: 'DJ event catalogs could not be loaded. Please retry.' }); }
  });
  app.put('/api/admin/dj-service-builder', requireAdmin, async (req, res) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success || JSON.stringify(req.body).length > 500000) return res.status(400).json({ message: parsed.success ? 'The event catalogs are too large.' : parsed.error.issues[0].message });
    const plans = parsed.data.plans;
    const planIds = plans.map(row => row.id);
    if (new Set(planIds).size !== planIds.length || plans.some(row => new Set(row.workIds).size !== row.workIds.length || new Set(row.segments.map(item => item.id)).size !== row.segments.length)) return res.status(400).json({ message: 'Event and segment identifiers must be unique.' });
    const recordingIds = [...new Set(plans.flatMap(row => [...row.workIds, ...row.segments.flatMap(item => item.recordingIds)]))];
    try {
      const active = await ArchiveModel.find({ externalId: { $in: recordingIds }, published: true, archivalStatus: { $ne: 'ARCHIVED' }, $or: [{ workId: { $exists: false } }, { workId: '' }, { publicationStatus: 'PUBLISHED' }] }).select('externalId').lean();
      if (active.length !== recordingIds.length) return res.status(400).json({ message: 'A selected recording is no longer available. Refresh your recordings and try again.' });
      const saved = await Store.findOneAndUpdate({ _id: 'main' }, { $set: { plans } }, { new: true, upsert: true, runValidators: true }).lean();
      res.set('Cache-Control', 'no-store').json({ plans: saved.plans || [] });
    } catch { res.status(503).json({ message: 'The DJ event catalog could not be saved. Your changes remain in the editor; please retry.' }); }
  });
}

module.exports = { registerDjServiceBuilder, PlanStore };
