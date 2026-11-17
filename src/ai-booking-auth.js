// All application routes use the same local account/session authority.
// Never send bearer tokens to a former hosting provider for fallback verification.
// optional: a visitor with no sign-in at all continues as a guest (req.authUser stays null); a sign-in that is sent but invalid is still refused.
function createAiBookingAuth({ localAuth, adminCheck = null, optional = false }) {
  return async (req, res, next) => {
    if (optional && !req.headers.authorization) { req.authUser = null; return next(); }
    if (!/^Bearer [a-f0-9]{64}$/.test(req.headers.authorization || '')) return res.status(401).json({ message: 'Sign in is required.' });
    try {
      const user = await localAuth(req);
      if (!user) return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
      if (user.isBlocked) return res.status(403).json({ message: 'This account is blocked. Contact support.' });
      if (adminCheck && !adminCheck(user)) return res.status(403).json({ message: 'Administrator access is required.' });
      req.authUser = user;
      if (adminCheck) req.user = require('./account-sessions').sessionActor(user, req.headers.authorization.slice(7));
      return next();
    } catch { return res.status(503).json({ message: 'Could not verify your sign-in. Please try again shortly.' }); }
  };
}
module.exports = { createAiBookingAuth };
