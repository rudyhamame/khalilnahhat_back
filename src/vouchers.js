const mongoose=require('mongoose');
// Owner-controlled vouchers for clients who book online. One discount per booking; redemptions record which client used which voucher.
const Voucher=mongoose.models.Voucher||mongoose.model('Voucher',new mongoose.Schema({
 code:{type:String,required:true,unique:true,uppercase:true,trim:true},
 title:{type:String,default:'',maxlength:80},
 description:{type:String,default:'',maxlength:200},
 kind:{type:String,enum:['amount','percent'],required:true},
 amountCents:{type:Number,default:0,min:0,max:100000000},
 percent:{type:Number,default:0,min:0,max:100},
 startsAt:{type:Date,default:null},
 endsAt:{type:Date,default:null},
 maxRedemptions:{type:Number,default:0,min:0},
 perClientLimit:{type:Number,default:1,min:1,max:100},
 redeemed:{type:Number,default:0,min:0},
 active:{type:Boolean,default:true},
 announce:{type:Boolean,default:false},
},{timestamps:true}));
const Redemption=mongoose.models.VoucherRedemption||mongoose.model('VoucherRedemption',new mongoose.Schema({
 voucherId:{type:mongoose.Schema.Types.ObjectId,ref:'Voucher',required:true,index:true},
 code:{type:String,required:true},
 userId:{type:mongoose.Schema.Types.ObjectId,required:true,index:true},
 customerName:{type:String,default:''},
 customerEmail:{type:String,default:''},
 requestId:{type:String,default:''},
 requestNumber:{type:String,default:''},
 kind:{type:String,enum:['amount','percent']},
 amountCents:{type:Number,default:0},
 percent:{type:Number,default:0},
},{timestamps:true}));

const normalizeCode=value=>String(value||'').trim().toUpperCase();
const CODE=/^[A-Z0-9][A-Z0-9-]{2,23}$/;
const publicVoucher=v=>({code:v.code,title:v.title||'',description:v.description||'',kind:v.kind,amountCents:v.amountCents||0,percent:v.percent||0,endsAt:v.endsAt||null});
const adminVoucher=v=>({id:String(v._id),code:v.code,title:v.title||'',description:v.description||'',kind:v.kind,amountCents:v.amountCents||0,percent:v.percent||0,startsAt:v.startsAt||null,endsAt:v.endsAt||null,maxRedemptions:v.maxRedemptions||0,perClientLimit:v.perClientLimit||1,redeemed:v.redeemed||0,active:Boolean(v.active),announce:Boolean(v.announce),createdAt:v.createdAt});
const currentWindow=(v,now=new Date())=>(!v.startsAt||v.startsAt<=now)&&(!v.endsAt||v.endsAt>=now);
const used=v=>!v.maxRedemptions||v.redeemed<v.maxRedemptions?false:true;

// Is this voucher usable by this client right now? Returns {voucher} or {error}.
async function evaluate(code,userId,now=new Date()){
 const normalized=normalizeCode(code);
 if(!CODE.test(normalized))return {error:'Enter a valid voucher code.'};
 const voucher=await Voucher.findOne({code:normalized});
 if(!voucher||!voucher.active||!currentWindow(voucher,now))return {error:'This voucher is not valid.'};
 if(used(voucher))return {error:'This voucher has been fully redeemed.'};
 if(userId&&await Redemption.countDocuments({voucherId:voucher._id,userId})>=voucher.perClientLimit)return {error:'You have already used this voucher.'};
 return {voucher};
}
// Claim one use atomically; release() undoes it when the booking could not be saved.
async function reserve(code,user){
 const checked=await evaluate(code,user._id);
 if(checked.error)return checked;
 const claimed=await Voucher.findOneAndUpdate({_id:checked.voucher._id,active:true,$or:[{maxRedemptions:0},{$expr:{$lt:['$redeemed','$maxRedemptions']}}]},{$inc:{redeemed:1}},{new:true});
 return claimed?{voucher:claimed}:{error:'This voucher has been fully redeemed.'};
}
const release=voucher=>Voucher.updateOne({_id:voucher._id,redeemed:{$gt:0}},{$inc:{redeemed:-1}});
const snapshot=v=>({code:v.code,title:v.title||'',kind:v.kind,amountCents:v.amountCents||0,percent:v.percent||0});
const record=(voucher,user,request)=>Redemption.create({voucherId:voucher._id,code:voucher.code,userId:user._id,customerName:`${user.firstName||''} ${user.lastName||''}`.trim(),customerEmail:user.email||'',requestId:request.externalId||'',requestNumber:request.requestNumber||'',kind:voucher.kind,amountCents:voucher.amountCents||0,percent:voucher.percent||0});

function parseBody(body,{partial=false}={}){
 const out={},bad=message=>({error:message});
 const has=key=>body&&Object.hasOwn(body,key);
 if(!partial||has('code')){const code=normalizeCode(body?.code);if(!CODE.test(code))return bad('Code must be 3–24 letters, numbers or dashes.');out.code=code;}
 if(!partial||has('kind')){if(!['amount','percent'].includes(body?.kind))return bad('Choose a fixed amount or a percentage.');out.kind=body.kind;}
 for(const key of ['title','description']){if(has(key)){if(typeof body[key]!=='string'||body[key].length>(key==='title'?80:200))return bad(`${key} is too long.`);out[key]=body[key].trim();}}
 if(has('amountCents')){if(!Number.isInteger(body.amountCents)||body.amountCents<0||body.amountCents>100000000)return bad('Enter a valid amount.');out.amountCents=body.amountCents;}
 if(has('percent')){if(typeof body.percent!=='number'||!(body.percent>=0&&body.percent<=100))return bad('Percentage must be 0–100.');out.percent=body.percent;}
 for(const key of ['startsAt','endsAt']){if(has(key)){if(body[key]===null||body[key]==='')out[key]=null;else{const d=new Date(body[key]);if(Number.isNaN(d.getTime()))return bad('Enter valid dates.');out[key]=d;}}}
 for(const key of ['maxRedemptions','perClientLimit']){if(has(key)){if(!Number.isInteger(body[key])||body[key]<(key==='perClientLimit'?1:0)||body[key]>1000000)return bad(`Enter a valid ${key==='perClientLimit'?'per-client limit':'maximum'}.`);out[key]=body[key];}}
 for(const key of ['active','announce']){if(has(key)){if(typeof body[key]!=='boolean')return bad(`${key} must be true or false.`);out[key]=body[key];}}
 const kind=out.kind;
 if(!partial){if(kind==='amount'&&!(out.amountCents>0))return bad('Enter an amount above zero.');if(kind==='percent'&&!(out.percent>0))return bad('Enter a percentage above zero.');}
 if(out.startsAt&&out.endsAt&&out.endsAt<out.startsAt)return bad('The end date must be after the start date.');
 return {data:out};
}

function registerVouchers(app,{requireAdmin,requireAuth}){
 // Public: the voucher announced on the home page (at most one).
 app.get('/api/vouchers/announcement',async(_req,res)=>{
  try{
   const now=new Date(),list=await Voucher.find({active:true,announce:true}).sort({updatedAt:-1}).limit(10);
   const voucher=list.find(v=>currentWindow(v,now)&&!used(v));
   res.set('Cache-Control','no-store').json({voucher:voucher?publicVoucher(voucher):null});
  }catch{res.json({voucher:null});}
 });
 // Signed-in client: check a code before booking.
 app.post('/api/vouchers/validate',requireAuth,async(req,res)=>{
  try{const result=await evaluate(req.body?.code,req.authUser._id);if(result.error)return res.status(400).json({valid:false,message:result.error});res.json({valid:true,voucher:publicVoucher(result.voucher)});}
  catch{res.status(503).json({message:'Vouchers are temporarily unavailable.'});}
 });
 app.get('/api/admin/vouchers',requireAdmin,async(_req,res)=>{
  try{res.set('Cache-Control','no-store').json({items:(await Voucher.find().sort({createdAt:-1}).limit(500)).map(adminVoucher)});}
  catch{res.status(503).json({message:'Vouchers are temporarily unavailable.'});}
 });
 app.post('/api/admin/vouchers',requireAdmin,async(req,res)=>{
  const parsed=parseBody(req.body);if(parsed.error)return res.status(400).json({message:parsed.error});
  try{const item=await Voucher.create(parsed.data);res.status(201).json({item:adminVoucher(item)});}
  catch(error){res.status(error.code===11000?409:503).json({message:error.code===11000?'That code already exists.':'Could not save the voucher.'});}
 });
 app.patch('/api/admin/vouchers/:id',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({message:'Voucher not found.'});
  const parsed=parseBody(req.body,{partial:true});if(parsed.error)return res.status(400).json({message:parsed.error});
  try{const item=await Voucher.findByIdAndUpdate(req.params.id,{$set:parsed.data},{new:true,runValidators:true});if(!item)return res.status(404).json({message:'Voucher not found.'});res.json({item:adminVoucher(item)});}
  catch(error){res.status(error.code===11000?409:503).json({message:error.code===11000?'That code already exists.':'Could not save the voucher.'});}
 });
 // Vouchers that were used are kept (deactivate instead); unused ones can be deleted.
 app.delete('/api/admin/vouchers/:id',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({message:'Voucher not found.'});
  try{
   if(await Redemption.exists({voucherId:req.params.id}))return res.status(409).json({message:'This voucher has been used. Deactivate it instead of deleting it.'});
   const gone=await Voucher.findByIdAndDelete(req.params.id);if(!gone)return res.status(404).json({message:'Voucher not found.'});res.json({deleted:true});
  }catch{res.status(503).json({message:'Could not delete the voucher.'});}
 });
 app.get('/api/admin/vouchers/:id/redemptions',requireAdmin,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({message:'Voucher not found.'});
  try{const rows=await Redemption.find({voucherId:req.params.id}).sort({createdAt:-1}).limit(1000).lean();res.set('Cache-Control','no-store').json({items:rows.map(row=>({id:String(row._id),customerName:row.customerName,customerEmail:row.customerEmail,requestNumber:row.requestNumber,requestId:row.requestId,kind:row.kind,amountCents:row.amountCents,percent:row.percent,usedAt:row.createdAt}))});}
  catch{res.status(503).json({message:'Could not load redemptions.'});}
 });
}
module.exports={registerVouchers,reserve,release,record,snapshot,evaluate,Voucher,Redemption};
