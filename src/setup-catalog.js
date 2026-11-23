const permanentDeletion=require('./permanent-deletion');
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
 icon:z.enum(['','microphone','audio','disc','monitor','sparkles','lighting','building','box']).default(''),
 selectionField:z.enum(['','music.mcRequested','music.djRequested']).default(''),
 name:z.string().trim().min(1).max(160),nameAr:z.string().trim().max(160).default(''),
 description:z.string().trim().max(2000).default(''),descriptionAr:z.string().trim().max(2000).default(''),
 imageUrl:image.default(''),galleryImages:z.array(image.min(1)).max(12).default([]),category:z.string().trim().max(80).regex(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/).default(''),
 bookingType:z.enum(['wedding','engagement','birthday','corporate','party','graduation','other']).default('other'),
 equipmentIds:z.array(z.string().min(1).max(160)).max(100).default([]),
 isActive:z.boolean().default(true),sortOrder:z.number().int().min(0).max(10000).default(0),
};
// Only DJ Khalil Nahhat and the MC host are real services. Every other "service" entry is a Rental Equipment category (managed in Settings).
const CORE_SERVICES=['dj','mc'];
const input=z.object({id:slug,kind:z.enum(['event','service']),...fields}).strict();
// The catalog lives only in the database. The built-in services and event types are copied in once (an entry that already exists,
// edited or deleted, is never touched), then every read comes from the database, so nothing the admin deletes can come back.
let migrated=null;
function migrateDefaults(){
 if(!migrated)migrated=(async()=>{
  if(await Entry.exists({key:'_meta:defaults-v1'}))return;
  await Entry.bulkWrite(defaults.map(row=>({updateOne:{filter:{key:row.kind+':'+row.id},update:{$setOnInsert:{key:row.kind+':'+row.id,value:row}},upsert:true}})));
  await Entry.updateOne({key:'_meta:defaults-v1'},{$setOnInsert:{key:'_meta:defaults-v1',value:{migrated:true}}},{upsert:true});
 })().catch(error=>{migrated=null;throw error;});
 return migrated;
}
async function list(admin=false){
 await migrateDefaults();
 const rows=await Entry.find({key:{$not:/^_meta:/}}).lean();
 return rows.map(row=>row.value).filter(row=>row&&!row.deleted&&(admin||row.isActive)).sort((a,b)=>a.sortOrder-b.sortOrder||a.name.localeCompare(b.name));
}
// Services that were deleted keep only an id marker (plus the place they had); built-in ones can be restored from the contract defaults.
async function removedServices() {
  await migrateDefaults();
  const rows = await Entry.find({ key: /^service:/ }).lean();
  return rows.map((row) => row.value).filter((value) => value && value.deleted).map((value) => {
    const base = defaults.find((row) => row.kind === 'service' && row.id === value.id);
    return { id: value.id, name: base?.name || '', restorable: Boolean(base), sortOrder: value.sortOrder };
  });
}
function registerSetupCatalog(app,{requireAdmin}){
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(error){const status=error instanceof z.ZodError?400:error.code===11000?409:500;res.status(status).json({message:error instanceof z.ZodError?error.issues[0].message:status===409?'This item ID already exists.':'Could not save or load the setup catalog.'});if(status===500)console.error('Setup catalog failed',error.name,error.code||'');}};
 app.get('/api/setup-catalog',wrap(async(_req,res)=>res.set('Cache-Control','no-store').json({items:await list()})));
 app.get('/api/admin/setup-catalog',requireAdmin,wrap(async(_req,res)=>res.set('Cache-Control','no-store').json({items:await list(true)})));
 const save=async(req,res,creating,allowRental=false)=>{
  const value=input.parse(creating?req.body:{...req.body,id:req.params.id,kind:req.params.kind});
  const key=value.kind+':'+value.id,current=(await list(true)).find(row=>row.kind===value.kind&&row.id===value.id);
  if(creating&&value.kind==='service'&&!allowRental&&!CORE_SERVICES.includes(value.id))return res.status(400).json({message:'Only DJ Khalil Nahhat and MC host are services. Add a Rental Equipment category in Settings instead.'});
  if(creating&&current)return res.status(409).json({message:'This item ID already exists.'});
  if(!creating&&!current)return res.status(404).json({message:'Catalog item not found.'});
  if(value.kind==='service'&&!value.category)value.category=value.id; // equipment now points at the service id; category is only a legacy label
  if(value.equipmentIds.length&&await Equipment.countDocuments({slug:{$in:[...new Set(value.equipmentIds)]}})!==new Set(value.equipmentIds).size)return res.status(400).json({message:'Choose existing equipment items.'});
  const item={...value,equipmentIds:[...new Set(value.equipmentIds)],priceId:value.kind==='service'?'service-'+value.id:''};
  if(value.kind==='service')await ServicePrice.updateOne({serviceId:item.priceId},{$set:{name:item.name,category:'Service'},$setOnInsert:{amountCents:0,currency:'CAD',isActive:true}},{upsert:true});
  if(creating){const prior=await Entry.findOne({key}).lean();if(prior)await Entry.updateOne({key},{$set:{value:item}});else await Entry.create({key,value:item});}else await Entry.updateOne({key},{$set:{value:item}},{upsert:true});
  res.status(creating?201:200).json({item});
 };
 app.post('/api/admin/setup-catalog',requireAdmin,wrap((req,res)=>save(req,res,true)));
 app.put('/api/admin/setup-catalog/:kind/:id',requireAdmin,wrap((req,res)=>save(req,res,false)));
 // Deleted services keep only a marker. Built-in ones (the contract defaults) can be restored with their original content; the rest must be re-added by hand.
 app.get('/api/admin/setup-catalog/deleted',requireAdmin,wrap(async(_req,res)=>{
  const items=await removedServices();
  const equipment=(await require('./equipment').EquipmentTombstone.find().sort({slug:1}).lean()).map(row=>({id:row.slug,serviceId:row.serviceId||''}));
  res.set('Cache-Control','no-store').json({items,equipment});
 }));
 app.post('/api/admin/setup-catalog/service/:id/restore',requireAdmin,wrap(async(req,res)=>{
  const id=slug.safeParse(req.params.id);if(!id.success)return res.status(400).json({message:'Invalid service ID.'});
  const marker=await Entry.findOne({key:`service:${id.data}`}).lean();
  if(!marker?.value?.deleted)return res.status(404).json({message:'This service is not deleted.'});
  const base=defaults.find(row=>row.kind==='service'&&row.id===id.data);
  if(!base)return res.status(400).json({message:'No saved content for this service. Add it again by hand.'});
  const body=Object.fromEntries(['id','kind',...Object.keys(fields)].filter(key=>key in base).map(key=>[key,base[key]]));
  await save({body},res,true,true);
 }));
 const removeService=async(rawId,res)=>{
  const id=slug.safeParse(rawId);if(!id.success)return res.status(400).json({message:'Invalid service ID.'});
  const key=`service:${id.data}`,current=(await list(true)).find(row=>row.kind==='service'&&row.id===id.data);
  if(!current)return res.status(404).json({message:'Service not found.'});
  const cleanup=await permanentDeletion.prepare(current);
  // Keep only a seed-suppression marker; no deleted content or media survives.
  await Entry.updateOne({key},{$set:{value:{id:id.data,kind:'service',deleted:true,sortOrder:current.sortOrder}}},{upsert:true});
  await permanentDeletion.finish(cleanup);
  res.json({removed:true,id:id.data});
 };
 app.delete('/api/admin/setup-catalog/:kind/:id',requireAdmin,wrap(async(req,res)=>{
  if(req.params.kind!=='service')return res.status(400).json({message:'Only services can be deleted from this action.'});
  return removeService(req.params.id,res);
 }));
 // Rental Equipment categories: what groups the rental equipment. They are the non-core "service" entries, so the booking keeps grouping by their id;
 // they are created, renamed and removed here (Settings card) and no longer added as services.
 const categoryInput=z.object({name:z.string().trim().min(1,'Enter a category name.').max(160),nameAr:z.string().trim().max(160).default('')}).strict();
 const categories=async()=>{
  const rows=(await list(true)).filter(row=>row.kind==='service'&&!CORE_SERVICES.includes(row.id));
  const owned=await Equipment.aggregate([{$match:{serviceId:{$in:rows.map(row=>row.id)}}},{$group:{_id:'$serviceId',count:{$sum:1}}}]);
  const counts=new Map(owned.map(row=>[row._id,row.count]));
  return rows.map(row=>({id:row.id,name:row.name,nameAr:row.nameAr||'',equipmentCount:counts.get(row.id)||0}));
 };
 // save() answers on its own response; run it against a probe so these endpoints can answer with the category list instead.
 const probe=()=>{const out={code:200,body:null},res={status(code){out.code=code;return res;},json(body){out.body=body;return res;}};return [res,out];};
 const slugOf=name=>name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
 app.get('/api/admin/rental-categories',requireAdmin,wrap(async(_req,res)=>res.set('Cache-Control','no-store').json({items:await categories()})));
 app.post('/api/admin/rental-categories',requireAdmin,wrap(async(req,res)=>{
  const data=categoryInput.parse(req.body);
  const taken=new Set([...(await list(true)).map(row=>row.id),...(await removedServices()).map(row=>row.id)]);
  let id=slugOf(data.name)||'category',n=2;const base=id;while(taken.has(id)||CORE_SERVICES.includes(id))id=`${base.slice(0,70)}-${n++}`;
  const sortOrder=((await list(true)).filter(row=>row.kind==='service').reduce((max,row)=>Math.max(max,row.sortOrder||0),0))+10;
  const [fake,out]=probe();
  await save({body:{id,kind:'service',name:data.name,nameAr:data.nameAr,icon:'box',sortOrder}},fake,true,true);
  if(out.code>=400)return res.status(out.code).json(out.body);
  res.status(201).json({items:await categories()});
 }));
 app.put('/api/admin/rental-categories/:id',requireAdmin,wrap(async(req,res)=>{
  const data=categoryInput.parse(req.body),current=(await list(true)).find(row=>row.kind==='service'&&row.id===req.params.id&&!CORE_SERVICES.includes(row.id));
  if(!current)return res.status(404).json({message:'Category not found.'});
  const {priceId:_price,...keep}=current;
  const [fake,out]=probe();
  await save({body:{...keep,name:data.name,nameAr:data.nameAr},params:{id:current.id,kind:'service'}},fake,false,true);
  if(out.code>=400)return res.status(out.code).json(out.body);
  res.json({items:await categories()});
 }));
 app.delete('/api/admin/rental-categories/:id',requireAdmin,wrap(async(req,res)=>{
  if(CORE_SERVICES.includes(req.params.id))return res.status(400).json({message:'DJ Khalil Nahhat and MC host are services, not categories.'});
  const used=await Equipment.countDocuments({serviceId:req.params.id});
  if(used)return res.status(409).json({message:`${used} rental equipment item${used>1?'s use':' uses'} this category. Move them to another category first.`});
  return removeService(req.params.id,res);
 }));
}
module.exports={registerSetupCatalog,list,fields,removedServices};
