// The development UI uses Render for account routes and the local API for AI.
// Verify its existing bearer session against the same trusted account server;
// never ask the browser to supply an identity or an authentication URL.
function createAiBookingAuth({ localAuth, fetchImpl = fetch, authUrl = 'https://echo-khalil-api.onrender.com/api/auth/me', adminCheck = null }) {
  return async (req, res, next) => {
    const authorization = req.headers.authorization || '';
    if (!/^Bearer \S{1,2048}$/.test(authorization)) return res.status(401).json({ message: 'Sign in is required.' });
    try {
      const local = await localAuth(req);
      if (local) {
        if (adminCheck && !adminCheck(local)) return res.status(403).json({ message: 'Administrator access is required.' });
        req.authUser = local;
        if (adminCheck) req.user = local;
        return next();
      }
      const upstream = await fetchImpl(authUrl, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (upstream.status === 401 || upstream.status === 403) return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
      if (!upstream.ok) return res.status(503).json({ message: 'Sign-in verification is temporarily unavailable. Please try again.' });
      const { user } = await upstream.json();
      const id = user?.id || user?._id;
      if (typeof id !== 'string' || !id) return res.status(401).json({ message: 'A valid account session is required.' });
      // Only the trusted account server may assert a remote administrator role.
      if (adminCheck && user.isAdmin !== true) return res.status(403).json({ message: 'Administrator access is required.' });
      req.authUser = { id };
      return next();
    } catch { return res.status(503).json({ message: 'Could not verify your sign-in. Please try again shortly.' }); }
  };
}
module.exports = { createAiBookingAuth };
