const mongoose = require('mongoose');
const { z } = require('zod');

// The administrator's saved quote terms: ONE set of defaults, independent of any booking. A new quote starts from them;
// each published quote keeps its own copy of the terms (stored on the booking), so editing the defaults never changes a quote already sent.
const termsSchema = z.object({
  validDays: z.coerce.number().int().min(1).max(60),
  paymentInstructions: z.string().trim().max(1000).default(''),
  paymentOptions: z.array(z.enum(['etransfer', 'cheque', 'bank_transfer', 'other'])).max(4).default([]),
  etransferEmail: z.union([z.literal(''), z.string().trim().email().max(254)]).default(''),
}).strict();

const QuoteTerms = mongoose.models.QuoteTerms || mongoose.model('QuoteTerms', new mongoose.Schema({
  key: { type: String, unique: true, default: 'default' },
  validDays: { type: Number, default: 7 },
  paymentInstructions: { type: String, default: '' },
  paymentOptions: { type: [String], default: [] },
  etransferEmail: { type: String, default: '' },
}, { timestamps: true }));

const pick = (doc) => ({ validDays: doc?.validDays ?? 7, paymentInstructions: doc?.paymentInstructions || '', paymentOptions: doc?.paymentOptions || [], etransferEmail: doc?.etransferEmail || '' });

function registerQuoteTerms(app, { requireAdmin, Model = QuoteTerms }) {
  app.get('/api/admin/quote-terms', requireAdmin, async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ terms: pick(await Model.findOne({ key: 'default' })) });
  });
  app.put('/api/admin/quote-terms', requireAdmin, async (req, res) => {
    const parsed = termsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Check the quote terms: validity 1–60 days, a valid e-transfer email and known payment options.' });
    const saved = await Model.findOneAndUpdate({ key: 'default' }, { $set: { ...parsed.data, paymentOptions: [...new Set(parsed.data.paymentOptions)] } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ terms: pick(saved) });
  });
}
module.exports = { registerQuoteTerms, termsSchema, pick, QuoteTerms };
