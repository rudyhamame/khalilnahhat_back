const mongoose=require('mongoose');
const {z}=require('zod');
const defaults=require('../contracts/setup-catalog.json');
const {ServicePrice}=require('./models');
const {Equipment}=require('./equipment');
const Entry=mongoose.models.SetupCatalogEntry||mongoose.model('SetupCatalogEntry',new mongoose.Schema({
 key:{type:String,unique:true,required:true},value:mongoose.Schema.Types.Mixed,
},{timestamps:true}));
const slug=z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const image=z.string().trim().max(2048).refine(value=>!value||value.startsWith('/echo/')||/^https:\/\//i.test(value),'Use an HTTPS image URL.');
const fields={
 name:z.string().trim().min(1).max(160),nameAr:z.string().trim().max(160).default(''),
 description:z.string().trim().max(2000).default(''),descriptionAr:z.string().trim().max(2000).default(''),
 imageUrl:image.default(''),category:z.string().trim().max(80).regex(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/).default(''),
 bookingType:z.enum(['wedding','engagement','birthday','corporate','party','graduation','other']).default('other'),
 equipmentIds:z.array(z.string().min(1).max(160)).max(100).default([]),
 isActive:z.boolean().default(true),sortOrder:z.number().int().min(0).max(10000).default(0),
};
const input=z.object({id:slug,kind:z.enum(['event','service']),...fields}).strict();
async function list(admin=false){
 const rows=await Entry.find().lean(),merged=new Map(defaults.map(row=>[row.kind+':'+row.id,row]));
 for(const row of rows)merged.set(row.key,row.value);
 return [...merged.values()].filter(row=>admin||row.isActive).sort((a,b)=>a.sortOrder-b.sortOrder||a.name.localeCompare(b.name));
}
function registerSetupCatalog(app,{requireAdmin}){
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(error){const status=error instanceof z.ZodError?400:error.code===11000?409:500;res.status(status).json({message:error instanceof z.ZodError?error.issues[0].message:status===409?'This item ID already exists.':'Could not save or load the setup catalog.'});if(status===500)console.error('Setup catalog failed',error.name,error.code||'');}};
 app.get('/api/setup-catalog',wrap(async(_req,res)=>res.set('Cache-Control','no-store').json({items:await list()})));
 app.get('/api/admin/setup-catalog',requireAdmin,wrap(async(_req,res)=>res.set('Cache-Control','no-store').json({items:await list(true)})));
 const save=async(req,res,creating)=>{
  const value=input.parse(creating?req.body:{...req.body,id:req.params.id,kind:req.params.kind});
  const key=value.kind+':'+value.id,current=(await list(true)).find(row=>row.kind===value.kind&&row.id===value.id);
  if(creating&&current)return res.status(409).json({message:'This item ID already exists.'});
  if(!creating&&!current)return res.status(404).json({message:'Catalog item not found.'});
  if(value.kind==='service'&&!value.category)return res.status(400).json({message:'Choose an equipment category for this service.'});
  if(value.equipmentIds.length&&await Equipment.countDocuments({slug:{$in:[...new Set(value.equipmentIds)]}})!==new Set(value.equipmentIds).size)return res.status(400).json({message:'Choose existing equipment items.'});
  const item={...value,equipmentIds:[...new Set(value.equipmentIds)],priceId:value.kind==='service'?'service-'+value.id:''};
  if(value.kind==='service')await ServicePrice.updateOne({serviceId:item.priceId},{$set:{name:item.name,category:'Service'},$setOnInsert:{amountCents:0,currency:'CAD',isActive:true}},{upsert:true});
  if(creating)await Entry.create({key,value:item});else await Entry.updateOne({key},{$set:{value:item}},{upsert:true});
  res.status(creating?201:200).json({item});
 };
 app.post('/api/admin/setup-catalog',requireAdmin,wrap((req,res)=>save(req,res,true)));
 app.put('/api/admin/setup-catalog/:kind/:id',requireAdmin,wrap((req,res)=>save(req,res,false)));
}
module.exports={registerSetupCatalog,list};
