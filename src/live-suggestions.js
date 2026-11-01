const {z}=require('zod');
const {randomUUID,randomBytes}=require('crypto');
const {LiveRequest}=require('./models');
const {sessionKey,memberName,requestScope}=require('./live-interactions');
const {consumeLiveQuota}=require('./live-rate-limit');
const suggestionInput=z.object({
 session:z.string().min(1).max(300),
 requesterName:z.string().trim().max(80).optional().default('Audience'),
 track:z.string().trim().max(200).optional().default(''),artist:z.string().trim().max(120).optional().default(''),
 sourceUrl:z.union([z.literal(''),z.url().max(2048).refine(value=>new URL(value).protocol==='https:','Use an HTTPS song link.')]).optional().default(''),
 note:z.string().trim().max(300).optional().default(''),
}).strict().refine(value=>value.track.length>0||value.sourceUrl.length>0,'Enter a song name or song link.');
function platform(value){try{const h=new URL(value).hostname.toLowerCase();return [['youtube','youtube.com'],['youtube','youtu.be'],['spotify','spotify.com'],['anghami','anghami.com']].find(([,host])=>h===host||h.endsWith('.'+host))?.[0]||'link';}catch{return 'manual';}}
function registerLiveSuggestions(app,{getLiveStreamConfig,requireAuth,RequestModel=LiveRequest,clock=Date.now}){
 app.get('/api/live-suggestions',requireAuth,async(req,res)=>{
  const session=sessionKey(await getLiveStreamConfig());
  if(req.query?.session!==session)return res.status(409).json({message:'The broadcast changed. Refresh your requests.'});
  const items=session?await RequestModel.find({...requestScope(session),requesterUserId:String(req.authUser._id)}).sort({createdAt:-1}).limit(20).lean():[];
  return res.set('Cache-Control','no-store').json({session,items:items.map(row=>({id:row.externalId,track:row.track,artist:row.artist,confirmationCode:row.confirmationCode,status:row.requestStatus,createdAt:row.createdAt}))});
 });
 app.post('/api/live-suggestions',requireAuth,async(req,res)=>{
  const parsed=suggestionInput.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'Enter a song name or a valid HTTPS song link.'});
  const current=await getLiveStreamConfig(),session=sessionKey(current);
  if(!session||session!==parsed.data.session)return res.status(409).json({message:'This live session has ended. Refresh before requesting a song.'});
  if(!consumeLiveQuota(req.authUser._id,1,clock))return res.status(429).set('Retry-After','60').json({message:'Please wait a minute before sending more song requests.'});
  const data=parsed.data;const confirmationCode='REQ-'+randomBytes(4).toString('hex').toUpperCase();
  await RequestModel.create({externalId:'live-request-'+randomUUID(),requesterUserId:String(req.authUser._id),requesterName:memberName(req.authUser),requesterEmail:req.authUser.email,confirmationCode,
   message:[data.track,data.artist,data.note,data.sourceUrl].filter(Boolean).join(' — '),track:data.track||'Song link',artist:data.artist,sourceUrl:data.sourceUrl,
   sourcePlatform:platform(data.sourceUrl),broadcastRoomName:current.webrtcRoomName||'',broadcastSessionId:session,requestStatus:'pending_admin',paymentStatus:'none',aiSummary:'Awaiting Khalil review.'});
  res.status(201).json({message:'Your song request was sent to DJ Khalil.',confirmationCode});
 });
}
module.exports={registerLiveSuggestions,suggestionInput,platform};
