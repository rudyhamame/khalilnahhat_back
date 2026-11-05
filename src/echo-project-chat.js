const mongoose = require('mongoose');
const { z } = require('zod');
const {User}=require('./models');
const {isAdminUser}=require('./admin-role');

const Message = mongoose.models.EchoProjectChatMessage || mongoose.model('EchoProjectChatMessage', new mongoose.Schema({
  senderId: { type: String, required: true },
  senderName: { type: String, required: true },
  content: { type: String, default: '', required: function () { return !this.attachment?.data; }, maxlength: 2000 },
  editedAt: {type:Date,default:null},
  attachment: { type: { type: String, enum: ['image', 'audio'] }, name: String, mimeType: String, data: String },
}, { timestamps: true }));
Message.schema.index({createdAt:-1,_id:-1});

const ReadState=mongoose.models.EchoProjectChatReadState||mongoose.model('EchoProjectChatReadState',new mongoose.Schema({
  _id:String,readAt:{type:Date,default:()=>new Date(0)},readId:{type:mongoose.Schema.Types.ObjectId,default:()=>new mongoose.Types.ObjectId('000000000000000000000000')},
}));
const presenceSchema=new mongoose.Schema({_id:String,userId:{type:String,required:true},lastSeenAt:{type:Date,required:true}});
presenceSchema.index({lastSeenAt:1},{expireAfterSeconds:90});
const Presence=mongoose.models.EchoProjectChatPresence||mongoose.model('EchoProjectChatPresence',presenceSchema);
const ONLINE_WINDOW_MS=45000;
const afterCursor=read=>read?{$or:[{createdAt:{$gt:read.readAt}},{createdAt:read.readAt,_id:{$gt:read.readId}}]}:{};
const Receipt=mongoose.models.EchoProjectChatReceipt||mongoose.model('EchoProjectChatReceipt',new mongoose.Schema({
  _id:String,messageId:{type:String,required:true,index:true},userId:{type:String,required:true},deliveredAt:{type:Date,required:true},seenAt:Date,
}));
function deliveryTimes(item,receipts=[]){
  const others=receipts.filter(receipt=>receipt.userId!==item.senderId);
  const first=key=>{const dates=others.map(receipt=>receipt[key]).filter(Boolean).map(value=>new Date(value)).filter(value=>Number.isFinite(value.getTime()));return dates.length?new Date(Math.min(...dates.map(value=>value.getTime()))):null;};
  return {sentAt:item.createdAt,deliveredAt:first('deliveredAt'),seenAt:first('seenAt')};
}

function registerEchoProjectChat(app, { requireAdmin }) {
  const actor = req => req.user || req.authUser;
  const userId = req => String(actor(req)?._id || actor(req)?.id || '');
  const status=async req=>{
    const id=userId(req);
    const [read,present]=await Promise.all([ReadState.findById(id).lean(),Presence.find({lastSeenAt:{$gt:new Date(Date.now()-ONLINE_WINDOW_MS)}}).lean()]);
    const ids=[...new Set(present.map(item=>item.userId))];
    const [unreadCount,users,envelopes]=await Promise.all([Message.countDocuments({senderId:{$ne:id},...afterCursor(read)}),ids.length?User.find({_id:{$in:ids},isBlocked:{$ne:true}}).select('_id username firstName lastName email isAdmin adminGrantedAt adminGrantedBy').lean():[],Message.find({senderId:{$ne:id}}).select('_id senderId').sort({createdAt:-1,_id:-1}).limit(200).lean()]);
    return {unreadCount,deliveryItems:envelopes.map(item=>({id:String(item._id),senderId:item.senderId})),onlineAdmins:users.filter(isAdminUser).map(user=>({id:String(user._id),name:[user.firstName,user.lastName].filter(Boolean).join(' ')||user.username||user.email||'Admin'})).sort((a,b)=>a.name.localeCompare(b.name))};
  };
  app.get('/api/echo-project-chat/status',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    try{res.set('Cache-Control','no-store').json(await status(req));}catch{res.status(503).json({message:'Chat notifications are temporarily unavailable.'});}
  });
  app.post('/api/echo-project-chat/presence',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    const parsed=z.object({clientId:z.string().uuid(),online:z.boolean()}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({message:'Invalid chat presence request.'});
    try{
      const id=userId(req),key=id+':'+parsed.data.clientId;
      if(!parsed.data.online){await Presence.deleteOne({_id:key,userId:id});return res.json({online:false});}
      await Presence.updateOne({_id:key},{$set:{userId:id,lastSeenAt:new Date()}},{upsert:true});
      res.set('Cache-Control','no-store').json(await status(req));
    }catch{res.status(503).json({message:'Online status is temporarily unavailable.'});}
  });
  app.post('/api/echo-project-chat/read',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    const parsed=z.object({messageId:z.string().regex(/^[a-f\d]{24}$/i)}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({message:'Invalid read receipt.'});
    try{
      const message=await Message.findById(parsed.data.messageId).select('_id createdAt').lean();
      if(!message)return res.status(404).json({message:'Message not found.'});
      const id=userId(req);
      await ReadState.updateOne({_id:id},{$setOnInsert:{readAt:new Date(0),readId:new mongoose.Types.ObjectId('000000000000000000000000')}},{upsert:true});
      // A slow receipt from another tab must never move the read position back.
      await ReadState.updateOne({_id:id,$or:[{readAt:{$lt:message.createdAt}},{readAt:message.createdAt,readId:{$lt:message._id}}]},{$set:{readAt:message.createdAt,readId:message._id}});
      res.set('Cache-Control','no-store').json(await status(req));
    }catch{res.status(503).json({message:'Messages could not be marked as read.'});}
  });
  app.post('/api/echo-project-chat/receipts',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    const parsed=z.object({messageIds:z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(200),seen:z.boolean()}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({message:'Invalid message receipt.'});
    try{
      const id=userId(req),now=new Date();
      const messages=await Message.find({_id:{$in:[...new Set(parsed.data.messageIds)]},senderId:{$ne:id}}).select('_id').lean();
      if(messages.length)await Receipt.bulkWrite(messages.map(message=>({updateOne:{filter:{_id:String(message._id)+':'+id},update:{$setOnInsert:{messageId:String(message._id),userId:id,deliveredAt:now},...(parsed.data.seen?{$min:{seenAt:now}}:{})},upsert:true}})));
      res.json({acknowledged:true});
    }catch{res.status(503).json({message:'Message receipt could not be saved.'});}
  });
  const serialize = (item,receipts=[]) => ({ id: String(item._id), senderId: item.senderId, senderName: item.senderName, content: item.content, attachment: item.attachment?.data ? item.attachment : undefined, createdAt: item.createdAt,editedAt:item.editedAt||null,...deliveryTimes(item,receipts) });
  app.get('/api/echo-project-chat', requireAdmin, async (req, res) => {
    if (!userId(req)) return res.status(401).json({ message: 'Sign in to use project chat.' });
    try {
      const items = await Message.find().sort({ createdAt: -1, _id: -1 }).limit(200).lean();
      const receipts=items.length?await Receipt.find({messageId:{$in:items.map(item=>String(item._id))}}).lean():[];
      const byMessage=new Map();for(const receipt of receipts){const rows=byMessage.get(receipt.messageId)||[];rows.push(receipt);byMessage.set(receipt.messageId,rows);}
      res.set('Cache-Control', 'no-store').json({ items: items.reverse().map(item=>serialize(item,byMessage.get(String(item._id)))) });
    } catch { res.status(503).json({ message: 'Project chat is temporarily unavailable.' }); }
  });
  app.post('/api/echo-project-chat', requireAdmin, async (req, res) => {
    if (!userId(req)) return res.status(401).json({ message: 'Sign in to use project chat.' });
    const attachment = z.object({ type: z.enum(['image', 'audio']), name: z.string().max(160), mimeType: z.string().max(100), data: z.string().max(7_500_000) }).optional();
    const parsed = z.object({ content: z.string().trim().max(2000).default(''), attachment }).refine(value => value.content || value.attachment).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Add a message or a supported image or voice note.' });
    if (parsed.data.attachment) {
      const { type, mimeType, data } = parsed.data.attachment;
      const validMime = type === 'image' ? /^image\/(png|jpeg|webp|gif)$/.test(mimeType) : /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav)$/.test(mimeType);
      if (!validMime || !data.startsWith(`data:${mimeType};base64,`) || data.length > (type === 'image' ? 5_500_000 : 7_500_000)) return res.status(400).json({ message: 'Attachment type or size is not supported.' });
    }
    try {
      const user = actor(req);
      const item = await Message.create({ senderId: userId(req), senderName: String(user.name || user.firstName || user.email || 'Echo user').slice(0, 120), content: parsed.data.content, attachment: parsed.data.attachment });
      res.status(201).json({ item: serialize(item.toObject()) });
    } catch { res.status(503).json({ message: 'Message could not be sent. Please try again.' }); }
  });
  app.delete('/api/echo-project-chat/:id',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    if(!/^[a-f\d]{24}$/i.test(req.params.id))return res.status(400).json({message:'Invalid message.'});
    try{
      const removed=await Message.findOneAndDelete({_id:req.params.id,senderId:userId(req)});
      if(!removed)return res.status(404).json({message:'Your message was not found.'});
      await Receipt.deleteMany({messageId:String(removed._id)}).catch(()=>{});
      res.json({deleted:true,id:String(removed._id)});
    }catch{res.status(503).json({message:'Message could not be deleted. Please try again.'});}
  });
  app.patch('/api/echo-project-chat/:id',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    const parsed=z.object({content:z.string().trim().min(1).max(2000),expectedContent:z.string().max(2000)}).strict().safeParse(req.body);
    if(!/^[a-f\d]{24}$/i.test(req.params.id)||!parsed.success)return res.status(400).json({message:'Enter a text message of 1–2000 characters.'});
    try{
      const item=await Message.findOneAndUpdate({_id:req.params.id,senderId:userId(req),content:parsed.data.expectedContent,'attachment.data':{$exists:false}},{$set:{content:parsed.data.content,editedAt:new Date()}},{new:true,runValidators:true});
      if(!item)return res.status(409).json({message:'Your text message changed or is no longer available. Reload it before editing.'});
      const receipts=await Receipt.find({messageId:String(item._id)}).lean();
      res.json({item:serialize(item.toObject(),receipts)});
    }catch{res.status(503).json({message:'Message could not be edited. Please try again.'});}
  });
}

module.exports = { registerEchoProjectChat, Message, ReadState, Presence, Receipt, ONLINE_WINDOW_MS, afterCursor, deliveryTimes };
