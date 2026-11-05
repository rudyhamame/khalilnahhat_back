const mongoose = require('mongoose');
const {randomUUID} = require('node:crypto');
const {z} = require('zod');

const EQUIPMENT_ALBUM_ID = 'equipment-artwork';
const schema = new mongoose.Schema({
  _id: {type: String, default: () => randomUUID()},
  name: {type: String, required: true, trim: true},
  nameAr: {type: String, default: '', trim: true},
  description: {type: String, default: '', trim: true},
  itemIds: {type: [String], default: []},
  deletedAt: {type: Date, default: null},
}, {timestamps: true});
const GalleryAlbum = mongoose.models.GalleryAlbum || mongoose.model('GalleryAlbum', schema);
const fields = {
  name: z.string().trim().min(1).max(100), nameAr: z.string().trim().max(100),
  description: z.string().trim().max(1000),
};
const create = z.object(fields).partial().required({name: true}).strict();
const edit = z.object(fields).partial().strict();
const members = z.object({itemIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(500)}).strict();
const isEquipmentArtwork = item => item.kind === 'photo' &&
  (item.category === 'equipment' || / — 3D artwork$/.test(item.title || ''));

function registerGalleryAlbums(app, requireAdmin, {MediaItem, ContentSeed}) {
  let migration;
  const prepare = () => {
    if (!migration) migration = (async () => {
      if (await ContentSeed.exists({key: 'equipment-gallery-album-v1'})) return;
      const {Equipment} = require('./equipment');
      const urls = (await Equipment.distinct('imageUrl')).filter(Boolean);
      const photos = await MediaItem.find({kind: 'photo', $or: [
        {category: 'equipment'}, {title: / — 3D artwork$/}, {mediaUrl: {$in: urls}},
      ]}).select('_id').lean();
      await GalleryAlbum.updateOne({_id: EQUIPMENT_ALBUM_ID}, {
        $setOnInsert: {name: 'Equipment', nameAr: 'المعدات', description: 'Equipment artwork and product images.'},
        $addToSet: {itemIds: {$each: photos.map(row => String(row._id))}},
      }, {upsert: true});
      try { await ContentSeed.create({key: 'equipment-gallery-album-v1'}); }
      catch (error) { if (error.code !== 11000) throw error; }
    })().catch(error => { migration = null; throw error; });
    return migration;
  };
  const list = async (admin) => {
    await prepare();
    const albums = await GalleryAlbum.find({deletedAt: null}).sort({createdAt: 1, _id: 1}).lean();
    const ids = [...new Set(albums.flatMap(album => album.itemIds))];
    const media = await MediaItem.find({_id: {$in: ids}, kind: {$in: ['photo', 'video']},
      ...(!admin ? {isPublished: true} : {})}).select('_id kind mediaUrl coverUrl').lean();
    const byId = new Map(media.map(item => [String(item._id), item]));
    return albums.map(album => {
      const itemIds = album.itemIds.filter(id => byId.has(id));
      const cover = itemIds.map(id => byId.get(id)).find(item => item.coverUrl || item.kind === 'photo');
      return {id: album._id, name: album.name, nameAr: album.nameAr || '', description: album.description || '',
        itemIds, count: itemIds.length, coverUrl: cover?.coverUrl || cover?.mediaUrl || ''};
    });
  };
  const view = album => ({id: album.id, name: album.name, nameAr: album.nameAr || '',
    description: album.description || '', itemIds: album.itemIds.map(String)});
  const base = '/api/content/gallery/albums';
  app.get(base + '/admin', requireAdmin, async (_req,res) => res.json({items: await list(true)}));
  app.get(base, async (_req,res) => res.json({items: await list(false)}));
  app.post(base, requireAdmin, async (req,res) => {
    await prepare();
    const parsed = create.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({message: 'Enter an album name (up to 100 characters) and a description up to 1,000 characters.'});
    res.status(201).json({item: view(await GalleryAlbum.create(parsed.data))});
  });
  app.patch(base + '/:id', requireAdmin, async (req,res) => {
    const parsed = edit.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({message: 'Album details failed validation.'});
    const album = await GalleryAlbum.findOneAndUpdate({_id: req.params.id, deletedAt: null}, {$set: parsed.data}, {new: true, runValidators: true});
    return album ? res.json({item: view(album)}) : res.status(404).json({message: 'Album not found.'});
  });
  app.delete(base + '/:id', requireAdmin, async (req,res) => {
    const album = await GalleryAlbum.findOneAndUpdate({_id: req.params.id, deletedAt: null}, {$set: {deletedAt: new Date(), itemIds: []}});
    return album ? res.json({ok: true, assetsPreserved: true}) : res.status(404).json({message: 'Album not found.'});
  });
  app.post(base + '/:id/items', requireAdmin, async (req,res) => {
    const parsed = members.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({message: 'Choose between 1 and 500 Gallery images or videos.'});
    const ids = [...new Set(parsed.data.itemIds.map(id => id.toLowerCase()))];
    const count = await MediaItem.countDocuments({_id: {$in: ids}, kind: {$in: ['photo', 'video']}});
    if (count !== ids.length) return res.status(400).json({message: 'Some selected Gallery assets no longer exist.'});
    const album = await GalleryAlbum.findOneAndUpdate({_id: req.params.id, deletedAt: null}, {$addToSet: {itemIds: {$each: ids}}}, {new: true});
    return album ? res.json({item: view(album)}) : res.status(404).json({message: 'Album not found. The assets are still in Gallery.'});
  });
  app.delete(base + '/:id/items/:itemId', requireAdmin, async (req,res) => {
    const album = await GalleryAlbum.findOneAndUpdate({_id: req.params.id, deletedAt: null}, {$pull: {itemIds: req.params.itemId.toLowerCase()}}, {new: true});
    return album ? res.json({item: view(album)}) : res.status(404).json({message: 'Album not found.'});
  });
  const autoAssign = async item => {
    if (!isEquipmentArtwork(item)) return;
    await prepare();
    // Do not restore deleted albums. A user-created replacement named
    // Equipment can receive future artwork as well.
    const album = await GalleryAlbum.findOneAndUpdate({_id: EQUIPMENT_ALBUM_ID, deletedAt: null}, {$addToSet: {itemIds: String(item._id)}});
    if (!album) await GalleryAlbum.findOneAndUpdate({name: 'Equipment', deletedAt: null}, {$addToSet: {itemIds: String(item._id)}});
  };
  return {autoAssign};
}

module.exports = {GalleryAlbum, registerGalleryAlbums, EQUIPMENT_ALBUM_ID};
