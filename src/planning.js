const { z } = require('zod');
const { ServiceRequest } = require('./models');

const text = z.string().trim().max(3000).default('');
const planningSchema = z.object({
  brideName: text, groomName: text, timeline: text, partyEntrances: text, entranceSongs: text, firstDance: text,
  parentDances: text, dinnerMusic: text, cakeCutting: text, announcements: text, mustPlay: text, doNotPlay: text,
  musicLinks: text, specialRequests: text,
});

// Post-booking planning form, separate from the quotation questionnaire.
function registerPlanning(app, { requireAuth, serialize }) {
  app.put('/api/service-requests/:id/planning', requireAuth, async (req, res) => {
    const parsed = planningSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Planning details failed validation.' });
    const sr = await ServiceRequest.findOne({ externalId: req.params.id });
    if (!sr || String(sr.userId) !== String(req.authUser._id)) return res.status(404).json({ message: 'Service request not found.' });
    if (sr.status !== 'confirmed') return res.status(409).json({ message: 'Event planning opens once your booking is confirmed.' });
    sr.planning = { ...parsed.data, updatedAt: new Date() };
    await sr.save();
    return res.json({ item: serialize(sr, false) });
  });
}

module.exports = { registerPlanning };
