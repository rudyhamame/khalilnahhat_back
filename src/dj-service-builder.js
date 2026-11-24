const mongoose = require('mongoose');
const { z } = require('zod');
const journey = require('./booking-journey');
const { ArchiveItem, ServiceRequest, LiveStreamConfig } = require('./models');

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const djSegment = z.object({
  id: z.string().min(1).max(100), title: z.string().trim().min(1).max(120), startsAt: z.union([time, z.literal('')]),
  endsAt: z.union([time, z.literal('')]), recordingIds: z.array(z.string().min(1).max(120)).max(200).default([]), notes: z.string().trim().max(1000).default(''),
  manualTracks: z.array(z.object({ id:z.string().min(1).max(100), title:z.string().trim().min(1).max(200), artist:z.string().trim().max(200).default(''), notes:z.string().trim().max(500).default('') }).strict()).max(200).default([]),
  entries: z.array(z.object({ type:z.enum(['recording','manual']), id:z.string().min(1).max(120) }).strict()).max(400).optional(),
}).strict();
const djSetSchema = z.object({ segments: z.array(djSegment).max(100), notes: z.string().trim().max(3000).default('') }).strict();

// One saved set per live stream, so past and upcoming streams each keep their own prepared set list.
const LiveStreamPlan = mongoose.models.LiveStreamPlan || mongoose.model('LiveStreamPlan', new mongoose.Schema({ title: { type: String, required: true, trim: true, maxlength: 180 }, djSet: { type: Object, default: { segments: [], notes: '' } } }, { timestamps: true }));
const count = (djSet) => (djSet?.segments || []).reduce((n, row) => n + (row.entries?.length || (row.recordingIds?.length || 0) + (row.manualTracks?.length || 0)), 0);

function registerDjServiceBuilder(app, { requireAdmin, ArchiveModel = ArchiveItem, BookingModel = ServiceRequest, StreamModel = LiveStreamConfig, getLiveStreamConfig }) {
  const validateSet = async (req,res) => {
    const parsed=z.object({djSet:djSetSchema}).strict().safeParse(req.body);
    if(!parsed.success||JSON.stringify(req.body).length>250000){res.status(400).json({message:parsed.success?'The set plan is too large.':parsed.error.issues[0].message});return null;}
    const {djSet}=parsed.data,ids=djSet.segments.map(row=>row.id),recordingIds=[...new Set(djSet.segments.flatMap(row=>[...row.recordingIds,...(row.entries||[]).filter(item=>item.type==='recording').map(item=>item.id)]))];
    if(new Set(ids).size!==ids.length||djSet.segments.some(row=>new Set(row.recordingIds).size!==row.recordingIds.length||new Set(row.manualTracks.map(track=>track.id)).size!==row.manualTracks.length||(row.entries&&new Set(row.entries.map(item=>item.id)).size!==row.entries.length))) {res.status(400).json({message:'Moment and track placements must be unique.'});return null;}
    if(recordingIds.length){const active=[...await ArchiveModel.find({externalId:{$in:recordingIds},published:true,status:{$ne:'ARCHIVED'}}).select('externalId').lean(),...await require('./music-archive').recordingSongs(ArchiveModel,recordingIds)];if(active.length!==recordingIds.length)return res.status(400).json({message:'A selected recording is no longer available. Refresh recordings and try again.'});}
    return djSet;
  };
  app.get('/api/admin/dj-service-builder/livestream',requireAdmin,async(_req,res)=>{try{const stream=getLiveStreamConfig?await getLiveStreamConfig():await StreamModel.findOne({key:'primary'});res.set('Cache-Control','no-store').json({djSet:stream?.djSetPlan||{segments:[],notes:''}});}catch{res.status(503).json({message:'The livestream plan could not be loaded.'});}});
  app.put('/api/admin/dj-service-builder/livestream',requireAdmin,async(req,res)=>{try{const djSet=await validateSet(req,res);if(!djSet)return;const stream=getLiveStreamConfig?await getLiveStreamConfig():await StreamModel.findOne({key:'primary'});if(!stream)return res.status(404).json({message:'Livestream configuration not found.'});stream.djSetPlan=djSet;await stream.save();res.set('Cache-Control','no-store').json({djSet});}catch{res.status(503).json({message:'The livestream plan could not be saved.'});}});
  const planView = (row) => ({ id: String(row._id), title: row.title, createdAt: row.createdAt, trackCount: count(row.djSet) });
  app.get('/api/admin/dj-service-builder/live-plans',requireAdmin,async(_req,res)=>{try{const rows=await LiveStreamPlan.find().sort({createdAt:-1}).limit(200).lean();res.set('Cache-Control','no-store').json({items:rows.map(planView)});}catch{res.status(503).json({message:'Live streams could not be loaded.'});}});
  app.post('/api/admin/dj-service-builder/live-plans',requireAdmin,async(req,res)=>{const parsed=z.object({title:z.string().trim().min(1).max(180)}).strict().safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'Enter a live stream title.'});try{const row=await LiveStreamPlan.create({title:parsed.data.title});res.status(201).json({item:planView(row.toObject())});}catch{res.status(503).json({message:'The live stream could not be created.'});}});
  app.get('/api/admin/dj-service-builder/live-plans/:id',requireAdmin,async(req,res)=>{try{const row=mongoose.isValidObjectId(req.params.id)&&await LiveStreamPlan.findById(req.params.id).lean();if(!row)return res.status(404).json({message:'Live stream not found.'});res.set('Cache-Control','no-store').json({item:planView(row),djSet:row.djSet});}catch{res.status(503).json({message:'The live stream could not be loaded.'});}});
  app.put('/api/admin/dj-service-builder/live-plans/:id',requireAdmin,async(req,res)=>{try{if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({message:'Live stream not found.'});const djSet=await validateSet(req,res);if(!djSet)return;const row=await LiveStreamPlan.findByIdAndUpdate(req.params.id,{$set:{djSet}},{new:true}).lean();if(!row)return res.status(404).json({message:'Live stream not found.'});res.set('Cache-Control','no-store').json({item:planView(row),djSet:row.djSet});}catch{res.status(503).json({message:'The live stream set could not be saved. Your changes remain in the editor; please retry.'});}});
  app.put('/api/admin/dj-service-builder/:bookingId', requireAdmin, async (req, res) => {
    try {
      const djSet=await validateSet(req,res);if(!djSet)return;
      const item = await BookingModel.findOne({ externalId: req.params.bookingId, status: { $in: journey.statusesWhere('isBooked') } });
      if (!item) return res.status(409).json({ message: 'This confirmed booking could not be found. Refresh the booking list.' });
      item.planning = { ...(item.planning || {}), djSet, updatedAt: new Date() };
      await item.save();
      res.set('Cache-Control', 'no-store').json({ item: { id: item.externalId, planning: item.planning }, djSet: item.planning?.djSet });
    } catch { res.status(503).json({ message: 'The event set plan could not be saved. Your changes remain in the editor; please retry.' }); }
  });
}

module.exports = { registerDjServiceBuilder, LiveStreamPlan };
