const crypto = require('node:crypto');
const net = require('node:net');
const mongoose = require('mongoose');
const proxyaddr = require('proxy-addr');
const fs = require('node:fs/promises');
const os = require('node:os');
let activeUploads = 0;
const Counter = mongoose.models.SecurityRateLimit || mongoose.model('SecurityRateLimit', new mongoose.Schema({
  _id: String, count: Number, expiresAt: { type: Date, expires: 0 },
}, { versionKey: false }));
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
async function consume(scope, subject, maximum, windowMs) {
  const now = Date.now(), bucket = Math.floor(now / windowMs), until = (bucket + 1) * windowMs;
  const id = hash(`${scope}:${subject}:${bucket}`);
  let row;
  try {
    row = await Counter.findOneAndUpdate({ _id: id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(until + windowMs) } }, { upsert: true, returnDocument: 'after' }).lean();
  } catch (error) { if (error.code === 11000) return consume(scope, subject, maximum, windowMs); throw error; }
  return row.count <= maximum ? 0 : Math.max(1, Math.ceil((until - now) / 1000));
}
const limited = (res, seconds) => res.status(429).set('Retry-After', String(seconds)).set('Cache-Control', 'no-store')
  .json({ message: 'Too many requests. Please wait before trying again.' });
async function authRateLimit(req, res, next) {
  if (req.method !== 'POST') return next();
  const route = req.path.split('?')[0];
  const ip = req.ip || 'unknown';
  const account = String(typeof req.body?.email === 'string' ? req.body.email : typeof req.body?.username === 'string' ? req.body.username : '').trim().toLowerCase().slice(0, 254);
  const policies = {
    '/login': [['login-total', 'global', 300, 600000], ['login-ip', ip, 30, 600000], ['login-account', account, 12, 600000]],
    '/signup': [['signup-ip', ip, 5, 3600000], ['signup-total', 'global', 100, 86400000]],
    '/forgot-password': [['reset-ip', ip, 10, 3600000], ['reset-account', account, 3, 3600000]],
    '/reset-password': [['reset-submit', ip, 15, 3600000]],
    '/resend-verification': [['verify-send', hash(req.headers.authorization || ip), 3, 3600000]],
    '/verify-email': [['verify-token', ip, 30, 600000]],
    '/google': [['google-ip', ip, 30, 600000]],
  };
  try {
    for (const policy of policies[route] || []) {
      const retry = await consume(...policy); if (retry) return limited(res, retry);
    }
    return next();
  } catch { return res.status(503).json({ message: 'Authentication protection is temporarily unavailable. Please retry shortly.' }); }
}
async function providerSessionLimit(req, res, next) {
  try {
    const retry = await consume('avatar-session', String(req.authUser?._id || req.ip), 3, 600000);
    return retry ? limited(res, retry) : next();
  } catch { return res.status(503).json({ message: 'Session creation is temporarily unavailable.' }); }
}
async function stemStartLimit(req, res, next) {
  if (req.method !== 'POST') return next();
  try {
    for (const policy of [['stem-ip', req.ip || 'unknown', 10, 3600000], ['stem-total', 'global', 50, 86400000]]) {
      const retry = await consume(...policy); if (retry) return limited(res, retry);
    }
    return next();
  } catch { return res.status(503).json({ message: 'Channel processing is temporarily unavailable.' }); }
}
async function resourceAdmission(req, res, next) {
  const multipart = /^multipart\/form-data\b/i.test(req.headers['content-type'] || '');
  const processing = req.method === 'POST' && /(?:upload|to-wav|youtube|recording|stems)/.test(req.path);
  if (!multipart && !processing) return next();
  try {
    const stat = await fs.statfs(os.tmpdir());
    if (stat.bavail * stat.bsize < 1024 * 1024 * 1024) return res.status(507).json({ message: 'Media processing is paused because storage is low. Please contact the administrator.' });
    if (multipart) {
      if (activeUploads >= 2) return res.status(429).set('Retry-After', '15').json({ message: 'Two uploads are already active. Please retry shortly.' });
      activeUploads++;
      let released = false;
      const release = () => { if (!released) { released = true; activeUploads--; } };
      res.once('finish', release); res.once('close', release); req.once('aborted', release);
    }
    next();
  } catch { return res.status(503).json({ message: 'Media storage is temporarily unavailable.' }); }
}
function configureSecurity(app) {
  app.disable('x-powered-by');
  const trusted = proxyaddr.compile((process.env.TRUSTED_PROXY_CIDRS || 'loopback').split(',').map(x => x.trim()).filter(Boolean));
  app.set('trust proxy', trusted);
  app.use((req, res, next) => {
    const connecting = req.headers['cf-connecting-ip'];
    // Only the isolated API bridge gateway may attest Cloudflare's visitor header.
    if (process.env.TRUST_CLOUDFLARE_HEADER === '1' && req.socket?.remoteAddress && trusted(req.socket.remoteAddress, 0) && typeof connecting === 'string' && net.isIP(connecting)) {
      Object.defineProperty(req, 'ip', { value: connecting, configurable: true });
    }
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin', 'Strict-Transport-Security': 'max-age=31536000',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Request-Id': crypto.randomUUID() });
    if (req.headers.authorization || /^\/api\/(auth|admin)(\/|$)/.test(req.path)) res.set('Cache-Control', 'no-store');
    if (Number(req.headers['content-length']) > 101 * 1024 * 1024) return res.status(413).json({ message: 'This upload exceeds the size limit.' });
    next();
  });
}
async function initializeSecurity() { await Counter.init(); }
function securityError(error, req, res, _next) {
  if (res.headersSent) return res.destroy();
  const status = error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large' ? 413 :
    /^LIMIT_/.test(error.code || '') || error.type === 'entity.parse.failed' ? 400 :
    Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  console.error('API request rejected', { requestId: res.getHeader('X-Request-Id'), status, code: error.code || error.type || error.name });
  res.status(status).json({ message: status === 413 ? 'This request exceeds the size limit.' : status === 400 ? 'Invalid request.' :
    status === 403 ? 'This request is not permitted.' : status === 503 ? 'The service is temporarily unavailable. Please retry.' : 'Unexpected server error.' });
}
module.exports = { configureSecurity, initializeSecurity, authRateLimit, providerSessionLimit, stemStartLimit, resourceAdmission, securityError };
