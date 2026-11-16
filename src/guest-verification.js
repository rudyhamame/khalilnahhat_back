const crypto = require('crypto');
const mongoose = require('mongoose');
const { z } = require('zod');
const { hashPassword } = require('./security');

// Email verification for guests who book without signing up. A 6-digit code is emailed; entering it creates a passwordless
// account for that email (isGuest), so the draft and the quote request stay scoped to an authenticated owner like any other client's.
const CODE_MS = 10 * 60 * 1000, RESEND_MS = 60 * 1000, MAX_ATTEMPTS = 5;
const Challenge = mongoose.models.GuestVerification || mongoose.model('GuestVerification', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  codeHash: String, attempts: { type: Number, default: 0 }, sentAt: Date,
  expiresAt: { type: Date, expires: 0 }, // MongoDB removes the row once it has expired
}));
const mongoStore = {
  get: (email) => Challenge.findOne({ email }).lean(),
  save: (email, row) => Challenge.updateOne({ email }, { $set: row }, { upsert: true }),
  bump: (email) => Challenge.updateOne({ email }, { $inc: { attempts: 1 } }),
  remove: (email) => Challenge.deleteOne({ email }),
};
const hashCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const confirmSchema = z.object({
  email: emailSchema, code: z.string().trim().regex(/^\d{6}$/),
  fullName: z.string().trim().min(1).max(120), phone: z.string().trim().max(30).optional().default(''), company: z.string().trim().max(120).optional().default(''),
});

function registerGuestVerification(app, { User, serializeUser, isAdminUser, issueSession, sendMail, store = mongoStore, now = Date.now, randomCode = () => String(crypto.randomInt(100000, 1000000)) }) {
  // Always answers ok, so it cannot be used to find out which emails already have an account.
  app.post('/api/guest/verify/start', async (req, res) => {
    const email = emailSchema.safeParse(req.body?.email);
    if (!email.success) return res.status(400).json({ message: 'Enter a valid email address.' });
    const address = email.data;
    try {
      const existing = await store.get(address);
      if (existing?.sentAt && now() - new Date(existing.sentAt).getTime() < RESEND_MS) return res.json({ ok: true, retryAfter: Math.ceil((RESEND_MS - (now() - new Date(existing.sentAt).getTime())) / 1000) });
      const accounts = await User.find({ email: address }).limit(2);
      // Registered (non-guest) clients sign in normally; nothing is sent to them and nothing is revealed.
      if (accounts.some((user) => !user.isGuest)) return res.json({ ok: true });
      const code = randomCode();
      await store.save(address, { codeHash: hashCode(address, code), attempts: 0, sentAt: new Date(now()), expiresAt: new Date(now() + CODE_MS) });
      await sendMail({ to: address, subject: 'Your verification code — Echo Event Entertainment', tags: ['guest-verification'],
        html: `<p>Your verification code is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p>It works for 10 minutes. If you did not ask for it, ignore this email.</p>` });
    } catch (error) { console.error('Guest verification email failed:', error); }
    return res.json({ ok: true });
  });

  app.post('/api/guest/verify/confirm', async (req, res) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter your name, your email and the 6-digit code.' });
    const { email, code, fullName, phone, company } = parsed.data;
    try {
      const row = await store.get(email);
      if (!row || new Date(row.expiresAt).getTime() <= now()) return res.status(400).json({ message: 'This code has expired. Ask for a new one.' });
      if (row.attempts >= MAX_ATTEMPTS) return res.status(429).json({ message: 'Too many wrong codes. Ask for a new one.' });
      const given = Buffer.from(hashCode(email, code)), wanted = Buffer.from(row.codeHash || '');
      if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) { await store.bump(email); return res.status(400).json({ message: 'That code is not right.' }); }
      await store.remove(email);
      const accounts = await User.find({ email }).limit(2);
      let user = accounts[0];
      if (user && (!user.isGuest || user.isAdmin || isAdminUser(user))) return res.status(409).json({ code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Please sign in.' });
      if (user?.isBlocked) return res.status(403).json({ message: 'This account is blocked. Contact support.' });
      if (!user) {
        const [firstName, ...rest] = fullName.split(/\s+/);
        user = await User.create({ username: `guest-${crypto.randomBytes(16).toString('hex')}`, firstName: firstName.slice(0, 120), lastName: rest.join(' ').slice(0, 120), email,
          emailVerified: true, isGuest: true, phoneNumber: phone, company, isAdmin: false, passwordHash: await hashPassword(crypto.randomBytes(48).toString('hex')) });
      }
      const token = await issueSession(user, req, isAdminUser);
      return res.json({ token, user: serializeUser(user) });
    } catch (error) {
      return res.status(error.code === 11000 ? 409 : 503).json({ message: 'Could not verify your email. Please try again.' });
    }
  });
}

module.exports = { registerGuestVerification };
