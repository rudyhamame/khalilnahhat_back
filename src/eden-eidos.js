const mongoose=require('mongoose');
const {randomUUID}=require('node:crypto');
const {z}=require('zod');

// Eidos keeps an immutable identity and its fourth goal. Removing a view never deletes the seed.
const schema=new mongoose.Schema({externalId:{type:String,required:true,unique:true,immutable:true,default:()=>`eidos-${randomUUID()}`},fourthGoal:{type:String,default:'',maxlength:2000},hiddenFromMap:{type:Boolean,default:false}},{strict:'throw',versionKey:false});
const Eidos=mongoose.models.EdenEidos||mongoose.model('EdenEidos',schema);
const publicView=row=>({id:row.externalId,fourthGoal:row.fourthGoal||'',...(row.hiddenFromMap?{removed:true}:{})});
const fourthGoal=z.string().trim().max(2000,'Fourth goal must be 2000 characters or fewer.');
const input=z.object({fourthGoal:fourthGoal.default('')}).strict();
const updateInput=z.object({fourthGoal,previousFourthGoal:z.string().max(2000)}).strict();
async function ensureBooking(){
 await Eidos.init();
 await Eidos.updateOne({externalId:'booking'},{$setOnInsert:{externalId:'booking'}},{upsert:true});
}
function registerEidos(app,{requireAdmin}){
 const wrap=fn=>async(req,res)=>{
  try{res.set('Cache-Control','no-store');await fn(req,res);}
  catch(error){const status=error instanceof z.ZodError?400:error.status||503;res.status(status).json({message:status===400?error.issues[0].message:status<500?error.message:'Eidos could not be loaded or saved. Please retry.'});}
 };
 app.get('/api/admin/eden/eidos',requireAdmin,wrap(async(req,res)=>{
  await ensureBooking();
  const {includeRemoved}=z.object({includeRemoved:z.literal('1').optional()}).strict().parse(req.query);
  res.json({items:(await Eidos.find(includeRemoved?{}:{hiddenFromMap:{$ne:true}}).sort({_id:1}).lean()).map(publicView)});
 }));
 app.post('/api/admin/eden/eidos',requireAdmin,wrap(async(req,res)=>{
  const value=input.parse(req.body);await ensureBooking();
  const row=await Eidos.create(value);
  res.status(201).json({item:publicView(row)});
 }));
 app.put('/api/admin/eden/eidos/:id',requireAdmin,wrap(async(req,res)=>{
  const {fourthGoal,previousFourthGoal}=updateInput.parse(req.body);
  const expected=previousFourthGoal===''?{$or:[{fourthGoal:''},{fourthGoal:{$exists:false}}]}:{fourthGoal:previousFourthGoal};
  const row=await Eidos.findOneAndUpdate({externalId:req.params.id,...expected},{$set:{fourthGoal}},{returnDocument:'after',runValidators:true}).lean();
  if(!row){const exists=await Eidos.exists({externalId:req.params.id});throw Object.assign(new Error(exists?'This seed changed. Reload Eidos before saving again.':'Eidos not found.'),{status:exists?409:404});}
  res.json({item:publicView(row)});
 }));
 // Exact-ID lookup remains available even after an item is removed from the map.
 app.get('/api/admin/eden/eidos/:id',requireAdmin,wrap(async(req,res)=>{
  const row=await Eidos.findOne({externalId:req.params.id}).lean();
  if(!row)throw Object.assign(new Error('Eidos not found.'),{status:404});
  res.json({item:publicView(row)});
 }));
 app.delete('/api/admin/eden/eidos/:id',requireAdmin,wrap(async(req,res)=>{
  const {previousFourthGoal}=z.object({previousFourthGoal:z.string().max(2000)}).strict().parse(req.body);
  const expected=previousFourthGoal===''?{$or:[{fourthGoal:''},{fourthGoal:{$exists:false}}]}:{fourthGoal:previousFourthGoal};
  const row=await Eidos.findOneAndUpdate({externalId:req.params.id,...expected},{$set:{hiddenFromMap:true}},{returnDocument:'after'}).lean();
  if(!row){const exists=await Eidos.exists({externalId:req.params.id});throw Object.assign(new Error(exists?'This seed changed. Reload Eidos before deleting.':'Eidos not found.'),{status:exists?409:404});}
  res.json({item:publicView(row)});
 }));
 app.post('/api/admin/eden/eidos/:id/restore',requireAdmin,wrap(async(req,res)=>{
  z.object({}).strict().parse(req.body);
  const row=await Eidos.findOneAndUpdate({externalId:req.params.id},{$set:{hiddenFromMap:false}},{returnDocument:'after'}).lean();
  if(!row)throw Object.assign(new Error('Eidos not found.'),{status:404});
  res.json({item:publicView(row)});
 }));
 // No operation physically deletes a seed's identity or its fourth goal.
}
module.exports={Eidos,registerEidos};
