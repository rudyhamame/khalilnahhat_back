const multer = require('multer');
const { uploadAsset } = require('./cloudinary-assets');
// Client reference files for an event draft: inspiration photos and event documents.
const TYPES = {
  'image/jpeg': ['image', 'jpg'], 'image/png': ['image', 'png'], 'image/webp': ['image', 'webp'],
  'application/pdf': ['raw', 'pdf'], 'application/msword': ['raw', 'doc'], 'text/plain': ['raw', 'txt'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['raw', 'docx'],
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
// ponytail: stored under an unguessable content-hash URL (public delivery), referenced only from the owner's draft; use type:'authenticated' + signed URLs if files become sensitive.
// The file's first bytes must match its declared type: a renamed script or executable is refused whatever the browser claims.
const SIGNATURES = {
  'image/jpeg': [[0xff, 0xd8, 0xff]], 'image/png': [[0x89, 0x50, 0x4e, 0x47]], 'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
  'application/msword': [[0xd0, 0xcf, 0x11, 0xe0]], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [[0x50, 0x4b, 0x03, 0x04]],
};
function matchesType(buffer, mimetype) {
  if (mimetype === 'image/webp') return buffer.length > 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
  if (mimetype === 'text/plain') return !buffer.subarray(0, 2048).includes(0);
  return (SIGNATURES[mimetype] || []).some(signature => signature.every((byte, index) => buffer[index] === byte));
}
// Uploads are open to visitors without an account (signing in happens when the booking is sent), with a small allowance per visitor and a shared one for all visitors.
const WINDOW_MS = 10 * 60 * 1000, LIMITS = { guest: 10, allGuests: 200, client: 40 };
function createUploadLimiter(now = Date.now) {
  const buckets = new Map();
  return (key, limit) => {
    const time = now();
    for (const [id, bucket] of buckets) if (bucket.reset <= time) buckets.delete(id);
    const bucket = buckets.get(key) || { count: 0, reset: time + WINDOW_MS };
    if (bucket.count >= limit || buckets.size > 5000) return false;
    bucket.count++; buckets.set(key, bucket); return true;
  };
}
function registerEventFiles(app, { requireAuth, optionalAuth = requireAuth, uploadImpl = uploadAsset, limiter = createUploadLimiter() }) {
  const guestKey = req => `guest:${require('crypto').createHash('sha256').update(`${req.ip || ''}|${String(req.get?.('user-agent') || '').slice(0, 160)}`).digest('hex').slice(0, 24)}`;
  app.post('/api/ai-booking/event-files', optionalAuth, (req, res, next) => {
    const guest = !req.authUser, owner = guest ? guestKey(req) : `user:${req.authUser._id || req.authUser.id}`;
    if (!limiter(owner, guest ? LIMITS.guest : LIMITS.client) || (guest && !limiter('all-guests', LIMITS.allGuests))) return res.status(429).json({ message: 'Too many uploads for now. Please try again in a few minutes.' });
    return next();
  }, (req, res, next) => upload.single('file')(req, res, error => error ? res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 10 MB.' : 'Upload one file.' }) : next()), async (req, res) => {
    const kind = req.body?.kind === 'photo' ? 'photo' : 'file', type = TYPES[req.file?.mimetype];
    if (!req.file || !type || !matchesType(req.file.buffer, req.file.mimetype)) return res.status(400).json({ message: 'Upload a JPG, PNG or WebP photo, or a PDF, Word or text document.' });
    if (kind === 'photo' && type[0] !== 'image') return res.status(400).json({ message: 'Photos must be JPG, PNG or WebP.' });
    if (kind === 'file' && type[0] === 'image') return res.status(400).json({ message: 'Documents must be PDF, Word or text files.' });
    try {
      const result = await uploadImpl(req.file.buffer, { folder: 'khalil/event-references', resource_type: type[0], type: 'upload', public_id: `file.${type[1]}` });
      const name = String(req.file.originalname || `file.${type[1]}`).replace(/[\u0000-\u001f]/g, '').slice(0, 160);
      res.json({ url: result.secure_url, name });
    } catch (error) { console.error('Event file upload failed:', error); res.status(502).json({ message: 'Could not store that file. Try again.' }); }
  });
}
module.exports = { registerEventFiles, createUploadLimiter, matchesType };
