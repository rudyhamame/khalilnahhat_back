const mongoose=require('mongoose');
const {randomUUID}=require('node:crypto');
const {z}=require('zod');
const {normalizeEventOrder,validateEventOrder}=require('./event-order');
const schema=new mongoose.Schema({_id:String,draftId:{type:String,default:randomUUID},order:mongoose.Schema.Types.Mixed,version:{type:Number,default:1}},{timestamps:true});
const EventDraft=mongoose.models.EventDraft||mongoose.model('EventDraft',schema);
const mongoStore={
  async get(owner){
    let item=await EventDraft.findById(owner).lean();
    if(item&&!item.draftId)item=await EventDraft.findOneAndUpdate({_id:owner,draftId:{$exists:false}},{$set:{draftId:randomUUID()}},{new:true}).lean()||await EventDraft.findById(owner).lean();
    return item;
  },
  async put(owner,version,order,draftId){
    if(version===0){try{return await EventDraft.create({_id:owner,draftId,version:1,order});}catch(error){if(error.code===11000)return null;throw error;}}
    return EventDraft.findOneAndUpdate({_id:owner,version,draftId},{$set:{order},$inc:{version:1}},{new:true}).lean();
  },
  async remove(owner,version){return (await EventDraft.deleteOne({_id:owner,version})).deletedCount===1;},
};
const inputSchema=z.object({version:z.number().int().min(0),draftId:z.uuid().optional(),order:z.record(z.string(),z.unknown())}).strict();
const serialize=item=>item?{draftId:item.draftId,order:item.order,version:item.version,updatedAt:item.updatedAt}:null;
function registerEventDrafts(app,{requireAuth,store=mongoStore}){
  const writes=new Map();
  const guarded=handler=>async(req,res)=>{
    const owner=String(req.authUser?._id||req.authUser?.id||'');
    res.set('Cache-Control','no-store');
    if(!owner)return res.status(401).json({message:'Sign in to access your event draft.'});
    try{await handler(req,res,owner);}catch{res.status(503).json({message:'Your account draft could not be saved or loaded. Please retry.'});}
  };
  app.get('/api/ai-booking/event-draft',requireAuth,guarded(async(req,res,owner)=>res.json({item:serialize(await store.get(owner))})));
  app.put('/api/ai-booking/event-draft',requireAuth,guarded(async(req,res,owner)=>{
    const now=Date.now();for(const [key,bucket] of writes)if(bucket.until<=now)writes.delete(key);
    const bucket=writes.get(owner)||{count:0,until:now+600000};
    if(bucket.count>=300||writes.size>5000)return res.status(429).json({message:'Draft save limit reached. Please retry later.'});
    bucket.count++;writes.set(owner,bucket);
    const parsed=inputSchema.safeParse(req.body);
    if(!parsed.success||JSON.stringify(req.body).length>100000)return res.status(400).json({message:'Invalid event draft.'});
    // Drafts can be incomplete, but must still satisfy the shared field types.
    if(validateEventOrder(parsed.data.order).length)return res.status(400).json({message:'Some draft values are invalid.'});
    const draftId=parsed.data.draftId||(await store.get(owner))?.draftId||randomUUID();
    const item=await store.put(owner,parsed.data.version,normalizeEventOrder(parsed.data.order),draftId);
    if(!item)return res.status(409).json({message:'This draft changed in another tab or device. Reload the account draft before saving again.'});
    res.json({item:serialize(item)});
  }));
  app.delete('/api/ai-booking/event-draft',requireAuth,guarded(async(req,res,owner)=>{
    const version=z.coerce.number().int().positive().safeParse(req.query.version);
    if(!version.success)return res.status(400).json({message:'Invalid draft version.'});
    if(!await store.remove(owner,version.data))return res.status(409).json({message:'This draft changed. Reload before removing it.'});
    res.json({removed:true});
  }));
}
module.exports={registerEventDrafts,EventDraft,mongoStore};
