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
function registerEventFiles(app, { requireAuth, uploadImpl = uploadAsset }) {
  app.post('/api/ai-booking/event-files', requireAuth, (req, res, next) => upload.single('file')(req, res, error => error ? res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 10 MB.' : 'Upload failed.' }) : next()), async (req, res) => {
    const kind = req.body?.kind === 'photo' ? 'photo' : 'file', type = TYPES[req.file?.mimetype];
    if (!req.file || !type) return res.status(400).json({ message: 'Upload a JPG, PNG or WebP photo, or a PDF, Word or text document.' });
    if (kind === 'photo' && type[0] !== 'image') return res.status(400).json({ message: 'Photos must be JPG, PNG or WebP.' });
    if (kind === 'file' && type[0] === 'image') return res.status(400).json({ message: 'Documents must be PDF, Word or text files.' });
    try {
      const result = await uploadImpl(req.file.buffer, { folder: 'khalil/event-references', resource_type: type[0], type: 'upload', public_id: `file.${type[1]}` });
      const name = String(req.file.originalname || `file.${type[1]}`).replace(/[\u0000-\u001f]/g, '').slice(0, 160);
      res.json({ url: result.secure_url, name });
    } catch (error) { console.error('Event file upload failed:', error); res.status(502).json({ message: 'Could not store that file. Try again.' }); }
  });
}
module.exports = { registerEventFiles };
