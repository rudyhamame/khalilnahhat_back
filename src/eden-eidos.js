const mongoose=require('mongoose');
const {randomUUID}=require('node:crypto');
const {z}=require('zod');

// An Eidos is only an identity seed. Labels, data and behavior belong to
// destinations that reference it, and removing a view never deletes this seed.
const schema=new mongoose.Schema({externalId:{type:String,required:true,unique:true,immutable:true,default:()=>`eidos-${randomUUID()}`}},{strict:'throw',versionKey:false});
const Eidos=mongoose.models.EdenEidos||mongoose.model('EdenEidos',schema);
const publicView=row=>({id:row.externalId});
const input=z.object({}).strict();
async function ensureBooking(){
 await Eidos.init();
 await Eidos.updateOne({externalId:'booking'},{$setOnInsert:{externalId:'booking'}},{upsert:true});
}
function registerEidos(app,{requireAdmin}){
 const wrap=fn=>async(req,res)=>{
  try{res.set('Cache-Control','no-store');await fn(req,res);}
  catch(error){const status=error instanceof z.ZodError?400:503;res.status(status).json({message:status===400?'An Eidos contains only a generated identity.':'Eidos could not be loaded or saved. Please retry.'});}
 };
 app.get('/api/admin/eden/eidos',requireAdmin,wrap(async(_req,res)=>{
  await ensureBooking();
  res.json({items:(await Eidos.find().sort({_id:1}).lean()).map(publicView)});
 }));
 app.post('/api/admin/eden/eidos',requireAdmin,wrap(async(req,res)=>{
  input.parse(req.body);await ensureBooking();
  const row=await Eidos.create({});
  res.status(201).json({item:publicView(row)});
 }));
 // Intentionally no delete endpoint: identity outlives its presentations.
}
module.exports={Eidos,registerEidos};
