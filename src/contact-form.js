const crypto = require('node:crypto');
const mongoose = require('mongoose');
const {z} = require('zod');
const {sendBrevoEmail} = require('./brevo');
const {BOOKINGS} = require('./business-mail-identity');

const Submission = mongoose.models.PublicContactSubmission || mongoose.model('PublicContactSubmission', new mongoose.Schema({
  _id: String, state: String, expiresAt: {type: Date, expires: 0},
}, {timestamps: true}));
const Limit = mongoose.models.PublicContactLimit || mongoose.model('PublicContactLimit', new mongoose.Schema({
  _id: String, count: Number, expiresAt: {type: Date, expires: 0},
}));
const singleLine = max => z.string().trim().min(1).max(max).refine(v => !/[\r\n\x00-\x1f\x7f]/.test(v));
const schema = z.object({
  requestId: z.string().uuid(), name: singleLine(100),
  email: z.string().trim().max(254).email(), subject: singleLine(160),
  message: z.string().trim().min(10).max(5000),
  website: z.string().max(200).optional().default(''),
}).strict();

async function reserve(key, maximum, now) {
  try {
    const row = await Limit.findOneAndUpdate({_id:key}, {$inc:{count:1}, $setOnInsert:{expiresAt:new Date(now + 2*86400000)}}, {upsert:true, new:true}).lean();
    return row.count <= maximum;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

function registerContactForm(app) {
  app.post('/api/contact', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({message:'Enter your name, a valid email, subject and a message of 10–5,000 characters.'});
    const data = parsed.data;
    if (data.website) return res.status(400).json({message:'Unable to submit this form. Please email us directly.'});
    if (!process.env.BREVO_API_KEY?.trim()) return res.status(503).json({message:'Contact sending is unavailable. Please email bookings@djkhalilnahhat.ca directly.'});
    try {
      const previous = await Submission.findById(data.requestId).lean();
      if (previous) return previous.state === 'sent'
        ? res.json({sent:true})
        : res.status(409).json({uncertain:true, message:'This submission is awaiting confirmation. Please do not send another copy; contact us by email if needed.'});
      const now = Date.now();
      const ip = crypto.createHash('sha256').update(req.ip || req.socket.remoteAddress || 'unknown').digest('hex');
      if (!await reserve(`ip:${ip}:${Math.floor(now/3600000)}`,5,now) || !await reserve(`daily:${Math.floor(now/86400000)}`,60,now)) {
        res.set('Retry-After','3600');
        return res.status(429).json({message:'The contact form has reached its sending limit. Please email bookings@djkhalilnahhat.ca directly.'});
      }
      try { await Submission.create({_id:data.requestId,state:'pending',expiresAt:new Date(now+7*86400000)}); }
      catch (error) { if (error.code === 11000) return res.status(409).json({uncertain:true,message:'This message has already been submitted. Please do not send another copy.'}); throw error; }
      const result = await sendBrevoEmail({
        to:[{email:BOOKINGS,name:'Echo Bookings'}], replyTo:{email:data.email,name:data.name},
        subject:`Website contact: ${data.subject}`, tags:['website-contact'],
        textContent:`Website contact\n\nName: ${data.name}\nEmail: ${data.email}\nSubject: ${data.subject}\n\n${data.message}`,
      });
      if (!result.sent) throw new Error('Contact email was not accepted');
      await Submission.updateOne({_id:data.requestId},{$set:{state:'sent'}});
      return res.json({sent:true});
    } catch {
      // A transport timeout may follow provider acceptance. Keep the same ID
      // blocked rather than automatically sending a duplicate message.
      return res.status(503).json({uncertain:true,message:'We could not confirm this submission. Please do not resubmit it; email bookings@djkhalilnahhat.ca if you need to follow up.'});
    }
  });
}
module.exports = {registerContactForm};
