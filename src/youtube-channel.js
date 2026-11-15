const crypto=require('node:crypto');
const mongoose=require('mongoose');
const {z}=require('zod');

// The public "Subscribe" button's channel settings, managed from Admin > YouTube.
// The channel (handle or id) is public. The optional YouTube Data API key is a secret: it is encrypted at rest, never
// returned by any route, and only used server-side to read the channel's name, picture and subscriber count.
const INTERVAL=15*60*1000,RETRY=60*1000;
const failure=(status,message)=>Object.assign(new Error(message),{status});
const Model=mongoose.models.YouTubeChannel||mongoose.model('YouTubeChannel',new mongoose.Schema({
 _id:String,secret:{type:String,select:false},channelId:String,handle:String,enabled:{type:Boolean,default:true},
 title:String,thumbnail:String,subscribers:Number,subscribersHidden:Boolean,syncedAt:Date,lastAttemptAt:Date,error:String,revision:{type:Number,default:0},
},{timestamps:true}));
const store={load:()=>Model.findById('channel').select('+secret').lean(),async save(value,revision){
 if(revision===null){try{return (await Model.create({_id:'channel',...value,revision:1})).toObject();}catch(e){if(e.code===11000)throw failure(409,'YouTube settings changed. Reload and try again.');throw e;}}
 const row=await Model.findOneAndUpdate({_id:'channel',revision},{$set:{...value,revision:revision+1}},{new:true}).select('+secret').lean();
 if(!row)throw failure(409,'YouTube settings changed. Reload and try again.');return row;
}};

function key(env){
 const source=env.ECHO_YOUTUBE_ENCRYPTION_KEY||env.SESSION_ENCRYPTION_KEY;
 if(!/^[a-f0-9]{64}$/i.test(source||''))throw failure(503,'Configure ECHO_YOUTUBE_ENCRYPTION_KEY or SESSION_ENCRYPTION_KEY on the API server (64 hexadecimal characters).');
 return crypto.createHmac('sha256',Buffer.from(source,'hex')).update('echo-youtube-channel-v1').digest();
}
function seal(value,env){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(env),iv);const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),bytes].map(part=>part.toString('base64url')).join('.');}
function unseal(value,env){try{const [iv,tag,bytes]=value.split('.').map(part=>Buffer.from(part,'base64url'));const cipher=crypto.createDecipheriv('aes-256-gcm',key(env),iv);cipher.setAuthTag(tag);return Buffer.concat([cipher.update(bytes),cipher.final()]).toString('utf8');}catch{throw failure(503,'The saved YouTube API key cannot be read. Save it again.');}}

// Accepts a channel URL, an @handle, or a channel id (UC…). Returns {channelId} or {handle}.
function parseChannel(input){
 const text=String(input||'').trim();
 if(/^UC[A-Za-z0-9_-]{22}$/.test(text))return {channelId:text};
 if(/^@?[A-Za-z0-9._-]{3,30}$/.test(text))return {handle:text.replace(/^@/,'')};
 let url;try{url=new URL(/^https?:\/\//i.test(text)?text:`https://${text}`);}catch{url=null;}
 if(url&&/^(www\.|m\.)?youtube\.com$/i.test(url.hostname)){
  const handle=url.pathname.match(/^\/@([A-Za-z0-9._-]{3,30})\/?/);if(handle)return {handle:handle[1]};
  const id=url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})\/?/);if(id)return {channelId:id[1]};
 }
 throw failure(400,'Enter the channel as @handle, a youtube.com/@handle link, or a youtube.com/channel/UC… link.');
}
const channelUrl=row=>row?.handle?`https://www.youtube.com/@${row.handle}`:row?.channelId?`https://www.youtube.com/channel/${row.channelId}`:'';
const safeImage=value=>{try{const url=new URL(value);return url.protocol==='https:'?url.href:'';}catch{return '';}};

const schema=z.object({
 channel:z.string().trim().min(3).max(300),
 apiKey:z.string().trim().min(20,'That does not look like a YouTube API key.').max(200).regex(/^[A-Za-z0-9_-]+$/,'Enter only the API key.').optional(),
 removeApiKey:z.boolean().optional(),
 enabled:z.boolean(),
});

function createYouTubeChannelService({repository=store,env=process.env,fetchImpl=fetch,now=Date.now}={}){
 let queue=Promise.resolve(),inflight=null;
 const exclusive=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 const persist=(old,value)=>repository.save(value,old?.revision??null);
 const lookup=async(ref,apiKey)=>{
  const url=new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part','snippet,statistics');
  if(ref.channelId)url.searchParams.set('id',ref.channelId);else url.searchParams.set('forHandle',`@${ref.handle}`);
  let response,data;
  try{response=await fetchImpl(url,{headers:{'x-goog-api-key':apiKey},signal:AbortSignal.timeout(10000),redirect:'error'});data=await response.json();}
  catch{throw failure(502,'YouTube could not be reached. Try again shortly.');}
  if(!response.ok)throw failure(422,response.status===400||response.status===403?'YouTube rejected this API key. Check that the YouTube Data API v3 is enabled for it.':'YouTube could not look up this channel.');
  const row=data.items?.[0];
  if(!row?.id)throw failure(404,'YouTube did not find that channel. Check the handle or channel id.');
  const hidden=Boolean(row.statistics?.hiddenSubscriberCount),count=Number.parseInt(row.statistics?.subscriberCount,10);
  return {
   channelId:row.id,title:String(row.snippet?.title||'').slice(0,150),
   thumbnail:safeImage(row.snippet?.thumbnails?.high?.url||row.snippet?.thumbnails?.default?.url),
   subscribers:!hidden&&Number.isSafeInteger(count)&&count>=0?count:null,subscribersHidden:hidden,
  };
 };
 const view=(row,admin=false)=>{
  const enabled=row?.enabled!==false&&Boolean(row?.handle||row?.channelId);
  const out={
   enabled,configured:Boolean(row?.handle||row?.channelId),handle:row?.handle||'',channelId:row?.channelId||'',url:channelUrl(row),
   title:row?.title||'',thumbnail:row?.thumbnail||'',subscribers:row?.subscribers??null,subscribersHidden:Boolean(row?.subscribersHidden),syncedAt:row?.syncedAt||null,
  };
  if(!admin)return enabled?out:{enabled:false,configured:out.configured,url:'',handle:'',channelId:'',title:'',thumbnail:'',subscribers:null,subscribersHidden:false,syncedAt:null};
  return {...out,enabled:row?.enabled!==false,hasApiKey:Boolean(row?.secret),error:row?.error||'',encryptionConfigured:/^[a-f0-9]{64}$/i.test(env.ECHO_YOUTUBE_ENCRYPTION_KEY||env.SESSION_ENCRYPTION_KEY||'')};
 };
 const sync=async(force=false)=>{
  const old=await repository.load();
  if(!old?.secret||(!force&&old.enabled===false))return old;
  if(!force&&now()-new Date(old.lastAttemptAt||0).getTime()<(old.error?RETRY:INTERVAL))return old;
  try{
   const found=await lookup(old.channelId?{channelId:old.channelId}:{handle:old.handle},unseal(old.secret,env));
   return await persist(old,{...old,...found,syncedAt:new Date(now()),lastAttemptAt:new Date(now()),error:''});
  }catch(error){
   if(error.status===409)throw error;
   const message=error.status?error.message:'YouTube could not update. Try again shortly.';
   const saved=await persist(old,{...old,lastAttemptAt:new Date(now()),error:message});
   if(force)throw failure(error.status||502,message);return saved;
  }
 };
 return {
  async publicChannel(){if(!inflight)inflight=exclusive(()=>sync()).finally(()=>{inflight=null;});return view(await inflight);},
  async status(){return view(await repository.load(),true);},
  save:body=>exclusive(async()=>{
   const parsed=schema.safeParse(body);if(!parsed.success)throw failure(400,parsed.error.issues[0]?.message||'Check the YouTube settings.');
   const {channel,apiKey,removeApiKey,enabled}=parsed.data,ref=parseChannel(channel),old=await repository.load();
   let secret=removeApiKey?'':old?.secret||'',found={};
   if(apiKey){secret=seal(apiKey,env);found=await lookup(ref,apiKey);}
   else if(secret){found=await lookup(ref,unseal(secret,env));}
   const base={handle:ref.handle||'',channelId:ref.channelId||''};
   // Resolving through the API fills in the other identifier, name, picture and count.
   const next={...old,...base,...found,handle:ref.handle||'',secret,enabled,error:'',
    ...(secret?{syncedAt:new Date(now()),lastAttemptAt:new Date(now())}:{title:'',thumbnail:'',subscribers:null,subscribersHidden:false,syncedAt:null})};
   return view(await persist(old,next),true);
  }),
  refresh:()=>exclusive(async()=>view(await sync(true),true)),
  disconnect:()=>exclusive(async()=>{const old=await repository.load();if(!old)return view(null,true);return view(await persist(old,{secret:'',channelId:'',handle:'',enabled:false,title:'',thumbnail:'',subscribers:null,subscribersHidden:false,syncedAt:null,lastAttemptAt:null,error:''}),true);}),
 };
}

function registerYouTubeChannel(app,{requireAdmin,...options}){
 const service=createYouTubeChannelService(options);
 const route=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({item:await fn(req)});}catch(error){res.status(error.status||503).json({message:error.status?error.message:'YouTube settings are temporarily unavailable.'});}};
 app.get('/api/youtube/channel',route(()=>service.publicChannel()));
 app.get('/api/admin/youtube-channel',requireAdmin,route(()=>service.status()));
 app.put('/api/admin/youtube-channel',requireAdmin,route(req=>service.save(req.body)));
 app.post('/api/admin/youtube-channel/refresh',requireAdmin,route(()=>service.refresh()));
 app.delete('/api/admin/youtube-channel',requireAdmin,route(()=>service.disconnect()));
 return service;
}
module.exports={registerYouTubeChannel,createYouTubeChannelService,parseChannel};
