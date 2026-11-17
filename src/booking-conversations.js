const mongoose = require('mongoose');
const { z } = require('zod');
const deletedDrafts=require('./deleted-event-drafts');
const {aiFields,validValue}=require('./eventOrderCore.mjs');
const musicFieldsSchema=z.array(z.object({path:z.string(),value:z.unknown()}).refine(change=>{const field=aiFields.find(field=>field.key===change.path&&field.key.startsWith('music.'));return Boolean(field&&validValue(field,change.value));})).max(25).optional();

const venueResultsSchema=z.array(z.object({name:z.string().max(240),address:z.string().max(500),city:z.string().max(160).optional(),postalCode:z.string().max(12).optional(),country:z.string().max(80).optional(),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),source:z.string().max(80).optional(),sourceId:z.string().max(500).optional(),sourceAttribution:z.string().max(1200).optional()})).max(10).optional();

const messageSchema = z.object({ id: z.uuid(), role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000), actions:z.array(z.object({label:z.string().max(200),goto:z.string().max(120).optional(),text:z.string().max(2000).optional(),danger:z.boolean().optional()})).max(20).optional(), musicFields:musicFieldsSchema, venueResults:venueResultsSchema, mode: z.enum(['chat', 'voice']), segmentId: z.uuid().nullish().transform(value=>value??undefined), fieldPath:z.string().max(120).nullish().transform(value=>value??undefined), section:z.enum(['none','home','tree','work','availability','music','setup','simulation','booking','live','about']).nullish().transform(value=>value??undefined), face:z.enum(['none','calendar','venue']).nullish().transform(value=>value??undefined) });
const appendSchema = z.object({ consent: z.literal(true), id: z.uuid(), messages: z.array(messageSchema).min(1).max(8) });
const schema = new mongoose.Schema({
  _id: String,
  owner: { type: String, required: true, index: true },
  messages: [{ _id: false, id: String, role: String, content: String, mode: String, segmentId: String, fieldPath:String, actions:mongoose.Schema.Types.Mixed, musicFields:mongoose.Schema.Types.Mixed, venueResults:mongoose.Schema.Types.Mixed, section:String, face:String, createdAt: Date }],
}, { timestamps: true });
schema.index({ owner: 1, updatedAt: -1 });
const Conversation = mongoose.models.BookingConversation || mongoose.model('BookingConversation', schema);
const mongoStore = {
  list: owner => Conversation.find({ owner }).sort({ updatedAt: -1 }).limit(100).select({ messages: { $slice: 1 } }).lean(),
  get: (owner, id) => Conversation.findOne({ _id: id, owner }).lean(),
  async append(owner, id, messages) {
    if(await deletedDrafts.isDeleted(owner,id))throw Object.assign(new Error('This draft was deleted.'),{status:409});
    try {
      await Conversation.updateOne({ _id: id, owner }, { $setOnInsert: { owner, messages: [] } }, { upsert: true });
    } catch (error) { if (error.code === 11000) return null; throw error; }
    for (const message of messages) {
      const result = await Conversation.updateOne({ _id: id, owner, 'messages.id': { $ne: message.id }, 'messages.999': { $exists: false } }, { $push: { messages: { ...message, createdAt: new Date() } } });
      if (!result.matchedCount) {
        const existing = await Conversation.exists({ _id: id, owner, 'messages.id': message.id });
        if (!existing) throw Object.assign(new Error('Conversation is full. Start a new conversation.'), { status: 409 });
      }
    }
    if(await deletedDrafts.isDeleted(owner,id)){
      await Conversation.deleteOne({_id:id,owner});
      throw Object.assign(new Error('This draft was deleted.'),{status:409});
    }
    return { id };
  },
};
const summary = item => ({ id: item._id, createdAt: item.createdAt, updatedAt: item.updatedAt, title: item.messages?.find(message => message.role === 'user')?.content.slice(0, 100) || 'AI booking conversation' });

function registerBookingConversations(app, { requireAuth, store = mongoStore }) {
  const usage = new Map();
  const owner = req => String(req.authUser?._id || req.authUser?.id || '');
  const guarded = handler => async (req, res) => {
    if (!owner(req)) return res.status(401).json({ message: 'Sign in to view your conversations.' });
    try { await handler(req, res); }
    catch (error) { res.status(error.status === 409 ? 409 : 503).json({ message: error.status === 409 ? 'This conversation is full. Start a new conversation.' : 'Conversation history is temporarily unavailable. Please retry.' }); }
  };
  app.get('/api/ai-booking/conversations', requireAuth, guarded(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ items: (await store.list(owner(req))).map(summary) });
  }));
  app.get('/api/ai-booking/conversations/:id', requireAuth, guarded(async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ message: 'Invalid conversation.' });
    const item = await store.get(owner(req), req.params.id);
    res.set('Cache-Control', 'no-store');
    if (!item) return res.status(404).json({ message: 'Conversation not found.' });
    res.json({ item: { ...summary(item), messages: item.messages } });
  }));
  app.post('/api/ai-booking/conversations', requireAuth, guarded(async (req, res) => {
    const input = appendSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Send valid conversation messages and accept the AI notice.', fields:input.error.issues.map(issue=>issue.path.join('.')) });
    const now = Date.now();
    for (const [id, value] of usage) if (value.until <= now) usage.delete(id);
    const bucket = usage.get(owner(req)) || { count: 0, until: now + 600000 };
    if (bucket.count >= 600 || usage.size > 5000) {res.set('Retry-After',String(Math.max(1,Math.ceil((bucket.until-now)/1000))));return res.status(429).json({ message: 'History save limit reached. Please retry later.' });}
    bucket.count++; usage.set(owner(req), bucket);
    const item = await store.append(owner(req), input.data.id, input.data.messages);
    if (!item) return res.status(404).json({ message: 'Conversation not found.' });
    res.json({ id: item.id });
  }));
}
module.exports = { registerBookingConversations, Conversation, mongoStore };
