const crypto=require('node:crypto');
const mongoose=require('mongoose');
const {z}=require('zod');
const Challenge=mongoose.models.AccountEmailChange||mongoose.model('AccountEmailChange',new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,required:true,unique:true},email:String,previousEmail:String,codeHash:String,
 attempts:{type:Number,default:0},sentAt:Date,expiresAt:{type:Date,expires:0},
},{versionKey:false}));
const address=z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
const hash=(id,email,code)=>crypto.createHash('sha256').update(`${id}:${email}:${code}`).digest('hex');
function register(app,{authFromRequest,User,serializeUser,sendMail,now=Date.now,randomCode=()=>String(crypto.randomInt(100000,1000000))}){
 const wrap=handler=>async(req,res)=>{try{
  const user=await authFromRequest(req);if(!user||user.isBlocked)return res.status(401).json({message:'Sign in to change your email address.'});
  res.set('Cache-Control','no-store');await handler(req,res,user);
 }catch(error){const status=error instanceof z.ZodError?400:error.code===11000?409:error.status||503;res.status(status).json({message:status===400?error.issues?.[0]?.message||error.message:error.code===11000?'This email address is already in use.':status<500?error.message:'Email could not be updated. Please try again.'});}};
 const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
 app.post('/api/auth/profile/email/start',wrap(async(req,res,user)=>{
  const {email}=z.object({email:address}).strict().parse(req.body);
  if(email===user.email.toLowerCase())return fail('Enter a different email address.');
  if(await User.exists({email}).collation({locale:'en',strength:2}))return fail('This email address is already in use.',409);
  await Promise.all([User.init(),Challenge.init()]);
  const code=randomCode(),codeHash=hash(user._id,email,code),at=new Date(now());
  let challenge;
  try{challenge=await Challenge.findOneAndUpdate({userId:user._id,$or:[{sentAt:{$lte:new Date(now()-60000)}},{sentAt:{$exists:false}}]},{$set:{email,previousEmail:user.email,codeHash,attempts:0,sentAt:at,expiresAt:new Date(now()+600000)}},{upsert:true,returnDocument:'after'});}
  catch(error){if(error.code===11000)return fail('Wait one minute before requesting another code.',429);throw error;}
  try{await sendMail({to:email,name:user.firstName,subject:'Confirm your new email — Echo Event Entertainment',tags:['account-email-change'],notificationContext:{code},html:`<p>Your code to change your Echo email address is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p>It expires in 10 minutes. If you did not request this change, ignore this email.</p>`});}
  catch(error){await Challenge.deleteOne({_id:challenge._id,codeHash});throw error;}
  res.status(202).json({pending:true,email,retryAfter:60});
 }));
 app.post('/api/auth/profile/email/verify',wrap(async(req,res,user)=>{
  const {email,code}=z.object({email:address,code:z.string().trim().regex(/^\d{6}$/,'Enter the 6-digit code.')}).strict().parse(req.body);
  const row=await Challenge.findOneAndUpdate({userId:user._id,email,previousEmail:user.email,expiresAt:{$gt:new Date(now())},attempts:{$lt:5}},{$inc:{attempts:1}},{returnDocument:'after'}).lean();
  if(!row)return fail('This code expired or has too many attempts. Request a new code.');
  const given=Buffer.from(hash(user._id,email,code)),wanted=Buffer.from(row.codeHash);
  if(given.length!==wanted.length||!crypto.timingSafeEqual(given,wanted))return fail('That code is not right.');
  const session=await mongoose.startSession();let updated;
  try{await session.withTransaction(async()=>{
   const consumed=await Challenge.deleteOne({_id:row._id,codeHash:row.codeHash,attempts:{$lte:5},expiresAt:{$gt:new Date(now())}},{session});
   if(consumed.deletedCount!==1)return fail('This code has already been used.');
   updated=await User.findOneAndUpdate({_id:user._id,email:row.previousEmail,isBlocked:{$ne:true}},{$set:{email,emailVerified:true,verifyTokenHash:'',verifyExpires:null,resetTokenHash:'',resetExpires:null}},{session,returnDocument:'after'});
   if(!updated)return fail('Your account changed. Request a new code.',409);
  });}finally{await session.endSession();}
  res.json({user:serializeUser(updated)});
 }));
}
module.exports={register,Challenge};
