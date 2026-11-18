const crypto=require('crypto');
const {Readable}=require('stream');
const {sendSimpleEmail}=require('./brevo');
// Admin-only Android app delivery: an admin asks for a link by email; the link carries a signed 24 h token and streams the APK from ANDROID_APK_URL.
const secret=()=>process.env.ANDROID_LINK_SECRET||process.env.CLOUDINARY_API_SECRET||'';
const sign=p=>crypto.createHmac('sha256',secret()).update(p).digest('base64url');
const make=email=>{const p=Buffer.from(JSON.stringify({e:email,x:Date.now()+864e5})).toString('base64url');return p+'.'+sign(p);};
const check=t=>{const[p,s]=String(t||'').split('.');if(!p||!s||!secret())return false;const a=Buffer.from(sign(p)),b=Buffer.from(s);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false;try{return JSON.parse(Buffer.from(p,'base64url')).x>Date.now();}catch{return false;}};
function register(app,{requireAdmin}){
 const rate=new Map();
 app.post('/api/admin/android/send-link',requireAdmin,async(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase();
  if(!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email))return res.status(400).json({error:'Enter a valid email address.'});
  if(!process.env.ANDROID_APK_URL||!secret())return res.status(503).json({error:'The Android app is not published yet.'});
  const k=String(req.user._id||req.user.id),n=(rate.get(k)||[]).filter(t=>Date.now()-t<36e5);if(n.length>=5)return res.status(429).json({error:'Too many requests. Try again later.'});rate.set(k,[...n,Date.now()]);
  const base=process.env.API_PUBLIC_URL||`${req.get('x-forwarded-proto')||req.protocol}://${req.get('host')}`;
  const link=`${base.replace(/\/+$/,'')}/api/android/download?t=${make(email)}`;
  try{await sendSimpleEmail({to:email,subject:'Echo DJ for Android — your download link',tags:['android-app'],html:`<p>Here is your Echo DJ administrator app for Android.</p><p><a href="${link}">Download the app</a></p><p>The link works for 24 hours. On your phone, allow installing from your browser when asked.</p>`});}
  catch{return res.status(502).json({error:'The email could not be sent.'});}
  res.json({ok:true});
 });
 app.get('/api/android/download',async(req,res)=>{
  if(!check(req.query.t))return res.status(403).send('This link is invalid or has expired.');
  const r=await fetch(process.env.ANDROID_APK_URL).catch(()=>null);
  if(!r?.ok||!r.body)return res.status(502).send('The app is unavailable right now.');
  res.set({'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="EchoDJ.apk"','Cache-Control':'private, no-store'});
  const len=r.headers.get('content-length');if(len)res.set('Content-Length',len);
  Readable.fromWeb(r.body).pipe(res);
 });
}
module.exports={register,make,check};
