const crypto = require('crypto');
const { z } = require('zod');
const { User } = require('./models');
const { createSessionToken, hashPassword } = require('./security');
const { sendSimpleEmail } = require('./brevo');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const RESET_MS = 60 * 60 * 1000;
const lastSent = new Map(); // ponytail: in-memory throttle; use a shared store if the API ever runs >1 instance

async function sendVerification(user, baseUrl) {
  const token = newToken();
  await User.updateOne({ _id: user._id }, { verifyTokenHash: sha(token) });
  const link = `${baseUrl}/verify-email?token=${token}`;
  return sendSimpleEmail({ to: user.email, name: user.firstName, subject: 'Verify your email — Echo Event Entertainment', tags: ['verify-email'],
    html: `<p>Welcome to Echo Event Entertainment.</p><p><a href="${link}">Verify your email address</a></p>` });
}

function registerAccount(app, { requireAuth, getFrontendUrl }) {
  app.post('/api/auth/resend-verification', requireAuth, async (req, res) => {
    if (req.authUser.emailVerified) return res.json({ ok: true });
    await sendVerification(req.authUser, getFrontendUrl()).catch((e) => console.error('Verification email failed:', e));
    res.json({ ok: true });
  });

  app.post('/api/auth/verify-email', async (req, res) => {
    const token = String(req.body?.token || '');
    const user = token && await User.findOneAndUpdate({ verifyTokenHash: sha(token) }, { emailVerified: true, verifyTokenHash: '' });
    return user ? res.json({ ok: true }) : res.status(400).json({ message: 'This verification link is invalid or already used.' });
  });

  // Always answers ok so the endpoint cannot be used to discover registered emails.
  app.post('/api/auth/forgot-password', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const recent = lastSent.get(email);
    if (email && (!recent || Date.now() - recent > 60 * 1000)) {
      lastSent.set(email, Date.now());
      for (const user of await User.find({ email })) {
        const token = newToken();
        await User.updateOne({ _id: user._id }, { resetTokenHash: sha(token), resetExpires: new Date(Date.now() + RESET_MS) });
        sendSimpleEmail({ to: user.email, name: user.firstName, subject: 'Reset your password — Echo Event Entertainment', tags: ['password-reset'],
          html: `<p>Use this link within one hour to choose a new password:</p><p><a href="${getFrontendUrl()}/reset-password?token=${token}">Reset password</a></p><p>If you did not ask for this, ignore this email.</p>` })
          .catch((e) => console.error('Reset email failed:', e));
      }
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    const parsed = z.object({ token: z.string().min(10), password: z.string().min(8).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Choose a password of at least 8 characters.' });
    const user = await User.findOneAndUpdate(
      { resetTokenHash: sha(parsed.data.token), resetExpires: { $gt: new Date() } },
      { passwordHash: hashPassword(parsed.data.password), sessionToken: createSessionToken(), resetTokenHash: '', resetExpires: null, emailVerified: true },
    );
    return user ? res.json({ ok: true }) : res.status(400).json({ message: 'This reset link is invalid or expired.' });
  });
}

module.exports = { registerAccount, sendVerification };
