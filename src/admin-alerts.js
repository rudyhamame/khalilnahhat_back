const mongoose=require('mongoose');
// Admin phone alerts. Each kind is a per-admin toggle; payloads are generic (no customer data).
const KINDS={booking:['New booking','A client sent a booking request.'],signup:['New account','A new guest created an account.'],visit:['Website visit','Someone is visiting the website.'],email:['New email','A new email arrived.']};
const DEFAULTS={booking:true,signup:true,visit:false,email:true};
// Visit History: one row per website visit (no IP address stored). Rows expire after 90 days.
const Visit=mongoose.models.EchoVisit||mongoose.model('EchoVisit',new mongoose.Schema({
 time:{type:Date,default:Date.now,expires:90*86400},device:String,os:String,browser:String,kind:String,userId:String,name:String,path:String,referrer:String,country:String,lang:String,visitor:String,
},{versionKey:false}));
const device=ua=>/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)?'Tablet':/Mobi|iPhone|iPod|Android.*Mobile/i.test(ua)?'Mobile':'Desktop';
const os=ua=>/Android/i.test(ua)?'Android':/iPhone|iPad|iPod/i.test(ua)?'iOS':/Windows/i.test(ua)?'Windows':/Mac OS X|Macintosh/i.test(ua)?'macOS':/CrOS/i.test(ua)?'ChromeOS':/Linux/i.test(ua)?'Linux':'Other';
const browser=ua=>/Edg\//i.test(ua)?'Edge':/OPR\/|Opera/i.test(ua)?'Opera':/SamsungBrowser/i.test(ua)?'Samsung Internet':/Firefox|FxiOS/i.test(ua)?'Firefox':/Chrome|CriOS/i.test(ua)?'Chrome':/Safari/i.test(ua)?'Safari':'Other';
const refHost=r=>{try{return r?new URL(r).hostname.replace(/^www\./,''):'';}catch{return '';}};
const Pref=mongoose.models.EchoAdminAlertPref||mongoose.model('EchoAdminAlertPref',new mongoose.Schema({_id:String,kinds:{type:Object,default:{}}},{minimize:false}));
let sender=null;const lastVisit={at:0};
const setSender=fn=>{sender=fn;};
const prefs=async owner=>({...DEFAULTS,...((await Pref.findById(owner).lean())?.kinds||{})});
const enabled=async(owner,kind)=>(await prefs(owner))[kind]===true;
// Fire-and-forget: an alert failure must never break the business request that triggered it.
const alert=kind=>{if(!sender||!KINDS[kind])return;Promise.resolve(sender(kind,...KINDS[kind])).catch(()=>{});};
function register(app,{requireAdmin,authFromRequest,base='/api/admin/alerts'}){
 const seen=new Map();// per-IP flood guard: at most 20 visit rows a minute
 app.get(base,requireAdmin,async(req,res)=>res.json({kinds:await prefs(String(req.user._id||req.user.id))}));
 app.put(base,requireAdmin,async(req,res)=>{const kinds={};for(const k of Object.keys(KINDS))if(typeof req.body?.[k]==='boolean')kinds[`kinds.${k}`]=req.body[k];
  const owner=String(req.user._id||req.user.id);await Pref.updateOne({_id:owner},{$set:kinds},{upsert:true});res.json({kinds:await prefs(owner)});});
 // Public beacon; the site sends it once per browser session. Pushes are collapsed to one per minute.
 app.post('/api/visit',async(req,res)=>{
  try{
   const ip=req.ip||'',minute=Math.floor(Date.now()/60000),hits=seen.get(ip);const n=hits?.minute===minute?hits.n+1:1;seen.set(ip,{minute,n});if(seen.size>5000)seen.clear();
   if(n<=20){
    const ua=String(req.get('user-agent')||'').slice(0,400),b=req.body||{},user=authFromRequest&&req.get('authorization')?await authFromRequest(req).catch(()=>null):null;
    const own=user&&!(user.isAdmin);// admins browsing their own site are not visitors
    if(!user||own){
     await Visit.create({device:device(ua),os:os(ua),browser:browser(ua),kind:user?'client':'guest',userId:user?String(user._id):'',name:user?[user.firstName,user.lastName].filter(Boolean).join(' ')||user.username:'',
      path:String(b.path||'').slice(0,200),referrer:refHost(String(b.referrer||'').slice(0,300)),country:String(req.get('cf-ipcountry')||'').slice(0,2),lang:String(b.lang||'').slice(0,20),
      visitor:require('node:crypto').createHash('sha256').update(ip+ua+new Date().toISOString().slice(0,10)).digest('hex').slice(0,12)});
     if(Date.now()-lastVisit.at>60000){lastVisit.at=Date.now();alert('visit');}
    }
   }
  }catch{}
  res.status(204).end();});
 // Newest first; `before` (ISO time) pages backwards. Summary counts are for the last 24 hours and all time.
 app.get('/api/admin/visits',requireAdmin,async(req,res)=>{
  const limit=Math.min(100,Math.max(1,Number(req.query.limit)||50)),before=req.query.before?new Date(String(req.query.before)):null,since=new Date(Date.now()-86400000);
  const q=before&&!Number.isNaN(+before)?{time:{$lt:before}}:{};
  const [items,total,today,unique,clients]=await Promise.all([Visit.find(q).sort({time:-1}).limit(limit).lean(),Visit.estimatedDocumentCount(),Visit.countDocuments({time:{$gte:since}}),Visit.distinct('visitor',{time:{$gte:since}}),Visit.countDocuments({time:{$gte:since},kind:'client'})]);
  res.json({items:items.map(v=>({id:String(v._id),time:v.time,device:v.device,os:v.os,browser:v.browser,kind:v.kind,name:v.name||'',path:v.path||'',referrer:v.referrer||'',country:v.country||'',lang:v.lang||''})),summary:{total,today,unique:unique.length,clients,guests:today-clients}});
 });
}
module.exports={alert,register,setSender,enabled,KINDS};
