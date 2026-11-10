const mongoose=require('mongoose');
const {z}=require('zod');
const {sessionKey,memberName}=require('./live-interactions');
const schema=new mongoose.Schema({session:{type:String,required:true},authorId:{type:String,required:true},name:{type:String,required:true,maxlength:60},text:{type:String,required:true,maxlength:280},hidden:{type:Boolean,default:false},reply:{text:{type:String,maxlength:280},at:Date}},{timestamps:true});
schema.index({session:1,createdAt:-1});
const LiveComment=mongoose.models.LiveComment||mongoose.model('LiveComment',schema);
const input=z.object({name:z.string().trim().max(60).optional().default(''),text:z.string().trim().min(1).max(280),session:z.string().min(1).max(300)}).strict();
function serialize(comment){return {id:String(comment._id),name:comment.name,text:comment.text,createdAt:comment.createdAt,hidden:Boolean(comment.hidden),...(comment.reply?.text?{reply:{text:comment.reply.text,at:comment.reply.at}}:{})};}
function registerLiveComments(app,{getLiveStreamConfig,requireAuth,requireAdmin,CommentModel=LiveComment,clock=Date.now}){
 const limits=new Map();
 const read=async(req,res)=>{
  const session=sessionKey(await getLiveStreamConfig());
  if(req.query?.session && req.query.session!==session)return res.status(409).json({message:'This live session has ended. Refresh to join the current broadcast.'});
  if(!session)return res.json({session:null,items:[]});
  const comments=await CommentModel.find({session,...(req.liveCommentsAdmin ? {} : {hidden:{$ne:true}})}).sort({createdAt:-1,_id:-1}).limit(req.liveCommentsAdmin?100:20).lean();
  res.set('Cache-Control','no-store').json({session,items:comments.reverse().map(serialize)});
 };
 app.get('/api/live-comments',requireAuth,read);
 if(requireAdmin) app.get('/api/live-comments/admin',requireAdmin,(req,res)=>{req.liveCommentsAdmin=true;return read(req,res);});
 if(requireAdmin) app.patch('/api/live-comments/:id/moderation',requireAdmin,async(req,res)=>{
  const parsed=z.object({session:z.string().min(1).max(300),hidden:z.boolean()}).strict().safeParse(req.body);
  if(!parsed.success||!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Choose a valid comment and moderation action.'});
  const session=sessionKey(await getLiveStreamConfig());
  if(!session||parsed.data.session!==session)return res.status(409).json({message:'The live stream changed. Refresh the comments.'});
  const item=await CommentModel.findOneAndUpdate({_id:req.params.id,session},{$set:{hidden:parsed.data.hidden}},{new:true});
  if(!item)return res.status(404).json({message:'Comment not found in this broadcast.'});
  return res.set('Cache-Control','no-store').json({item:serialize(item)});
 });

 // The host answers an audience comment; the reply is shown under it for everyone in the room. An empty reply removes it.
 if(requireAdmin) app.post('/api/live-comments/:id/reply',requireAdmin,async(req,res)=>{
  const parsed=z.object({session:z.string().min(1).max(300),text:z.string().trim().max(280)}).strict().safeParse(req.body);
  if(!parsed.success||!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Enter a reply of up to 280 characters.'});
  const session=sessionKey(await getLiveStreamConfig());
  if(!session||parsed.data.session!==session)return res.status(409).json({message:'The live stream changed. Refresh the comments.'});
  const change=parsed.data.text?{$set:{reply:{text:parsed.data.text,at:new Date(clock())}}}:{$unset:{reply:1}};
  const item=await CommentModel.findOneAndUpdate({_id:req.params.id,session},change,{new:true});
  if(!item)return res.status(404).json({message:'Comment not found in this broadcast.'});
  return res.set('Cache-Control','no-store').json({item:serialize(item)});
 });

 app.post('/api/live-comments',requireAuth,async(req,res)=>{
  const parsed=input.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'Enter a comment of 1–280 characters and a name of up to 60 characters.'});
  const session=sessionKey(await getLiveStreamConfig());
  if(!session||session!==parsed.data.session)return res.status(409).json({message:'This live session has ended. Refresh before posting.'});
  const now=clock(),key=String(req.authUser._id);
  let quota=limits.get(key);if(!quota||now-quota.start>=60000){quota={start:now,count:0};limits.set(key,quota);}
  if(quota.count>=5)return res.status(429).set('Retry-After','60').json({message:'Please wait a minute before sending another comment.'});
  quota.count++;
  if(limits.size>10000)for(const [ip,state] of limits)if(now-state.start>=60000)limits.delete(ip);
  const item=await CommentModel.create({session,authorId:String(req.authUser._id),name:memberName(req.authUser),text:parsed.data.text});
  res.status(201).json({item:serialize(item)});
 });
}
module.exports={registerLiveComments,sessionKey,input};
