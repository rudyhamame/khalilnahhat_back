const mongoose=require('mongoose');
const {z}=require('zod');
const schema=new mongoose.Schema({session:{type:String,required:true},name:{type:String,required:true,maxlength:60},text:{type:String,required:true,maxlength:280}},{timestamps:true});
schema.index({session:1,createdAt:-1});
const LiveComment=mongoose.models.LiveComment||mongoose.model('LiveComment',schema);
const input=z.object({name:z.string().trim().max(60).optional().default(''),text:z.string().trim().min(1).max(280),session:z.string().min(1).max(300)}).strict();
function sessionKey(stream){return stream?.isLive?String(stream.webrtcRoomName||stream.activeSessionId||`live-${stream.updatedAt||stream._id||'current'}`):null;}
function serialize(comment){return {id:String(comment._id),name:comment.name,text:comment.text,createdAt:comment.createdAt};}
function registerLiveComments(app,{getLiveStreamConfig,CommentModel=LiveComment,clock=Date.now}){
 const limits=new Map();
 app.get('/api/live-comments',async(_req,res)=>{
  const session=sessionKey(await getLiveStreamConfig());
  if(!session)return res.json({session:null,items:[]});
  const comments=await CommentModel.find({session}).sort({createdAt:-1,_id:-1}).limit(20).lean();
  res.set('Cache-Control','no-store').json({session,items:comments.reverse().map(serialize)});
 });
 app.post('/api/live-comments',async(req,res)=>{
  const parsed=input.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'Enter a comment of 1–280 characters and a name of up to 60 characters.'});
  const session=sessionKey(await getLiveStreamConfig());
  if(!session||session!==parsed.data.session)return res.status(409).json({message:'This live session has ended. Refresh before posting.'});
  const now=clock(),key=String(req.ip||'unknown');
  let quota=limits.get(key);if(!quota||now-quota.start>=60000){quota={start:now,count:0};limits.set(key,quota);}
  if(quota.count>=5)return res.status(429).set('Retry-After','60').json({message:'Please wait a minute before sending another comment.'});
  quota.count++;
  if(limits.size>10000)for(const [ip,state] of limits)if(now-state.start>=60000)limits.delete(ip);
  const item=await CommentModel.create({session,name:parsed.data.name||'Guest',text:parsed.data.text});
  res.status(201).json({item:serialize(item)});
 });
}
module.exports={registerLiveComments,sessionKey,input};
