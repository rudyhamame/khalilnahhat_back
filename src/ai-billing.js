const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { z } = require('zod');
const { User } = require('./models');

const invoiceSchema = new mongoose.Schema({
  _id: String, number: { type: String, unique: true }, owner: { type: String, index: true },
  currency: String, client: { name: String, email: String },
  items: [{ _id: false, usageId: String, date: Date, mode: String, model: String, cents: Number }],
  totalCents: Number, paidCents: { type: Number, default: 0 }, status: String,
  issuedAt: Date, dueAt: Date, note: String, createdBy: String,
  payments: [{ _id: false, id: String, cents: Number, method: String, reference: String, recordedAt: Date, recordedBy: String }],
  voidReason: String, voidedAt: Date, voidedBy: String,
}, { timestamps: true });
const Invoice = mongoose.models.EchoAiInvoice || mongoose.model('EchoAiInvoice', invoiceSchema);
const fail = (status, message) => Object.assign(new Error(message), { status });
const ownerId = z.string().regex(/^[a-f0-9]{24}$/i);
const invoiceId = z.string().regex(/^[a-f0-9]{32}$/);
const usageId = z.string().regex(/^[a-f0-9]{64}$/);
const currency = z.enum(['CAD', 'USD']);
const pageSchema = z.coerce.number().int().min(1).max(100000).default(1);
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const client = user => ({ name: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Unavailable account', email: user?.email || '' });
const publicInvoice = item => ({
  id: item._id, number: item.number, owner: item.owner, currency: item.currency,
  client: item.client, items: item.items, totalCents: item.totalCents,
  paidCents: item.paidCents, balanceCents: item.status === 'void' ? 0 : item.totalCents - item.paidCents,
  status: item.status, issuedAt: item.issuedAt, dueAt: item.dueAt, note: item.note || '',
  payments: (item.payments || []).map(({ id, cents, method, reference, recordedAt }) => ({ id, cents, method, reference, recordedAt })),
  voidReason: item.voidReason || '',
});

function mongoBillingStore(Usage) {
  const match = ({ owner, currency: money, status }) => ({ ...(owner ? { owner } : {}), ...(money ? { currency: money } : {}), ...(status ? { billingStatus: status } : {}) });
  return {
    async accounts({ owner, search = '', page = 1 }) {
      const group = { _id: { owner: '$owner', currency: '$currency' }, requests: { $sum: 1 } };
      for (const status of ['unbilled', 'invoiced', 'paid', 'void']) group[`${status}Cents`] = { $sum: { $cond: [{ $and: [{ $eq: ['$state', 'completed'] }, { $eq: ['$billingStatus', status] }] }, '$customerCents', 0] } };
      group.providerUsdEstimate = { $sum: { $ifNull: ['$providerUsdEstimate', 0] } };
      group.unmeasuredRequests = { $sum: { $cond: [{ $eq: [{ $ifNull: ['$providerUsdEstimate', null] }, null] }, 1, 0] } };
      const pipeline = [{ $match: match({ owner }) }, { $group: group },
        { $lookup: { from: User.collection.name, let: { accountId: '$_id.owner' }, pipeline: [
          { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$accountId'] } } },
          { $project: { firstName: 1, lastName: 1, email: 1 } },
        ], as: 'users' } }];
      if (search) pipeline.push({ $match: { $or: [{ 'users.firstName': new RegExp(literal(search), 'i') }, { 'users.lastName': new RegExp(literal(search), 'i') }, { 'users.email': new RegExp(literal(search), 'i') }, { '_id.owner': new RegExp(literal(search), 'i') }] } });
      pipeline.push({ $sort: { '_id.owner': 1, '_id.currency': 1 } }, { $facet: { items: [{ $skip: (page - 1) * 20 }, { $limit: 20 }], count: [{ $count: 'total' }] } });
      const [result] = await Usage.aggregate(pipeline);
      return { items: result.items.map(item => ({ owner: item._id.owner, currency: item._id.currency, client: client(item.users[0]), requests: item.requests,
        unbilledCents: item.unbilledCents, invoicedCents: item.invoicedCents, paidCents: item.paidCents, voidCents: item.voidCents,
        providerUsdEstimate: item.providerUsdEstimate, unmeasuredRequests: item.unmeasuredRequests })), total: result.count[0]?.total || 0, page, pageSize: 20 };
    },
    async usage(query) {
      const filter = match(query), page = query.page || 1;
      const [items, total] = await Promise.all([Usage.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 50).limit(50).lean(), Usage.countDocuments(filter)]);
      return { items: items.map(item => ({ id: item._id, owner: item.owner, mode: item.mode, model: item.model, state: item.state, billingStatus: item.billingStatus,
        customerCents: item.customerCents, currency: item.currency, providerUsdEstimate: item.providerUsdEstimate ?? null, createdAt: item.createdAt, invoiceId: item.invoiceId || '', reference: item.reference || '' })), total, page, pageSize: 50 };
    },
    async invoices({ owner, page = 1 }) {
      const filter = owner ? { owner } : {};
      const [items, total] = await Promise.all([Invoice.find(filter).sort({ issuedAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20).lean(), Invoice.countDocuments(filter)]);
      return { items: items.map(publicInvoice), total, page, pageSize: 20 };
    },
    invoice: (id, owner) => Invoice.findOne({ _id: id, ...(owner ? { owner } : {}) }).lean(),
    async create(body, actor) {
      return mongoose.connection.transaction(async session => {
        const existing = await Invoice.findById(body.id).session(session).lean();
        if (existing) {
          if (existing.owner !== body.owner || existing.currency !== body.currency || existing.items.length !== body.usageIds.length || existing.items.some(item => !body.usageIds.includes(item.usageId))) throw fail(409, 'This invoice request was already used.');
          return existing;
        }
        const user = await User.findById(body.owner).select('firstName lastName email').session(session).lean();
        if (!user) throw fail(404, 'Client account not found.');
        const items = await Usage.find({ _id: { $in: body.usageIds }, owner: body.owner, currency: body.currency, state: 'completed', billingStatus: 'unbilled', invoiceId: { $exists: false }, customerCents: { $gt: 0 } }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
        if (items.length !== body.usageIds.length) throw fail(409, 'Some selected usage is no longer unbilled. Refresh and try again.');
        const issuedAt = new Date();
        const [invoice] = await Invoice.create([{
          _id: body.id, number: `EAI-${issuedAt.toISOString().slice(0, 10).replaceAll('-', '')}-${body.id.slice(0,16).toUpperCase()}`,
          owner: body.owner, currency: body.currency, client: client(user),
          items: items.map(item => ({ usageId: item._id, date: item.createdAt, mode: item.mode, model: item.model, cents: item.customerCents })),
          totalCents: items.reduce((sum, item) => sum + item.customerCents, 0), paidCents: 0, status: 'unpaid', issuedAt,
          dueAt: new Date(issuedAt.getTime() + body.dueDays * 86400000), note: body.note, createdBy: actor, payments: [],
        }], { session });
        const result = await Usage.updateMany({ _id: { $in: body.usageIds }, billingStatus: 'unbilled', invoiceId: { $exists: false } }, { $set: { invoiceId: body.id, billingStatus: 'invoiced', reference: invoice.number, updatedBy: actor } }, { session });
        if (result.modifiedCount !== items.length) throw fail(409, 'Usage changed. Refresh and try again.');
        return invoice.toObject();
      });
    },
    async update(id, body, actor) {
      return mongoose.connection.transaction(async session => {
        const invoice = await Invoice.findById(id).session(session);
        if (!invoice) throw fail(404, 'Invoice not found.');
        if (body.action === 'payment') {
          const old = invoice.payments.find(item => item.id === body.id);
          if (old) {
            if (old.cents !== body.cents || old.method !== body.method || old.reference !== body.reference) throw fail(409, 'This payment request was already used.');
            return invoice.toObject();
          }
          if (invoice.status === 'void' || body.cents > invoice.totalCents - invoice.paidCents) throw fail(409, 'Payment exceeds the outstanding balance or the invoice is void.');
          invoice.payments.push({ id: body.id, cents: body.cents, method: body.method, reference: body.reference, recordedAt: new Date(), recordedBy: actor });
          invoice.paidCents += body.cents;
          invoice.status = invoice.paidCents === invoice.totalCents ? 'paid' : 'partial';
          if (invoice.status === 'paid') await Usage.updateMany({ invoiceId: id }, { $set: { billingStatus: 'paid', updatedBy: actor } }, { session });
        } else {
          if (invoice.status === 'void') return invoice.toObject();
          if (invoice.paidCents) throw fail(409, 'An invoice with received payments cannot be voided.');
          invoice.status = 'void'; invoice.voidReason = body.reason; invoice.voidedAt = new Date(); invoice.voidedBy = actor;
          await Usage.updateMany({ invoiceId: id }, { $set: { billingStatus: 'void', updatedBy: actor } }, { session });
        }
        await invoice.save({ session });
        return invoice.toObject();
      });
    },
    // Partial receipts are recorded on invoices; usage rows become paid only on settlement.
    async balances(owner) {
      return Invoice.aggregate([{ $match: { ...(owner ? { owner } : {}), status: { $in: ['unpaid', 'partial'] } } }, { $group: { _id: { owner: '$owner', currency: '$currency' }, partialPaidCents: { $sum: '$paidCents' } } }]);
    },
  };
}

const createSchema = z.object({ id: invoiceId, owner: ownerId, currency, usageIds: z.array(usageId).min(1).max(500).refine(ids => new Set(ids).size === ids.length, 'Select each usage entry once.'), dueDays: z.number().int().min(0).max(90).default(30), note: z.string().trim().max(2000).default('') }).strict();
const updateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('payment'), id: z.uuid(), cents: z.number().int().min(1).max(50000000), method: z.enum(['etransfer', 'cheque', 'bank_transfer', 'other']), reference: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal('void'), reason: z.string().trim().min(1).max(500) }).strict(),
]);
function createAiBilling({ store }) {
  const parse = (schema, body) => { const result = schema.safeParse(body); if (!result.success) throw fail(400, result.error.issues[0]?.message || 'Invalid billing request.'); return result.data; };
  return {
    async accounts(query, owner) {
      const args = parse(z.object({ search: z.string().trim().max(120).default(''), page: pageSchema }).strict(), query);
      const result = await store.accounts({ ...args, owner });
      const partial = await store.balances(owner);
      result.items = result.items.map(item => {
        const received = partial.find(row => row._id.owner === item.owner && row._id.currency === item.currency)?.partialPaidCents || 0;
        const result = { ...item, paidCents: item.paidCents + received, invoicedCents: item.invoicedCents - received, outstandingCents: item.unbilledCents + item.invoicedCents - received };
        if (owner) { delete result.providerUsdEstimate; delete result.unmeasuredRequests; }
        return result;
      });
      return result;
    },
    usage: query => store.usage(parse(z.object({ owner: ownerId, currency: currency.optional(), status: z.enum(['included', 'unbilled', 'invoiced', 'paid', 'void']).optional(), page: pageSchema }).strict(), query)),
    invoices: (query, owner) => store.invoices({ ...parse(z.object({ owner: ownerId.optional(), page: pageSchema }).strict(), query), ...(owner ? { owner } : {}) }),
    async invoice(id, owner) { parse(invoiceId, id); const item = await store.invoice(id, owner); if (!item) throw fail(404, 'Invoice not found.'); return publicInvoice(item); },
    async create(body, actor) { return publicInvoice(await store.create(parse(createSchema, body), actor)); },
    async update(id, body, actor) { parse(invoiceId, id); return publicInvoice(await store.update(id, parse(updateSchema, body), actor)); },
  };
}
function registerAiBilling(app, { requireAdmin, service }) {
  const identity = req => String(req.authUser?._id || req.authUser?.id || req.user?._id || '');
  const guarded = handler => async (req, res) => { res.set('Cache-Control', 'no-store'); try { await handler(req, res); } catch (e) { res.status([400, 404, 409].includes(e.status) ? e.status : 503).json({ message: e.status ? e.message : 'AI billing is temporarily unavailable.' }); } };
  const admin = '/api/ai-booking/admin/billing';
  app.get(`${admin}/accounts`, requireAdmin, guarded(async (req, res) => res.json(await service.accounts(req.query))));
  app.get(`${admin}/usage`, requireAdmin, guarded(async (req, res) => res.json(await service.usage(req.query))));
  app.get(`${admin}/invoices`, requireAdmin, guarded(async (req, res) => res.json(await service.invoices(req.query))));
  app.get(`${admin}/invoices/:id`, requireAdmin, guarded(async (req, res) => res.json({ item: await service.invoice(req.params.id) })));
  app.post(`${admin}/invoices`, requireAdmin, guarded(async (req, res) => res.status(201).json({ item: await service.create(req.body, identity(req)) })));
  app.patch(`${admin}/invoices/:id`, requireAdmin, guarded(async (req, res) => res.json({ item: await service.update(req.params.id, req.body, identity(req)) })));
}
module.exports = { mongoBillingStore, createAiBilling, registerAiBilling, Invoice };
