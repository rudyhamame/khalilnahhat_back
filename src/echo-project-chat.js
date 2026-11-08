const mongoose = require('mongoose');
const { z } = require('zod');
const {User}=require('./models');
const {isAdminUser}=require('./admin-role');
const {ADMIN_USERNAMES}=require('./default-data');
const Topic=mongoose.models.EchoProjectChatTopic||mongoose.model('EchoProjectChatTopic',new mongoose.Schema({title:{type:String,required:true,maxlength:80},titleKey:{type:String,required:true,unique:true},createdBy:{type:String,required:true}},{timestamps:true}));
const topicIdSchema=z.string().regex(/^(general|[a-f\d]{24})$/i).transform(value=>value.toLowerCase()).default('general');
const topicFilter=topicId=>topicId==='general'?{$or:[{topicId:'general'},{topicId:{$exists:false}},{topicId:null}]}:{topicId};
const topicOf=message=>message.topicId||'general';
const cursorKey=(id,topicId)=>topicId==='general'?id:id+':'+topicId;
const serializeTopic=item=>({id:String(item._id),title:item.title,createdAt:item.createdAt});
const listTopics=async()=>[{id:'general',title:'General'},...(await Topic.find().sort({createdAt:1,_id:1}).lean()).map(serializeTopic)];

const Message = mongoose.models.EchoProjectChatMessage || mongoose.model('EchoProjectChatMessage', new mongoose.Schema({
  senderId: { type: String, required: true },
  senderName: { type: String, required: true },
  topicId: {type:String,default:'general'},
  content: { type: String, default: '', required: function () { return !this.attachment?.data; }, maxlength: 2000 },
  editedAt: {type:Date,default:null},
  attachment: { type: { type: String, enum: ['image', 'audio'] }, name: String, mimeType: String, data: String },
}, { timestamps: true }));
Message.schema.index({createdAt:-1,_id:-1});
Message.schema.index({topicId:1,createdAt:-1,_id:-1});

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

function registerEchoProjectChat(app, { requireAdmin,authenticate,allowedOrigins }) {
  const realtime=require('./project-chat-socket').createProjectChatSocket({authenticate,allowedOrigins,
    onHeartbeat:(user,connectionId)=>Presence.updateOne({_id:'socket:'+connectionId},{$set:{userId:String(user._id||user.id),lastSeenAt:new Date()}},{upsert:true}),
    onOffline:(_user,connectionId)=>Presence.deleteOne({_id:'socket:'+connectionId}),
  });
  const actor = req => req.user || req.authUser;
  const userId = req => String(actor(req)?._id || actor(req)?.id || '');
  const validTopic=async topicId=>topicId==='general'||Boolean(await Topic.exists({_id:topicId}));
  const status=async req=>{
    const id=userId(req);
    const [topics,present]=await Promise.all([listTopics(),Presence.find({lastSeenAt:{$gt:new Date(Date.now()-ONLINE_WINDOW_MS)}}).lean()]);
    const reads=await ReadState.find({_id:{$in:topics.map(topic=>cursorKey(id,topic.id))}}).lean();
    const byTopic=new Map(reads.map(read=>[read._id,read]));
    const counts=await Message.aggregate([{$match:{senderId:{$ne:id},$or:topics.map(topic=>({$and:[topicFilter(topic.id),afterCursor(byTopic.get(cursorKey(id,topic.id)))]}))}},{$group:{_id:{$ifNull:['$topicId','general']},count:{$sum:1}}}]);
    const topicUnreadCounts=Object.fromEntries(topics.map(topic=>[topic.id,0]));
    for(const row of counts)if(Object.hasOwn(topicUnreadCounts,row._id))topicUnreadCounts[row._id]=row.count;
    const ids=[...new Set(present.map(item=>item.userId))];
    const [users,envelopes]=await Promise.all([User.find({isBlocked:{$ne:true},$or:[{username:{$in:[...ADMIN_USERNAMES]}},{isAdmin:true,adminGrantedAt:{$ne:null},adminGrantedBy:{$ne:null}}]}).select('_id username firstName lastName email isAdmin adminGrantedAt adminGrantedBy lastLoginAt').lean(),Message.find({senderId:{$ne:id}}).select('_id senderId').sort({createdAt:-1,_id:-1}).limit(200).lean()]);
    const admins=users.filter(isAdminUser).map(user=>({id:String(user._id),name:[user.firstName,user.lastName].filter(Boolean).join(' ')||user.username||user.email||'Admin',lastLoginAt:user.lastLoginAt||null,online:ids.includes(String(user._id))})).sort((a,b)=>a.name.localeCompare(b.name));
    return {unreadCount:Object.values(topicUnreadCounts).reduce((sum,count)=>sum+count,0),topicUnreadCounts,deliveryItems:envelopes.map(item=>({id:String(item._id),senderId:item.senderId})),admins,onlineAdmins:admins.filter(user=>user.online)};
  };
  app.get('/api/echo-project-chat/topics',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    try{res.set('Cache-Control','no-store').json({items:await listTopics()});}catch{res.status(503).json({message:'Discussion topics are temporarily unavailable.'});}
  });
  app.post('/api/echo-project-chat/topics',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    const parsed=z.object({title:z.string().trim().min(1).max(80)}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({message:'Enter a discussion topic of 1–80 characters.'});
    const title=parsed.data.title.replace(/\s+/g,' '),titleKey=title.normalize('NFKC').toLowerCase();
    if(titleKey==='general')return res.status(409).json({message:'A topic with this name already exists.'});
    try{const item=await Topic.create({title,titleKey,createdBy:userId(req)});realtime.publish('topics');res.status(201).json({item:serializeTopic(item)});}catch(error){res.status(error.code===11000?409:503).json({message:error.code===11000?'A topic with this name already exists.':'Discussion topic could not be created.'});}
  });
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
    const parsed=z.object({messageId:z.string().regex(/^[a-f\d]{24}$/i),topicId:topicIdSchema}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({message:'Invalid read receipt.'});
    try{
      const message=await Message.findById(parsed.data.messageId).select('_id createdAt topicId').lean();
      if(!message||topicOf(message)!==parsed.data.topicId)return res.status(404).json({message:'Message not found in this topic.'});
      const id=cursorKey(userId(req),parsed.data.topicId);
      await ReadState.updateOne({_id:id},{$setOnInsert:{readAt:new Date(0),readId:new mongoose.Types.ObjectId('000000000000000000000000')}},{upsert:true});
      // A slow receipt from another tab must never move the read position back.
      await ReadState.updateOne({_id:id,$or:[{readAt:{$lt:message.createdAt}},{readAt:message.createdAt,readId:{$lt:message._id}}]},{$set:{readAt:message.createdAt,readId:message._id}});
      realtime.publish('read');res.set('Cache-Control','no-store').json(await status(req));
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
      realtime.publish('receipts');res.json({acknowledged:true});
    }catch{res.status(503).json({message:'Message receipt could not be saved.'});}
  });
  const serialize = (item,receipts=[],compact=false) => ({ id: String(item._id),topicId:topicOf(item), senderId: item.senderId, senderName: item.senderName, content: item.content, attachment: item.attachment?.type && (compact || item.attachment.data) ? (compact?{type:item.attachment.type,name:item.attachment.name,mimeType:item.attachment.mimeType}:item.attachment) : undefined, createdAt: item.createdAt,editedAt:item.editedAt||null,...deliveryTimes(item,receipts) });
  app.get('/api/echo-project-chat', requireAdmin, async (req, res) => {
    if (!userId(req)) return res.status(401).json({ message: 'Sign in to use project chat.' });
    const selected=topicIdSchema.safeParse(req.query.topicId);
    if(!selected.success)return res.status(400).json({message:'Choose a valid discussion topic.'});
    try {
      if(!await validTopic(selected.data))return res.status(404).json({message:'Discussion topic not found.'});
      const compact=req.query.compact==='1';
      const query=Message.find(topicFilter(selected.data)).sort({ createdAt: -1, _id: -1 }).limit(200);
      if(compact)query.select('-attachment.data');
      const items = await query.lean();
      const receipts=items.length?await Receipt.find({messageId:{$in:items.map(item=>String(item._id))}}).lean():[];
      const byMessage=new Map();for(const receipt of receipts){const rows=byMessage.get(receipt.messageId)||[];rows.push(receipt);byMessage.set(receipt.messageId,rows);}
      res.set('Cache-Control', 'no-store').json({ items: items.reverse().map(item=>serialize(item,byMessage.get(String(item._id)),compact)) });
    } catch { res.status(503).json({ message: 'Project chat is temporarily unavailable.' }); }
  });
  app.get('/api/echo-project-chat/:id/attachment',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    if(!/^[a-f\d]{24}$/i.test(req.params.id))return res.status(400).json({message:'Invalid message.'});
    try{
      const message=await Message.findById(req.params.id).select('attachment').lean();
      if(!message?.attachment?.data)return res.status(404).json({message:'Attachment is no longer available.'});
      res.set('Cache-Control','no-store').json({attachment:message.attachment});
    }catch{res.status(503).json({message:'Attachment could not be loaded. Please retry.'});}
  });
  app.post('/api/echo-project-chat', requireAdmin, async (req, res) => {
    if (!userId(req)) return res.status(401).json({ message: 'Sign in to use project chat.' });
    const attachment = z.object({ type: z.enum(['image', 'audio']), name: z.string().max(160), mimeType: z.string().max(100), data: z.string().max(7_500_000) }).optional();
    const parsed = z.object({ topicId:topicIdSchema,content: z.string().trim().max(2000).default(''), attachment }).refine(value => value.content || value.attachment).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Add a message or a supported image or voice note.' });
    if (parsed.data.attachment) {
      const { type, mimeType, data } = parsed.data.attachment;
      const validMime = type === 'image' ? /^image\/(png|jpeg|webp|gif)$/.test(mimeType) : /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav)$/.test(mimeType);
      if (!validMime || !data.startsWith(`data:${mimeType};base64,`) || data.length > (type === 'image' ? 5_500_000 : 7_500_000)) return res.status(400).json({ message: 'Attachment type or size is not supported.' });
    }
    try {
      if(!await validTopic(parsed.data.topicId))return res.status(404).json({message:'Discussion topic not found.'});
      const user = actor(req);
      const item = await Message.create({topicId:parsed.data.topicId, senderId: userId(req), senderName: String(user.name || user.firstName || user.email || 'Echo user').slice(0, 120), content: parsed.data.content, attachment: parsed.data.attachment });
      realtime.publish('messages');res.status(201).json({ item: serialize(item.toObject()) });
    } catch { res.status(503).json({ message: 'Message could not be sent. Please try again.' }); }
  });
  app.delete('/api/echo-project-chat/:id',requireAdmin,async(req,res)=>{
    if(!userId(req))return res.status(401).json({message:'Sign in to use project chat.'});
    if(!/^[a-f\d]{24}$/i.test(req.params.id))return res.status(400).json({message:'Invalid message.'});
    try{
      const removed=await Message.findOneAndDelete({_id:req.params.id,senderId:userId(req)});
      if(!removed)return res.status(404).json({message:'Your message was not found.'});
      await Receipt.deleteMany({messageId:String(removed._id)}).catch(()=>{});
      realtime.publish('messages');res.json({deleted:true,id:String(removed._id)});
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
      realtime.publish('messages');res.json({item:serialize(item.toObject(),receipts)});
    }catch{res.status(503).json({message:'Message could not be edited. Please try again.'});}
  });
  return realtime;
}

module.exports = { registerEchoProjectChat, Topic, Message, ReadState, Presence, Receipt, ONLINE_WINDOW_MS, afterCursor, deliveryTimes };
