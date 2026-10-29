const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { z } = require('zod');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { ArchiveItem } = require('./models');
const archiveFiles = require('./music-archive-files');

const common = { externalId: { type: String, unique: true, required: true }, title: String, description: String,
  published: { type: Boolean, default: false }, sortOrder: { type: Number, default: 0 } };
const Collection = mongoose.models.MusicCollection || mongoose.model('MusicCollection', new mongoose.Schema({ ...common,
  coverImage: String, recordingIds: { type: [String], default: [] } }, { timestamps: true }));
const text = z.string().trim().max(4000);
const base = { title: z.string().trim().min(1).max(240), description: text.default(''), published: z.boolean().default(false), sortOrder: z.number().int().min(0).max(1000000).default(0) };
function ownedAsset(value) {
  if (!value) return true;
  if (archiveFiles.localAssetPattern.test(value)) return true;
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'res.cloudinary.com' && u.pathname.startsWith(`/${process.env.CLOUDINARY_CLOUD_NAME}/`); } catch { return false; }
}
const asset = z.string().max(2048).refine(ownedAsset, 'Choose a file uploaded to this website.');
const inputs = {
  collections: z.object({ ...base, coverImage: asset.default(''), recordingIds: z.array(z.string().min(1).max(120)).max(5000).default([]) }).strict(),
  songs: z.object({ ...base, artist: z.string().trim().max(240).default('DJ Khalil'),
    date: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).refine(value => !value || (!Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value), 'Choose a valid date.').default(''), audioUrl: asset.refine(value => Boolean(value) && (archiveFiles.localAssetPattern.test(value) || /\/video\/(upload|authenticated)\//.test(value)), 'Upload an audio file.'),
    coverImage: asset.default(''), duration: z.string().max(30).default('') }).strict(),
};

// Authenticated uploads stay private at rest; only authorized responses sign them.
function deliveryUrl(value) {
  if (!value) return '';
  if (/\/authenticated\/s--[^/]+--\//.test(value)) return value;
  const match = value.match(/^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video)\/authenticated\/(?:v\d+\/)?(.+)$/);
  if (!match || match[1] !== process.env.CLOUDINARY_CLOUD_NAME) return value;
  return cloudinary.url(match[3], { resource_type: match[2], type: 'authenticated', secure: true, sign_url: true });
}
function serialize(row) {
  const r = row.toObject ? row.toObject() : row;
  return { id: r.externalId, title: r.title, description: r.description || '', published: r.published !== false,
    lyricsTiming:r.lyricsTiming?.audioUrl===r.audioUrl&&[r.workId,...(r.componentWorkIds||[])].includes(r.lyricsTiming?.workId)?{workId:r.lyricsTiming.workId,model:r.lyricsTiming.model,lines:r.lyricsTiming.lines}:null,sortOrder: r.sortOrder || 0, recordingIds: r.recordingIds || [],
    artist: r.artist || 'DJ Khalil', date: r.date || (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : ''),
    audioUrl: deliveryUrl(r.audioUrl), coverImage: deliveryUrl(r.coverImage || r.image), duration: r.duration || '', createdAt: r.createdAt };
}
function visibleSongs(songs) {
  return songs.filter(s => s.published !== false && s.archivalStatus !== 'ARCHIVED' && (!s.workId || s.publicationStatus === 'PUBLISHED'));
}
async function publicSongs(ArchiveModel = ArchiveItem) {
  return visibleSongs(await ArchiveModel.find().sort({ sortOrder: 1, createdAt: -1 }));
}

function registerMusicArchive(app, { requireAdmin, ArchiveModel = ArchiveItem, CollectionModel = Collection, cloudinaryClient = cloudinary, requireCloudinary = process.env.RENDER === 'true' || process.env.MUSIC_ARCHIVE_STORAGE_PROVIDER === 'cloudinary', useCloudinary = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) } = {}) {
  const models = { collections: CollectionModel, songs: ArchiveModel };
  const ontology = ArchiveModel === ArchiveItem ? require('./music-ontology/routes').registerMusicOntology(app, { requireAdmin, service: require('./music-ontology/service').createService({ deliveryUrl, previewUrl: archiveFiles.previewUrl, ownedAsset }) }) : null;
  async function catalog(admin, { includeOntology = true } = {}) {
    const [collections, songs] = await Promise.all(Object.values(models).map(model => model.find().sort({ sortOrder: 1, createdAt: -1 })));
    const visible = admin ? songs : visibleSongs(songs).filter(song => song.audioUrl);
    const shown = admin ? collections : collections.filter(c => c.published !== false);
    const visibleIds = new Set(visible.map(s => s.externalId));
    const adminAssets = row => admin ? { storedAudioUrl: row.audioUrl || '', storedCoverImage: row.coverImage || row.image || '' } : {};
    const present = row => { const item = serialize(row); return admin ? {...item,audioUrl:archiveFiles.previewUrl(item.audioUrl),coverImage:archiveFiles.previewUrl(item.coverImage)} : item; };
    const canonical = ontology && includeOntology ? await ontology.hydrate(visible, {admin}) : null;
    const byId = new Map((canonical || []).map(r => [r.id, r]));
    return { ...(canonical ? { recordings: canonical, ontologyVersion: 1 } : {}), collections: shown.map(c => { const item = { ...present(c), ...adminAssets(c) }; return { ...item, recordingIds: admin ? item.recordingIds : item.recordingIds.filter(id => visibleIds.has(id)), songCount: item.recordingIds.filter(id => visibleIds.has(id)).length }; }), songs: visible.map(s => ({ ...present(s), ...adminAssets(s), ...(canonical ? byId.get(s.externalId) : {}) })) };
  }
  app.get('/api/music-archive/playback', async (_req, res) => { const data = await catalog(false, {includeOntology:false}); res.set('Cache-Control','no-store').json({songs:data.songs}); });
  app.get('/api/music-archive', async (_req, res) => res.set('Cache-Control', 'no-store').json(await catalog(false)));
  app.get('/api/admin/music-archive', requireAdmin, async (_req, res) => res.set('Cache-Control', 'no-store').json(await catalog(true)));
  for (const [kind, model] of Object.entries(models)) {
    const validateParent = async (data) => {
      if (kind !== 'collections' || !data.recordingIds) return '';
      data.recordingIds = [...new Set(data.recordingIds)];
      return await ArchiveModel.countDocuments({ externalId: { $in: data.recordingIds }, archivalStatus: { $ne: 'ARCHIVED' } }) === data.recordingIds.length ? '' : 'Choose existing active recordings. Deleted recordings cannot be added to a collection.';
    };
    app.post(`/api/admin/music-archive/${kind}`, requireAdmin, async (req, res) => {
      if(kind === 'songs' && ontology) return res.status(409).json({message:'Create recordings through the Music Archive ontology editor.',code:'MUSIC_ONTOLOGY_REQUIRED'});
      const parsed = inputs[kind].safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });
      const error = await validateParent(parsed.data);
      if (error) return res.status(400).json({ message: error });
      const extra = kind === 'songs' ? { category: 'Music Archive', mediaType: 'audio' } : {};
      const row = await model.create({ ...extra, ...parsed.data, externalId: `music-${randomUUID()}` });
      res.status(201).json({ item: serialize(row) });
    });
    app.patch(`/api/admin/music-archive/${kind}/:id`, requireAdmin, async (req, res) => {
      if (kind === 'songs' && await model.exists({externalId:req.params.id,workId:{$exists:true,$ne:''}})) return res.status(409).json({message:'Edit this recording through the ontology editor.'});
      // PATCH must preserve omitted fields; creation defaults must not detach songs.
      const patchInput = z.object(Object.fromEntries(Object.entries(inputs[kind].shape).map(([key, field]) => [key, (field instanceof z.ZodDefault ? field.removeDefault() : field).optional()]))).strict();
      const parsed = patchInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });
      const error = await validateParent(parsed.data);
      if (error) return res.status(400).json({ message: error });
      const row = await model.findOneAndUpdate({ externalId: req.params.id }, { $set: parsed.data }, { new: true, runValidators: true });
      if (!row) return res.status(404).json({ message: 'This item no longer exists.' });
      res.json({ item: serialize(row) });
    });
    app.delete(`/api/admin/music-archive/${kind}/:id`, requireAdmin, async (req, res) => {
      if (kind === 'songs' && await model.exists({externalId:req.params.id,workId:{$exists:true,$ne:''}})) return res.status(409).json({message:'Archive this recording through the ontology editor; its references and files are preserved.'});
      const row = kind === 'songs' && ontology ? await ontology.deleteLegacy(req.params.id) : await model.findOneAndDelete({ externalId: req.params.id });
      if (!row) return res.status(404).json({ message: 'This item no longer exists.' });
      // Keep stored media recoverable; deleting a record does not erase its files.
      res.json({ ok: true });
    });
    app.put(`/api/admin/music-archive/${kind}/order`, requireAdmin, async (req, res) => {
      const parsed = z.object({ ids: z.array(z.string().min(1).max(120)).max(5000) }).strict().safeParse(req.body);
      if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) return res.status(400).json({ message: 'Choose distinct items to reorder.' });
      const rows = await model.find({ externalId: { $in: parsed.data.ids } });
      if (rows.length !== parsed.data.ids.length) return res.status(409).json({ message: 'The archive changed. Refresh before reordering.' });
      if (rows.length) await model.bulkWrite(parsed.data.ids.map((id, sortOrder) => ({ updateOne: { filter: { externalId: id }, update: { $set: { sortOrder } } } })));
      res.json({ ok: true });
    });
  }
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 1 } });
  const parseFile = (req,res,next) => upload.single('file')(req,res,error => error ? res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({message:error.code === 'LIMIT_FILE_SIZE' ? 'Choose a file under 100 MB.' : 'Choose one file to upload.'}) : next());
  app.post('/api/admin/music-archive/upload', requireAdmin, parseFile, async (req, res) => {
    const file = req.file;
    if (file && !file.size) return res.status(400).json({message:'Choose a file that contains audio or an image.'});
    const audio = file && /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|mp4|x-m4a|aac|x-aac|flac|x-flac|webm)$/.test(file.mimetype);
    const image = file && /^image\/(?!svg)[a-z0-9.+-]+$/i.test(file.mimetype);
    if (!audio && !image) return res.status(400).json({ message: 'Choose an MP3, WAV, M4A, Ogg, AAC, FLAC, WebM audio file or an image (JPG, PNG, WebP, GIF, AVIF, HEIC, TIFF, BMP…). SVG is not accepted.' });
    if (image && file.size > 10 * 1024 * 1024) return res.status(400).json({ message: 'Cover images must be under 10 MB.' });
    if (requireCloudinary && !useCloudinary) return res.status(503).json({ message: 'Cloudinary storage is not configured. Contact the administrator; your file has not been saved.' });
    try {
      if (!useCloudinary) return res.status(201).json(await archiveFiles.saveLocalFile(file));
      const result = await new Promise((resolve, reject) => cloudinaryClient.uploader.upload_stream({ folder: 'khalil/music-archive', resource_type: audio ? 'video' : 'image', type: 'authenticated',
        ...(image ? { transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }] } : {}) }, (error, value) => error ? reject(error) : resolve(value)).end(file.buffer));
      res.status(201).json({ url: result.secure_url, previewUrl: deliveryUrl(result.secure_url), duration: result.duration ? `${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')}` : '' });
    } catch (error) { console.error('Music archive upload failed:', error); res.status(502).json({ message: 'The file could not be uploaded. Try again.' }); }
  });
  archiveFiles.registerArchiveFiles(app,{publicSongs:async()=>(await catalog(false,{includeOntology:false})).songs,Collection:CollectionModel});
}
module.exports = { registerMusicArchive, publicSongs, serialize, visibleSongs, deliveryUrl, inputs, Collection, ownedAsset, ontologyService: () => require('./music-ontology/service').createService({deliveryUrl,previewUrl:archiveFiles.previewUrl,ownedAsset}) };
