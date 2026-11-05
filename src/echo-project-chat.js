const mongoose = require('mongoose');
const { z } = require('zod');

const Message = mongoose.models.EchoProjectChatMessage || mongoose.model('EchoProjectChatMessage', new mongoose.Schema({
  senderId: { type: String, required: true },
  senderName: { type: String, required: true },
  content: { type: String, required: true, maxlength: 2000 },
  attachment: { type: { type: String, enum: ['image', 'audio'] }, name: String, mimeType: String, data: String },
}, { timestamps: true }));

function registerEchoProjectChat(app, { requireAdmin }) {
  const actor = req => req.user || req.authUser;
  const userId = req => String(actor(req)?._id || actor(req)?.id || '');
  const serialize = item => ({ id: String(item._id), senderId: item.senderId, senderName: item.senderName, content: item.content, attachment: item.attachment?.data ? item.attachment : undefined, createdAt: item.createdAt });
  app.get('/api/echo-project-chat', requireAdmin, async (req, res) => {
    if (!userId(req)) return res.status(401).json({ message: 'Sign in to use project chat.' });
    try {
      const items = await Message.find().sort({ createdAt: 1, _id: 1 }).limit(200).lean();
      res.set('Cache-Control', 'no-store').json({ items: items.map(serialize) });
    } catch { res.status(503).json({ message: 'Project chat is temporarily unavailable.' }); }
  });
  app.post('/api/echo-project-chat', requireAdmin, async (req, res) => {
    if (!userId(req)) return res.status(401).json({ message: 'Sign in to use project chat.' });
    const attachment = z.object({ type: z.enum(['image', 'audio']), name: z.string().max(160), mimeType: z.string().max(100), data: z.string().max(7_500_000) }).optional();
    const parsed = z.object({ content: z.string().trim().max(2000).default(''), attachment }).refine(value => value.content || value.attachment).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Add a message or a supported image or voice note.' });
    if (parsed.data.attachment) {
      const { type, mimeType, data } = parsed.data.attachment;
      const validMime = type === 'image' ? /^image\/(png|jpeg|webp|gif)$/.test(mimeType) : /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav)$/.test(mimeType);
      if (!validMime || !data.startsWith(`data:${mimeType};base64,`) || data.length > (type === 'image' ? 5_500_000 : 7_500_000)) return res.status(400).json({ message: 'Attachment type or size is not supported.' });
    }
    try {
      const user = actor(req);
      const item = await Message.create({ senderId: userId(req), senderName: String(user.name || user.firstName || user.email || 'Echo user').slice(0, 120), content: parsed.data.content, attachment: parsed.data.attachment });
      res.status(201).json({ item: serialize(item.toObject()) });
    } catch { res.status(503).json({ message: 'Message could not be sent. Please try again.' }); }
  });
}

module.exports = { registerEchoProjectChat, Message };
