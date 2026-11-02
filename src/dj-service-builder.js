const { z } = require('zod');
const { ArchiveItem, ServiceRequest } = require('./models');

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const djSegment = z.object({
  id: z.string().min(1).max(100), title: z.string().trim().min(1).max(120), startsAt: z.union([time, z.literal('')]),
  endsAt: z.union([time, z.literal('')]), recordingIds: z.array(z.string().min(1).max(120)).max(200).default([]), notes: z.string().trim().max(1000).default(''),
}).strict();
const djSetSchema = z.object({ segments: z.array(djSegment).max(100), notes: z.string().trim().max(3000).default('') }).strict();

function registerDjServiceBuilder(app, { requireAdmin, ArchiveModel = ArchiveItem, BookingModel = ServiceRequest }) {
  app.put('/api/admin/dj-service-builder/:bookingId', requireAdmin, async (req, res) => {
    const parsed = z.object({ djSet: djSetSchema }).strict().safeParse(req.body);
    if (!parsed.success || JSON.stringify(req.body).length > 250000) return res.status(400).json({ message: parsed.success ? 'The event set plan is too large.' : parsed.error.issues[0].message });
    const { djSet } = parsed.data;
    const segmentIds = djSet.segments.map(row => row.id);
    const recordingIds = [...new Set(djSet.segments.flatMap(row => row.recordingIds))];
    if (new Set(segmentIds).size !== segmentIds.length || djSet.segments.some(row => new Set(row.recordingIds).size !== row.recordingIds.length)) return res.status(400).json({ message: 'Moment and recording placements must be unique.' });
    try {
      if (recordingIds.length) {
        const active = await ArchiveModel.find({ externalId: { $in: recordingIds }, published: true, archivalStatus: { $ne: 'ARCHIVED' }, $or: [{ workId: { $exists: false } }, { workId: '' }, { publicationStatus: 'PUBLISHED' }] }).select('externalId').lean();
        if (active.length !== recordingIds.length) return res.status(400).json({ message: 'A selected recording is no longer available. Refresh your recordings and try again.' });
      }
      const item = await BookingModel.findOne({ externalId: req.params.bookingId, status: 'confirmed' });
      if (!item) return res.status(409).json({ message: 'This confirmed booking could not be found. Refresh the booking list.' });
      item.planning = { ...(item.planning || {}), djSet, updatedAt: new Date() };
      await item.save();
      res.set('Cache-Control', 'no-store').json({ item: { id: item.externalId, planning: item.planning }, djSet: item.planning?.djSet });
    } catch { res.status(503).json({ message: 'The event set plan could not be saved. Your changes remain in the editor; please retry.' }); }
  });
}

module.exports = { registerDjServiceBuilder };
