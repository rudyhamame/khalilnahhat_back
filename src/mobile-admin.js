const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const { z } = require('zod');
const cloudinary = require('cloudinary').v2;
const { User, ServiceRequest, Booking, ArchiveItem, LiveSession, LiveRequest } = require('./models');
const { EventBooking } = require('./payments');
const { Meeting } = require('./meetings');
const { MediaItem, Testimonial } = require('./content');
const { Redemption } = require('./vouchers');
const { EventDraft } = require('./event-drafts');
const { Model: SimulationDraft } = require('./simulation-drafts');
const { Equipment } = require('./equipment');
const { hashPassword } = require('./security');
const { ADMIN_USERNAMES } = require('./default-data');

User.schema.add({ adminNotes: { type: String, default: '', maxlength: 6000 } });
const fileSchema = new mongoose.Schema({
  name: { type: String, required: true }, publicId: { type: String, required: true, unique: true },
  bytes: Number, mime: String, format: String, resourceType: { type: String, default: 'raw' },
  delivery: { type: String, default: 'authenticated' }, clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  requestId: { type: String, default: '' }, note: { type: String, default: '' }, archived: { type: Boolean, default: false },
}, { timestamps: true });
const StoredFile = mongoose.models.StoredFile || mongoose.model('StoredFile', fileSchema);
const clientFields = {
  firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254), phoneNumber: z.string().trim().max(60), adminNotes: z.string().trim().max(6000),
};
const clientUpdate = z.object(clientFields).partial().strict();
const clientCreate = z.object({ ...clientFields, username: z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{3,60}$/) }).partial({ phoneNumber: true, adminNotes: true }).strict();
const CLIENT_FIELDS = '_id username firstName lastName email phoneNumber emailVerified isAdmin isBlocked createdAt adminNotes';
function clientView(u) {
  return { id: String(u._id), username: u.username, firstName: u.firstName, lastName: u.lastName,
    name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, phoneNumber: u.phoneNumber || '',
    isAdmin: Boolean(u.isAdmin || ADMIN_USERNAMES.has(String(u.username||'').toLowerCase())), isBlocked: Boolean(u.isBlocked), emailVerified: Boolean(u.emailVerified), createdAt: u.createdAt, adminNotes: u.get?.('adminNotes') || u.adminNotes || '' };
}
const fileView = d => ({ id: String(d._id), name: d.name, bytes: d.bytes, mime: d.mime, clientId: d.clientId ? String(d.clientId) : '', requestId: d.requestId, note: d.note, archived: d.archived, createdAt: d.createdAt });
const validId = value => mongoose.isValidObjectId(value);
const fail = (res, status, message) => res.status(status).json({ message });
function signedFileUrl(file) {
  return cloudinary.utils.private_download_url(file.publicId, file.format || '', {
    resource_type: file.resourceType, type: file.delivery, expires_at: Math.floor(Date.now()/1000)+180, attachment: true,
  });
}
function registerMobileAdmin(app, { requireAdmin, requireAuth, serializeRequest }) {
  app.get('/api/admin/overview', requireAdmin, async (_req,res) => {
    const [clients,requests,pending,confirmed,media,archive,vault,queue,meetings,equipment] = await Promise.all([
      User.countDocuments({isAdmin:{$ne:true},username:{$nin:[...ADMIN_USERNAMES]}}),ServiceRequest.countDocuments(),
      ServiceRequest.countDocuments({status:{$in:['pending','changes_requested']}}),EventBooking.countDocuments(),MediaItem.countDocuments(),
      ArchiveItem.countDocuments(),StoredFile.countDocuments({archived:false}),LiveRequest.countDocuments({requestStatus:'pending'}),
      Meeting.countDocuments({status:'booked',start:{$gte:new Date()}}),Equipment.countDocuments(),
    ]);
    return res.json({ counts:{clients,requests,pending,confirmed,media,archive,vault,queue,meetings,equipment},
      integrations:{cloudinary:Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),livekit:Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET)} });
  });
  app.get('/api/admin/clients', requireAdmin, async (req,res) => {
    const q=String(req.query.q || '').trim().slice(0,100);
    const filter={$and:[{isAdmin:{$ne:true}},{username:{$nin:[...ADMIN_USERNAMES]}},...(q ? [{$or:['firstName','lastName','email','username'].map(key=>({[key]:{$regex:q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'}}))}] : [])]};
    const items=await User.find(filter).select(CLIENT_FIELDS).sort({createdAt:-1}).limit(500);
    res.json({items:items.map(clientView)});
  });
  app.patch('/api/admin/clients/:id/block', requireAdmin, async (req,res) => {
    const parsed=z.object({blocked:z.boolean()}).strict().safeParse(req.body);
    if(!validId(req.params.id)||!parsed.success) return fail(res,400,'Invalid client block request.');
    const client=await User.findOne({_id:req.params.id,isAdmin:{$ne:true},username:{$nin:[...ADMIN_USERNAMES]}});
    if(!client) return fail(res,404,'Client not found.');
    client.isBlocked=parsed.data.blocked;
    if(client.isBlocked) client.sessionToken='';
    await client.save();
    res.json({item:clientView(client)});
  });
  app.delete('/api/admin/clients/:id', requireAdmin, async (req,res) => {
    if(!validId(req.params.id)) return fail(res,400,'Invalid client.');
    try {
      const removed=await mongoose.connection.transaction(async session=>{
        const client=await User.findOne({_id:req.params.id,isAdmin:{$ne:true},username:{$nin:[...ADMIN_USERNAMES]}}).session(session).lean();
        if(!client) throw Object.assign(new Error('Client not found.'),{status:404});
        const objectId=client._id, owner=String(client._id), email=String(client.email||'').toLowerCase();
        const serviceRequestFilter={$or:[{userId:objectId},...(email?[{customerEmail:email}]:[])]};
        const requests=await ServiceRequest.find(serviceRequestFilter).select('externalId').session(session).lean();
        const requestIds=requests.map(row=>row.externalId);
        const counts={};
        const remove=async(name,query)=>{const result=await mongoose.connection.collection(name).deleteMany(query,{session});counts[name]=(counts[name]||0)+result.deletedCount;};
        await remove(ServiceRequest.collection.collectionName,serviceRequestFilter);
        await remove(EventBooking.collection.collectionName,{$or:[{userId:objectId},...(requestIds.length?[{requestId:{$in:requestIds}}]:[])]});
        await remove(StoredFile.collection.collectionName,{$or:[{clientId:objectId},...(requestIds.length?[{requestId:{$in:requestIds}}]:[])]});
        await remove(Redemption.collection.collectionName,{userId:objectId});
        await remove(EventDraft.collection.collectionName,{_id:owner});
        await remove(SimulationDraft.collection.collectionName,{_id:owner});
        const now=new Date();
        const meetingOwner={$or:[{bookedBy:objectId},...(email?[{bookedByEmail:email}]:[])]};
        const meetings=await Meeting.collection.updateMany({...meetingOwner,start:{$gt:now}},{$set:{status:'open',bookedBy:null,bookedByName:'',bookedByEmail:'',topic:'',reminderSentAt:null}},{session});
        const pastMeetings=await Meeting.collection.updateMany({...meetingOwner,start:{$lte:now}},{$set:{bookedBy:null,bookedByName:'',bookedByEmail:'',topic:'',reminderSentAt:null}},{session});
        counts[Meeting.collection.collectionName]=(counts[Meeting.collection.collectionName]||0)+meetings.modifiedCount+pastMeetings.modifiedCount;
        if(email){
          await remove(Booking.collection.collectionName,{email});
          await remove(LiveRequest.collection.collectionName,{requesterEmail:email});
        }
        const skip=new Set([User.collection.collectionName,ServiceRequest.collection.collectionName,EventBooking.collection.collectionName,StoredFile.collection.collectionName,Redemption.collection.collectionName,EventDraft.collection.collectionName,SimulationDraft.collection.collectionName,Meeting.collection.collectionName,Booking.collection.collectionName,LiveRequest.collection.collectionName]);
        const ownerFilter={$or:[{owner},{owner:objectId},{userId:objectId},{clientId:objectId}]};
        for(const [name,collection] of Object.entries(mongoose.connection.collections)){
          if(skip.has(collection.collectionName)) continue;
          const result=await collection.deleteMany(ownerFilter,{session});
          if(result.deletedCount) counts[collection.collectionName]=(counts[collection.collectionName]||0)+result.deletedCount;
        }
        await User.collection.deleteOne({_id:objectId},{session});
        return {counts};
      });
      res.json({deleted:true,removed:removed.counts});
    } catch(error) {
      if(error.status) return fail(res,error.status,error.message);
      console.error('Client deletion failed:',error.name);
      return fail(res,503,'Could not fully delete the client and their database records. No changes were committed.');
    }
  });
  app.post('/api/admin/clients', requireAdmin, async (req,res) => {
    const parsed=clientCreate.safeParse(req.body);
    if(!parsed.success) return fail(res,400,'Enter a name, valid email and a username with at least three characters.');
    if(ADMIN_USERNAMES.has(parsed.data.username)) return fail(res,409,'That administrator username is reserved.');
    try {
      const u=await User.create({...parsed.data,phoneNumber:parsed.data.phoneNumber || 'Not provided',passwordHash:hashPassword(crypto.randomBytes(40).toString('hex')),isAdmin:false,emailVerified:false});
      res.status(201).json({item:clientView(u),message:'Client created. They can set their own password through Forgot password.'});
    } catch(e) { if(e.code===11000) return fail(res,409,'That username is already in use.'); throw e; }
  });
  app.patch('/api/admin/clients/:id', requireAdmin, async (req,res) => {
    const parsed=clientUpdate.safeParse(req.body);
    if(!validId(req.params.id)||!parsed.success) return fail(res,400,'Client details failed validation.');
    if(parsed.data.phoneNumber==='') parsed.data.phoneNumber='Not provided';
    const current=await User.findById(req.params.id).select(CLIENT_FIELDS);
    if(!current) return fail(res,404,'Client not found.');
    if(parsed.data.email && parsed.data.email!==current.email) parsed.data.emailVerified=false;
    const u=await User.findByIdAndUpdate(req.params.id,{$set:parsed.data},{new:true,runValidators:true}).select(CLIENT_FIELDS);
    res.json({item:clientView(u)});
  });
  app.get('/api/admin/clients/:id/requests', requireAdmin, async (req,res) => {
    if(!validId(req.params.id)) return fail(res,400,'Invalid client.');
    res.json({items:(await ServiceRequest.find({userId:req.params.id}).sort({createdAt:-1}).limit(500)).map(x=>serializeRequest(x,true))});
  });
  app.get('/api/admin/enquiries', requireAdmin, async (_req,res) => {
    const rows=await Booking.find().sort({createdAt:-1}).limit(500).lean();
    res.json({items:rows.map(row=>{const { _id,__v,...data }=row;return {id:String(_id),...data};})});
  });
  app.patch('/api/admin/service-requests/:id/note', requireAdmin, async (req,res) => {
    const parsed=z.object({adminNote:z.string().trim().max(6000)}).strict().safeParse(req.body);
    if(!parsed.success) return fail(res,400,'Invalid note.');
    const item=await ServiceRequest.findOneAndUpdate({externalId:req.params.id},{$set:parsed.data},{new:true});
    return item ? res.json({item:serializeRequest(item,true)}) : fail(res,404,'Request not found.');
  });
  app.put('/api/admin/service-requests/:id/planning', requireAdmin, async (req,res) => {
    const fields=['brideName','groomName','timeline','partyEntrances','entranceSongs','firstDance','parentDances','dinnerMusic','cakeCutting','announcements','mustPlay','doNotPlay','musicLinks','specialRequests'];
    const parsed=z.object(Object.fromEntries(fields.map(key=>[key,z.string().trim().max(3000).default('')]))).strict().safeParse(req.body);
    if(!parsed.success) return fail(res,400,'Invalid planning details.');
    const item=await ServiceRequest.findOneAndUpdate({externalId:req.params.id,status:'confirmed'},{$set:{planning:{...parsed.data,updatedAt:new Date()}}},{new:true});
    return item ? res.json({item:serializeRequest(item,true)}) : fail(res,409,'Planning requires a confirmed booking.');
  });
  app.get('/api/admin/archive', requireAdmin, async (_req,res) => {
    const rows=await ArchiveItem.find().sort({createdAt:-1}).limit(500).lean();
    res.json({items:rows.map(x=>{const {_id,__v,...rest}=x;return {...rest,id:x.externalId||String(_id),playerEligible:require('./archive-player').isCloudinaryAudio(x.audioUrl)};})});
  });
  app.get('/api/admin/sessions', requireAdmin, async (_req,res) => {
    const rows=await LiveSession.find().sort({sortOrder:1}).limit(500).lean();
    res.json({items:rows.map(x=>{const {_id,__v,...rest}=x;return {...rest,id:x.externalId||String(_id),playerEligible:require('./archive-player').isCloudinaryAudio(x.audioUrl)};})});
  });
  app.get('/api/admin/storage', requireAdmin, async (req,res) => {
    const filter={archived:req.query.archived==='true'};
    if(req.query.clientId) {if(!validId(req.query.clientId)) return fail(res,400,'Invalid client.');filter.clientId=req.query.clientId;}
    res.json({items:(await StoredFile.find(filter).sort({createdAt:-1}).limit(500)).map(fileView)});
  });
  app.patch('/api/admin/storage/:id', requireAdmin, async (req,res) => {
    const p=z.object({name:z.string().trim().min(1).max(240).optional(),note:z.string().trim().max(3000).optional(),archived:z.boolean().optional()}).strict().safeParse(req.body);
    if(!validId(req.params.id)||!p.success) return fail(res,400,'Invalid file details.');
    const file=await StoredFile.findByIdAndUpdate(req.params.id,{$set:p.data},{new:true});
    return file ? res.json({item:fileView(file)}) : fail(res,404,'File not found.');
  });
  app.get('/api/admin/storage/:id/download', requireAdmin, async (req,res) => {
    if(!validId(req.params.id)) return fail(res,400,'Invalid file.');
    const file=await StoredFile.findById(req.params.id);
    return file ? res.json({url:signedFileUrl(file),expiresIn:180}) : fail(res,404,'File not found.');
  });
  // Clients may only discover and download files explicitly assigned to their account.
  app.get('/api/documents/mine', requireAuth, async (req,res) => res.json({items:(await StoredFile.find({clientId:req.authUser._id,archived:false}).sort({createdAt:-1}).limit(500)).map(fileView)}));
  app.get('/api/documents/:id/download', requireAuth, async (req,res) => {
    if(!validId(req.params.id)) return fail(res,404,'File not found.');
    const file=await StoredFile.findOne({_id:req.params.id,clientId:req.authUser._id,archived:false});
    return file ? res.json({url:signedFileUrl(file),expiresIn:180}) : fail(res,404,'File not found.');
  });
  const directory='/var/tmp/echo-admin-uploads';
  const disk=multer.diskStorage({destination:(_req,_file,cb)=>require('fs').mkdir(directory,{recursive:true,mode:0o700},err=>cb(err,directory)),filename:(_req,_file,cb)=>cb(null,crypto.randomUUID())});
  const upload=multer({storage:disk,limits:{fileSize:50*1024*1024,files:1,fields:5}});
  let active=0;
  const limit=(req,res,next)=>{if(active>=2)return fail(res,429,'Two uploads are already running. Try again shortly.');active++;res.once('close',()=>active--);next();};
  app.post('/api/admin/storage/upload', requireAdmin, limit, upload.single('file'), async (req,res) => {
    let uploaded;
    try {
      if(!req.file) return fail(res,400,'Choose a file to upload.');
      const metadata=z.object({clientId:z.string().max(40).default(''),requestId:z.string().max(120).default(''),note:z.string().max(3000).default('')}).strict().safeParse(req.body);
      if(!metadata.success) return fail(res,400,'Invalid file association.');
      const {clientId,requestId,note}=metadata.data;
      await fs.chmod(req.file.path,0o600);
      if(note.length>3000 || requestId.length>120) return fail(res,400,'File details are too long.');
      if(clientId && (!validId(clientId)||!await User.exists({_id:clientId}))) return fail(res,400,'Client not found.');
      if(requestId && (!clientId || !await ServiceRequest.exists({externalId:requestId,userId:clientId}))) return fail(res,400,'That request does not belong to the selected client.');
      const ext=path.extname(req.file.originalname).replace(/[^a-zA-Z0-9.]/g,'').slice(0,12);
      uploaded=await cloudinary.uploader.upload(req.file.path,{folder:'khalil/private',resource_type:'raw',type:'authenticated',public_id:crypto.randomUUID()+ext,overwrite:false});
      const file=await StoredFile.create({name:path.basename(req.file.originalname).slice(0,240),publicId:uploaded.public_id,resourceType:'raw',delivery:'authenticated',format:'',bytes:uploaded.bytes,mime:req.file.mimetype,clientId:clientId||null,requestId,note});
      res.status(201).json({item:fileView(file)});
    } catch(error) {
      if(uploaded) await cloudinary.uploader.destroy(uploaded.public_id,{resource_type:'raw',type:'authenticated'}).catch(()=>{});
      console.error('Private upload failed:',error.http_code||error.name);
      return fail(res,502,'Storage upload failed. Check Cloudinary settings and file limits.');
    } finally {if(req.file?.path) await fs.unlink(req.file.path).catch(()=>{});}
  });
}
module.exports={registerMobileAdmin,StoredFile,clientUpdate,clientCreate,clientView,fileView,signedFileUrl};
