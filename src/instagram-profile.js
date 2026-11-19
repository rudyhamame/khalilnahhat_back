const crypto=require('node:crypto');
const mongoose=require('mongoose');
const {z}=require('zod');

const INTERVAL=15*60*1000,RETRY=60*1000,WEEK=7*86400000;
const fields='user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count';
const failure=(status,message)=>Object.assign(new Error(message),{status});
const Model=mongoose.models.InstagramProfile||mongoose.model('InstagramProfile',new mongoose.Schema({
 _id:String,secret:{type:String,select:false},profile:mongoose.Schema.Types.Mixed,
 enabled:{type:Boolean,default:true},caption:String,website:String,syncedAt:Date,
 tokenRefreshedAt:Date,expiresAt:Date,lastAttemptAt:Date,error:String,revision:{type:Number,default:0},
},{timestamps:true}));
const store={load:()=>Model.findById('about').select('+secret').lean(),async save(value,revision){
 if(revision===null){try{return (await Model.create({_id:'about',...value,revision:1})).toObject();}catch(e){if(e.code===11000)throw failure(409,'Instagram settings changed. Reload and try again.');throw e;}}
 const row=await Model.findOneAndUpdate({_id:'about',revision},{$set:{...value,revision:revision+1}},{new:true}).select('+secret').lean();
 if(!row)throw failure(409,'Instagram settings changed. Reload and try again.');return row;
}};
const schema=z.object({accessToken:z.string().trim().min(20).max(4096).regex(/^[A-Za-z0-9._~-]+$/,'Enter only the Instagram access token.').optional(),enabled:z.boolean(),caption:z.string().trim().max(300),website:z.union([z.literal(''),z.url().max(500).refine(v=>new URL(v).protocol==='https:','Use an https:// website address.')])}).strict();
function key(env){
 const source=env.ECHO_INSTAGRAM_ENCRYPTION_KEY||env.SESSION_ENCRYPTION_KEY;
 if(!/^[a-f0-9]{64}$/i.test(source||''))throw failure(503,'Configure ECHO_INSTAGRAM_ENCRYPTION_KEY or SESSION_ENCRYPTION_KEY on the API server (64 hexadecimal characters).');
 return crypto.createHmac('sha256',Buffer.from(source,'hex')).update('echo-instagram-profile-v1').digest();
}
function seal(value,env){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(env),iv);const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),bytes].map(v=>v.toString('base64url')).join('.');}
function unseal(value,env){try{const [iv,tag,bytes]=value.split('.').map(v=>Buffer.from(v,'base64url'));const cipher=crypto.createDecipheriv('aes-256-gcm',key(env),iv);cipher.setAuthTag(tag);return Buffer.concat([cipher.update(bytes),cipher.final()]).toString('utf8');}catch(error){if(error.status)throw error;throw failure(503,'The saved Instagram token cannot be read. Save a replacement token.');}}
const safeImage=value=>{try{const url=new URL(value);return url.protocol==='https:'?url.href:'';}catch{return '';}};
function normalize(data){
 const row=Array.isArray(data.data)?data.data[0]:data;
 if(!row||!/^[A-Za-z0-9._]{1,30}$/.test(row.username||'')||!row.user_id)throw failure(502,'Instagram did not return a valid profile. Check the token’s account and permissions.');
 const count=name=>Number.isSafeInteger(row[name])&&row[name]>=0?row[name]:null;
 if(['followers_count','follows_count','media_count'].some(name=>count(name)===null))throw failure(502,'Instagram did not return all three profile counts. Check the token’s profile permissions.');
 return {id:String(row.user_id),username:row.username,name:String(row.name||row.username).slice(0,150),pictureUrl:safeImage(row.profile_picture_url),followers:count('followers_count'),following:count('follows_count'),posts:count('media_count')};
}
function createInstagramService({repository=store,env=process.env,fetchImpl=fetch,now=Date.now}={}){
 let queue=Promise.resolve(),inflight=null;
 const exclusive=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 const persist=(old,value)=>repository.save(value,old?.revision??null);
 const graph=async(path,token,params={})=>{
  const url=new URL(`https://graph.instagram.com/${path}`);Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
  let response,data;
  try{response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000),redirect:'error'});data=await response.json();}catch{throw failure(502,'Instagram could not be reached. Try again shortly.');}
  if(!response.ok||data.error)throw failure(422,Number(data.error?.code)===190?'The Instagram token has expired or was revoked. Generate and save a new token.':'Instagram rejected this connection. Use an Instagram Login token with instagram_business_basic access for a Business or Creator account.');
  return data;
 };
 const profile=token=>graph('v27.0/me',token,{fields}).then(normalize);
 const view=(row,admin=false)=>({enabled:row?.enabled!==false,profile:row?.enabled===false&&!admin?null:row?.profile||null,caption:row?.caption||'',website:row?.website||'',syncedAt:row?.syncedAt||null,stale:Boolean(row?.profile&&now()-new Date(row.syncedAt).getTime()>INTERVAL),...(admin?{connected:Boolean(row?.secret),encryptionConfigured:(()=>{try{key(env);return true;}catch{return false;}})(),expiresAt:row?.expiresAt||null,error:row?.error||''}:{})});
 const sync=async(force=false)=>{
  const old=await repository.load();
  if(!old?.secret||(!force&&!old.enabled))return old;
  if(!force&&now()-new Date(old.lastAttemptAt||0).getTime()< (old.error?RETRY:INTERVAL))return old;
  let secret=old.secret,tokenRefreshedAt=old.tokenRefreshedAt,expiresAt=old.expiresAt;
  try{
   let token=unseal(secret,env);
   if(now()-new Date(tokenRefreshedAt||0).getTime()>WEEK){
    // Instagram's long-lived token refresh endpoint is unversioned.
    const renewed=await graph('refresh_access_token',token,{grant_type:'ig_refresh_token',access_token:token});
    if(typeof renewed.access_token!=='string'||!renewed.access_token)throw failure(502,'Instagram did not renew the access token. Save a new token.');
    token=renewed.access_token;secret=seal(token,env);tokenRefreshedAt=new Date(now());
    expiresAt=Number.isFinite(renewed.expires_in)?new Date(now()+renewed.expires_in*1000):null;
   }
   const next=await profile(token);
   return await persist(old,{...old,secret,tokenRefreshedAt,expiresAt,profile:next,syncedAt:new Date(now()),lastAttemptAt:new Date(now()),error:''});
  }catch(error){
   if(error.status===409)throw error;
   const message=error.status?error.message:'Instagram could not update. Try again shortly.';
   const saved=await persist(old,{...old,secret,tokenRefreshedAt,expiresAt,lastAttemptAt:new Date(now()),error:message});
   if(force)throw failure(error.status||502,message);return saved;
  }
 };
 return {
  async publicProfile(){if(!inflight)inflight=exclusive(()=>sync()).finally(()=>{inflight=null;});return view(await inflight);},
  async status(){return view(await repository.load(),true);},
  save:body=>exclusive(async()=>{
   const parsed=schema.safeParse(body);if(!parsed.success)throw failure(400,parsed.error.issues[0]?.message||'Check the Instagram settings.');
   const old=await repository.load(),{accessToken,...settings}=parsed.data;
   if(!old?.secret&&!accessToken)throw failure(400,'Enter an Instagram access token to connect your account.');
   const secret=accessToken?seal(accessToken,env):old.secret;
   // Verify a replacement before changing the saved account or publishing it.
   const verified=accessToken?await profile(accessToken):old.profile;
   return view(await persist(old,{...old,...settings,secret,profile:verified,...(accessToken?{syncedAt:new Date(now()),lastAttemptAt:new Date(now()),tokenRefreshedAt:new Date(now()),expiresAt:null,error:''}:{})}),true);
  }),
  // For publishing: the saved account's id and its decrypted token (never sent to a client).
  async credentials(){const row=await repository.load();if(!row?.secret||!row.profile?.id)throw failure(409,'Connect Instagram in the admin first (Instagram settings).');return {userId:row.profile.id,username:row.profile.username,token:unseal(row.secret,env)};},
  refresh:()=>exclusive(async()=>view(await sync(true),true)),
  disconnect:()=>exclusive(async()=>{const old=await repository.load();if(!old)return view(null,true);return view(await persist(old,{secret:'',profile:null,enabled:false,caption:old.caption,website:old.website,syncedAt:null,lastAttemptAt:null,tokenRefreshedAt:null,expiresAt:null,error:''}),true);}),
 };
}
function registerInstagramProfile(app,{requireAdmin,...options}){
 const service=createInstagramService(options);
 const route=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({item:await fn(req)});}catch(error){res.status(error.status||503).json({message:error.status?error.message:'Instagram settings are temporarily unavailable.'});}};
 app.get('/api/instagram/profile',route(()=>service.publicProfile()));
 app.get('/api/admin/instagram',requireAdmin,route(()=>service.status()));
 app.put('/api/admin/instagram',requireAdmin,route(req=>service.save(req.body)));
 app.post('/api/admin/instagram/refresh',requireAdmin,route(()=>service.refresh()));
 app.delete('/api/admin/instagram',requireAdmin,route(()=>service.disconnect()));
 return service;
}
module.exports={registerInstagramProfile,createInstagramService};
