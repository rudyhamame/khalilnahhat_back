const crypto=require('crypto');
const {Readable}=require('stream');
const fs=require('fs');
const mongoose=require('mongoose');
// Which administrators downloaded the app (shown next to their name in the team chat).
const Download=mongoose.models.EchoAndroidDownload||mongoose.model('EchoAndroidDownload',new mongoose.Schema({_id:String,at:Date,version:String},{versionKey:false}));
const downloadedIds=async()=>(await Download.find().select('_id').lean()).map(d=>d._id);
const {sendBrevoEmail}=require('./brevo');
// Admin-only Android app delivery: an admin asks for a link, sent to the email on their own account; the link carries a signed 24 h token and streams the APK from ANDROID_APK_URL.
// The APK lives on the persistent music-archive volume (no extra mount); ANDROID_APK_URL is an alternative source.
const apkPath=()=>process.env.ANDROID_APK_PATH||'/app/data/music-archive/android/EchoDJ.apk';
// Latest build info: version.txt sits next to the APK (written when a new build is uploaded).
const info=()=>{try{const st=fs.statSync(apkPath());let v='';try{v=fs.readFileSync(require('path').join(require('path').dirname(apkPath()),'version.txt'),'utf8').trim();}catch{}return{version:v,size:st.size,updatedAt:st.mtime};}catch{return null;}};
const hasApk=()=>Boolean(process.env.ANDROID_APK_URL)||fs.existsSync(apkPath());
const secret=()=>process.env.ANDROID_LINK_SECRET||process.env.CLOUDINARY_API_SECRET||'';
const sign=p=>crypto.createHmac('sha256',secret()).update(p).digest('base64url');
const make=(email,uid='')=>{const p=Buffer.from(JSON.stringify({e:email,u:uid,x:Date.now()+864e5})).toString('base64url');return p+'.'+sign(p);};
const claims=t=>{try{return JSON.parse(Buffer.from(String(t).split('.')[0],'base64url'));}catch{return {};}};
const who=t=>claims(t).e||'';
const check=t=>{const[p,s]=String(t||'').split('.');if(!p||!s||!secret())return false;const a=Buffer.from(sign(p)),b=Buffer.from(s);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false;try{return JSON.parse(Buffer.from(p,'base64url')).x>Date.now();}catch{return false;}};
function register(app,{requireAdmin}){
 const rate=new Map();
 app.get('/api/admin/android/info',requireAdmin,(req,res)=>res.json(info()||{}));
 app.post('/api/admin/android/send-link',requireAdmin,async(req,res)=>{
  const email=String(req.user.email||'').trim().toLowerCase();
  if(!email)return res.status(400).json({error:'Your administrator account has no email address.'});
  if(!hasApk()||!secret())return res.status(503).json({error:'The Android app is not published yet.'});
  const k=String(req.user._id||req.user.id),n=(rate.get(k)||[]).filter(t=>Date.now()-t<36e5);if(n.length>=5)return res.status(429).json({error:'Too many requests. Try again later.'});rate.set(k,[...n,Date.now()]);
  const base=process.env.API_PUBLIC_URL||`${req.get('x-forwarded-proto')||req.protocol}://${req.get('host')}`;
  const link=`${base.replace(/\/+$/,'')}/api/android/download?t=${make(email,k)}`;
  try{await sendBrevoEmail({to:[{email}],subject:'Echo DJ for Android — your download link',tags:['android-app'],htmlContent:`<p>Here is your Echo DJ administrator app for Android${info()?.version?' (version '+info().version+')':''}.</p><p><a href="${link}">Download the app</a></p><p>The link works for 24 hours. On your phone, allow installing from your browser when asked.</p>`},{env:{...process.env,DOMAIN_EMAIL_ACTIVE:'true'}});}// forces the noreply sender
  catch{return res.status(502).json({error:'The email could not be sent.'});}
  res.json({ok:true});
 });
 // Public: the Echo Event client app (separate file on the same volume), for the badge on the home page.
 const clientPath=()=>require('path').join(require('path').dirname(apkPath()),'EchoEvent.apk');
 app.get('/api/android/client',(req,res)=>{
  let st;try{st=fs.statSync(clientPath());}catch{return res.status(404).send('The app is not published yet.');}
  res.set({'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="EchoEvent.apk"','Content-Length':String(st.size),'Cache-Control':'public, max-age=300'});
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(clientPath()).pipe(res);
 });
 app.get('/api/android/download',async(req,res)=>{
  if(!check(req.query.t))return res.status(403).send('This link is invalid or has expired.');
  const head={'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="EchoDJ.apk"','Cache-Control':'private, no-store'};
  let stream,len;
  if(fs.existsSync(apkPath())){len=fs.statSync(apkPath()).size;stream=fs.createReadStream(apkPath());}
  else{const r=await fetch(process.env.ANDROID_APK_URL||'http://invalid.local').catch(()=>null);if(!r?.ok||!r.body)return res.status(502).send('The app is unavailable right now.');len=r.headers.get('content-length');stream=Readable.fromWeb(r.body);}
  const uid=claims(req.query.t).u;if(uid)Download.updateOne({_id:uid},{$set:{at:new Date(),version:info()?.version||''}},{upsert:true}).catch(()=>{});
  require('./admin-alerts').alert('download',`${who(req.query.t)} downloaded the Android app.`);
  res.set(head);if(len)res.set('Content-Length',String(len));
  stream.pipe(res);
 });
}
module.exports={register,make,check,downloadedIds};
