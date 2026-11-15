const {randomUUID}=require('node:crypto');
const {sessionKey}=require('./live-interactions');

async function orderedSetList(Model,session) {
 if(!session)return [];
 return Model.find({broadcastSessionId:session}).sort({sortOrder:1,createdAt:1});
}
function registerLiveSetList(app,{requireAuth,requireAdmin,getLiveStreamConfig,LiveSession,input,serialize,remove}) {
 const activeSession=async(req,res,checkBody=false)=>{
  const session=sessionKey(await getLiveStreamConfig());
  if(!session||(checkBody&&req.body?.session!==session)){
   res.status(409).json({message:'The live session has ended or changed. Refresh its set list.'});return null;
  }
  return session;
 };
 app.get('/api/live-sessions',requireAuth,async(req,res)=>{
  const session=sessionKey(await getLiveStreamConfig());
  if(req.query.session&&req.query.session!==session)return res.status(409).json({message:'This live session has ended.'});
  return res.set('Cache-Control','no-store').json({session,items:(await orderedSetList(LiveSession,session)).map(serialize)});
 });
 app.post('/api/live-sessions',requireAdmin,async(req,res)=>{
  const session=await activeSession(req,res,true);if(!session)return;
  const parsed=input.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:'Live session payload failed validation.',errors:parsed.error.flatten().fieldErrors});
  const items=await orderedSetList(LiveSession,session);
  const sortOrder=parsed.data.sortOrder??Math.max(0,...items.map(item=>Number(item.sortOrder)||0))+100;
  const item=await LiveSession.create({...parsed.data,sortOrder,externalId:`live-session-${randomUUID()}`,broadcastSessionId:session});
  return res.status(201).json({item:serialize(item)});
 });
 app.patch('/api/live-sessions/:id',requireAdmin,async(req,res)=>{
  const session=await activeSession(req,res,true);if(!session)return;
  const parsed=input.partial().safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:'Live session update failed validation.',errors:parsed.error.flatten().fieldErrors});
  const item=await LiveSession.findOneAndUpdate({externalId:req.params.id,broadcastSessionId:session},parsed.data,{new:true});
  if(!item)return res.status(404).json({message:'Set list item not found in this broadcast.'});
  return res.json({item:serialize(item)});
 });
 app.delete('/api/live-sessions/:id',requireAdmin,async(req,res)=>{
  const session=await activeSession(req,res);if(!session)return;
  const item=await remove(LiveSession,{externalId:req.params.id,broadcastSessionId:session});
  if(!item)return res.status(404).json({message:'Set list item not found in this broadcast.'});
  return res.json({ok:true,cloudinaryCleanupPending:Boolean(item.cloudinaryCleanupPending)});
 });
}
module.exports={orderedSetList,registerLiveSetList};
