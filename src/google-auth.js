const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { createSessionToken, hashPassword } = require('./security');

function registerGoogleAuth(app, { User, serializeUser, isAdminUser, clientId = process.env.GOOGLE_CLIENT_ID || '', allowedOrigins = [], verifyToken, now = Date.now }) {
  const verifier = new OAuth2Client();
  const verify = verifyToken || (async credential => (await verifier.verifyIdToken({ idToken: credential, audience: clientId })).getPayload());
  const challenges = new Map(), attempts = new Map();
  const origins = new Set(allowedOrigins.filter(origin => origin !== '*'));
  function challenge() {
    for (const [key, expiry] of challenges) if (expiry <= now()) challenges.delete(key);
    if (challenges.size >= 1000) challenges.delete(challenges.keys().next().value);
    const nonce = crypto.randomBytes(32).toString('hex');
    challenges.set(nonce, now() + 5 * 60 * 1000);
    return nonce;
  }
  app.get('/api/auth/google/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(clientId ? { configured: true, clientId, nonce: challenge() } : { configured: false });
  });
  app.post('/api/auth/google', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!clientId) return res.status(503).json({ message: 'Google sign-in is not available yet.' });
    if (!req.is('application/json') || (req.get('origin') && !origins.has(req.get('origin')))) return res.status(403).json({ message: 'Sign in from the Echo website.' });
    for (const [key, item] of attempts) if (item.expires <= now()) attempts.delete(key);
    const key = req.ip;
    const attempt = attempts.get(key) || { count: 0, expires: now() + 60000 };
    if (attempts.size >= 10000 && !attempts.has(key)) return res.status(429).json({ message: 'Please wait a minute before trying again.' });
    attempts.set(key, attempt);
    if (++attempt.count > 10) return res.status(429).json({ message: 'Please wait a minute before trying again.' });
    const { credential, nonce } = req.body || {};
    if (typeof credential !== 'string' || credential.length > 16000 || !credential || typeof nonce !== 'string' || !challenges.has(nonce) || challenges.get(nonce) <= now()) return res.status(401).json({ message: 'Please restart Google sign-in.' });
    challenges.delete(nonce);
    let profile;
    try { profile = await verify(credential); } catch { return res.status(401).json({ message: 'Google could not verify your sign-in. Please try again.' }); }
    if (!profile || profile.nonce !== nonce || typeof profile.sub !== 'string' || !profile.sub || profile.sub.length > 255 || profile.email_verified !== true || typeof profile.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) return res.status(401).json({ message: 'A verified Google account is required.' });
    try {
      let user = await User.findOne({ googleSubject: profile.sub });
      const email = profile.email.toLowerCase();
      if (!user) {
        // Only Google-hosted email can identify an existing account without its password.
        const matches = await User.find({ email }).limit(2);
        if (matches.length) {
          user = matches[0];
          if (matches.length !== 1 || user.googleSubject || user.isAdmin || isAdminUser(user) || !(email.endsWith('@gmail.com') || profile.hd)) return res.status(409).json({ message: 'Please sign in to your existing account with your username and password.' });
          user = await User.findOneAndUpdate({ _id: user._id, username: user.username, isAdmin: { $ne: true }, googleSubject: { $exists: false } }, { $set: { googleSubject: profile.sub, emailVerified: true } }, { new: true });
          if (!user) return res.status(409).json({ message: 'Your account changed. Please try signing in again.' });
        } else {
          user = await User.create({
            googleSubject: profile.sub,
            username: `google-${crypto.randomBytes(16).toString('hex')}`,
            firstName: String(profile.given_name || profile.name || 'Client').slice(0, 120),
            lastName: String(profile.family_name || '').slice(0, 120),
            email, emailVerified: true, phoneNumber: '', isAdmin: false,
            // Google accounts have no usable local password. Password reset can add one.
            passwordHash: hashPassword(crypto.randomBytes(48).toString('hex')),
          });
        }
      }
      if (user.isAdmin || isAdminUser(user)) return res.status(403).json({ message: 'Administrator accounts must sign in with their username and password.' });
      user.sessionToken = createSessionToken();
      await user.save();
      return res.json({ token: user.sessionToken, user: serializeUser(user) });
    } catch (error) {
      return res.status(error.code === 11000 ? 409 : 503).json({ message: 'Could not complete Google sign-in. Please try again.' });
    }
  });
}
module.exports = { registerGoogleAuth };
