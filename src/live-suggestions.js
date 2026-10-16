const {z}=require('zod');
const {randomUUID,randomBytes}=require('crypto');
const {LiveRequest}=require('./models');
LiveRequest.schema.add({broadcastRoomName:{type:String,default:''}});
const suggestionInput=z.object({
 requesterName:z.string().trim().max(80).optional().default('Audience'),
 track:z.string().trim().max(200).optional().default(''),artist:z.string().trim().max(120).optional().default(''),
 sourceUrl:z.union([z.literal(''),z.url().max(2048).refine(value=>new URL(value).protocol==='https:','Use an HTTPS song link.')]).optional().default(''),
 note:z.string().trim().max(300).optional().default(''),
}).strict().refine(value=>value.track.length>0||value.sourceUrl.length>0,'Enter a song name or song link.');
function platform(value){try{const h=new URL(value).hostname.toLowerCase();return [['youtube','youtube.com'],['youtube','youtu.be'],['spotify','spotify.com'],['anghami','anghami.com']].find(([,host])=>h===host||h.endsWith('.'+host))?.[0]||'link';}catch{return 'manual';}}
function registerLiveSuggestions(app,{getLiveStreamConfig,RequestModel=LiveRequest,clock=Date.now}){
 const limits=new Map();
 app.post('/api/live-suggestions',async(req,res)=>{
  const parsed=suggestionInput.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'Enter a song name or a valid HTTPS song link.'});
  const current=await getLiveStreamConfig();if(!current.isLive)return res.status(409).json({message:'Song requests open when DJ Khalil is live.'});
  const key=String(req.get?.('cf-connecting-ip')||req.ip||'unknown').slice(0,80),now=clock();
  let quota=limits.get(key);if(!quota||now-quota.start>=60000){quota={start:now,count:0};limits.set(key,quota);}
  if(quota.count>=5)return res.status(429).set('Retry-After','60').json({message:'Please wait a minute before sending more song requests.'});
  quota.count++;
  if(limits.size>10000)for(const [ip,state]of limits)if(now-state.start>=60000)limits.delete(ip);
  const data=parsed.data;const confirmationCode='REQ-'+randomBytes(4).toString('hex').toUpperCase();
  await RequestModel.create({externalId:'live-request-'+randomUUID(),requesterName:data.requesterName||'Audience',requesterEmail:'',confirmationCode,
   message:[data.track,data.artist,data.note,data.sourceUrl].filter(Boolean).join(' — '),track:data.track||'Song link',artist:data.artist,sourceUrl:data.sourceUrl,
   sourcePlatform:platform(data.sourceUrl),broadcastRoomName:current.webrtcRoomName||'',requestStatus:'pending_admin',paymentStatus:'none',aiSummary:'Awaiting Khalil review.'});
  res.status(201).json({message:'Your song request was sent to DJ Khalil.',confirmationCode});
 });
}
module.exports={registerLiveSuggestions,suggestionInput,platform};
