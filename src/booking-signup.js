const crypto = require('crypto');
const mongoose = require('mongoose');
const { z } = require('zod');

// Sending a booking needs an account. A visitor who is not signed in goes through three steps on purpose:
// 1. create the account (name, email and a password they choose), 2. confirm the email with a 6-digit code, 3. send the booking.
// The account stays "awaiting verification" (no session, no login) until the code is entered; the code then signs them in.
const CODE_MS = 10 * 60 * 1000, RESEND_MS = 60 * 1000, MAX_ATTEMPTS = 5;
const Challenge = mongoose.models.BookingSignupCode || mongoose.model('BookingSignupCode', new mongoose.Schema({
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
const email = z.string().trim().toLowerCase().email('A valid email is required.').max(254);
const startSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required.').max(120), lastName: z.string().trim().min(1, 'Last name is required.').max(120), email,
  password: z.string().min(8, 'Choose a password of at least 8 characters.').max(128),
  phoneNumber: z.string().trim().max(40).optional().default(''), company: z.string().trim().max(120).optional().default(''),
  preferredContact: z.enum(['any', 'email', 'phone']).optional(), phoneContact: z.enum(['whatsapp-text', 'whatsapp-call', 'sms', 'call']).optional(),
});
const verifySchema = z.object({ email, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') });
// The contact choices the guest gave Echo become the account's.
const contact = (data) => ({ ...(data.preferredContact ? { preferredContact: data.preferredContact } : {}), ...(data.phoneContact && data.phoneNumber ? { phoneContact: data.phoneContact } : {}) });
const pending = (user) => user.awaitingVerification && !user.emailVerified;

function registerBookingSignup(app, { User, serializeUser, isAdminUser, issueSession, sendMail, hashPassword, store = mongoStore, now = Date.now, randomCode = () => String(crypto.randomInt(100000, 1000000)) }) {
  async function sendCode(address, name) {
    const row = await store.get(address);
    if (row?.sentAt && now() - new Date(row.sentAt).getTime() < RESEND_MS) return Math.ceil((RESEND_MS - (now() - new Date(row.sentAt).getTime())) / 1000);
    const code = randomCode();
    await store.save(address, { codeHash: hashCode(address, code), attempts: 0, sentAt: new Date(now()), expiresAt: new Date(now() + CODE_MS) });
    await sendMail({ to: address, name, subject: 'Your verification code — Echo Event Entertainment', tags: ['booking-signup'],
      html: `<p>Welcome to Echo Event Entertainment. Your verification code is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p>It works for 10 minutes. If you did not create an account, ignore this email.</p>` });
    return 0;
  }

  // Step 1: create the account (awaiting verification) and email the code.
  app.post('/api/booking-signup/start', async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || 'Check your details and try again.' });
    const data = parsed.data;
    try {
      const existing = await User.find({ email: data.email }).limit(2);
      if (existing.some((user) => !pending(user))) return res.status(409).json({ code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Please sign in.' });
      const passwordHash = await hashPassword(data.password);
      if (existing.length) await User.updateOne({ _id: existing[0]._id }, { firstName: data.firstName, lastName: data.lastName, passwordHash, phoneNumber: data.phoneNumber, company: data.company, ...contact(data) });
      else await User.create({ username: `client-${crypto.randomUUID()}`, firstName: data.firstName, lastName: data.lastName, email: data.email, passwordHash,
        phoneNumber: data.phoneNumber, company: data.company, ...contact(data), isAdmin: false, awaitingVerification: true, emailVerified: false });
      if (!existing.length) require('./admin-alerts').alert('signup');
      const retryAfter = await sendCode(data.email, data.firstName);
      return res.status(202).json({ pending: true, email: data.email, retryAfter });
    } catch (error) {
      return res.status(error.code === 11000 ? 409 : 503).json({ message: 'Could not create your account. Please try again.' });
    }
  });

  // Always answers ok, so it cannot be used to find out which emails are registered.
  app.post('/api/booking-signup/resend', async (req, res) => {
    const address = email.safeParse(req.body?.email);
    if (address.success) {
      try {
        const user = (await User.find({ email: address.data }).limit(1))[0];
        if (user && pending(user)) await sendCode(address.data, user.firstName);
      } catch (error) { console.error('Verification code email failed:', error); }
    }
    return res.json({ ok: true });
  });

  // Step 2: the code confirms the email and signs the new client in.
  app.post('/api/booking-signup/verify', async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || 'Enter the 6-digit code.' });
    const address = parsed.data.email;
    try {
      const row = await store.get(address);
      if (!row || new Date(row.expiresAt).getTime() <= now()) return res.status(400).json({ message: 'This code has expired. Ask for a new one.' });
      if (row.attempts >= MAX_ATTEMPTS) return res.status(429).json({ message: 'Too many wrong codes. Ask for a new one.' });
      const given = Buffer.from(hashCode(address, parsed.data.code)), wanted = Buffer.from(row.codeHash || '');
      if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) { await store.bump(address); return res.status(400).json({ message: 'That code is not right.' }); }
      const user = (await User.find({ email: address }).limit(1))[0];
      if (!user || !pending(user) || user.isBlocked || user.isAdmin || isAdminUser(user)) return res.status(400).json({ message: 'This code cannot be used. Sign in or create your account again.' });
      await store.remove(address);
      await User.updateOne({ _id: user._id }, { emailVerified: true, awaitingVerification: false });
      user.emailVerified = true; user.awaitingVerification = false;
      const token = await issueSession(user, req, isAdminUser);
      return res.json({ token, user: serializeUser(user) });
    } catch (error) {
      return res.status(503).json({ message: 'Could not verify your email. Please try again.' });
    }
  });
}

module.exports = { registerBookingSignup };
