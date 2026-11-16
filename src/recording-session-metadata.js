const {requestScope}=require('./live-interactions');

// These records stay attached to their broadcast after it ends. Never infer an
// owner for the old global queue: unscoped entries may belong to different lives.
async function sessionMetadata(session,{LiveSession,LiveRequest,LiveComment}) {
 const [setList,requests,comments]=await Promise.all([
  LiveSession.find({broadcastSessionId:session}).sort({sortOrder:1,createdAt:1}).lean(),
  LiveRequest.find(requestScope(session)).sort({createdAt:1}).lean(),
  LiveComment.find({session}).sort({createdAt:1,_id:1}).lean(),
 ]);
 return {
  session,
  setList:setList.map(item=>({id:item.externalId,track:item.track,artist:item.artist||'',duration:item.duration||'',playState:item.playState||'queued'})),
  requests:requests.map(item=>({id:item.externalId,track:item.track,artist:item.artist||'',name:item.requesterName||'Audience',text:item.message||'',status:item.requestStatus,createdAt:item.createdAt})),
  comments:comments.map(item=>({id:String(item._id),name:item.name,text:item.text,hidden:Boolean(item.hidden),createdAt:item.createdAt,...(item.reply?.text?{reply:{text:item.reply.text,at:item.reply.at}}:{})})),
 };
}
function registerRecordingSessionMetadata(app,requireAdmin,{Recording,LiveSession,LiveRequest,LiveComment,isValidId}) {
 app.get('/api/admin/live-recordings/:id/metadata',requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const row=isValidId(req.params.id)?await Recording.findOne({_id:req.params.id,deletedAt:null}):null;
  if(!row)return res.status(404).json({message:'Recording not found.'});
  return res.json(await sessionMetadata(row.sessionRoomName||row.roomName,{LiveSession,LiveRequest,LiveComment}));
 });
}
module.exports={sessionMetadata,registerRecordingSessionMetadata};
