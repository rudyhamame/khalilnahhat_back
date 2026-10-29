const {z}=require('zod');
const {createService}=require('./service');
const {ArchiveItem}=require('../models');
const contract=require('../../contracts/music-ontology.json');
function registerMusicOntology(app,{requireAdmin,service=createService()}={}){
 const admin='/api/admin/music-ontology',pub='/api/music-ontology';
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){const status=e instanceof z.ZodError?400:e.code===11000?409:e.status||500;res.status(status).json({message:e instanceof z.ZodError?e.issues[0].message:e.code===11000?'This metadata identity already exists. Select the existing entity.':status<500?e.message:'The music archive could not complete this request.',...(e.status===503?{message:e.message}:{})});if(status>=500)console.error('Music ontology:',e.name,e.code||'');}};
 const entity=r=>({...r,id:r.externalId,_id:undefined});
 const actor=req=>String(req.user?.externalId||req.user?._id||req.user?.id||'admin');
 const filterSchema=z.object(Object.fromEntries(contract.filters.map(key=>[key,['bpmMin','bpmMax'].includes(key)?z.coerce.number().positive().max(1000).optional():z.string().max(240).optional()]))).strict().refine(f=>f.bpmMin==null||f.bpmMax==null||f.bpmMin<=f.bpmMax,'Minimum BPM cannot exceed maximum BPM.');
 const readFilters=req=>{const f=filterSchema.parse(req.query);if(f.bpmScope&&!['work','recording'].includes(f.bpmScope))throw Object.assign(new Error('Choose work or recording BPM scope.'),{status:400});return f;};
 app.get(`${pub}/contract`,(_req,res)=>res.json(contract));
 for(const [prefix,guards,isAdmin] of [[pub,[],false],[admin,[requireAdmin],true]]){
  app.get(`${prefix}/recordings`,...guards,wrap(async(req,res)=>{const filters=readFilters(req);if(!isAdmin&&(filters.publicationStatus&&filters.publicationStatus!=='PUBLISHED'||filters.archivalStatus&&filters.archivalStatus!=='ACTIVE'))return res.json({items:[]});res.set('Cache-Control','no-store').json({items:await service.list(isAdmin,filters)});}));
  app.get(`${prefix}/recordings/:id`,...guards,wrap(async(req,res)=>{const item=(await service.list(isAdmin)).find(r=>r.id===req.params.id);if(!item)return res.status(404).json({message:'Recording not found.'});res.set('Cache-Control','no-store').json({item});}));
  app.get(`${prefix}/works`,...guards,wrap(async(_req,res)=>{const ids=isAdmin?(await service.models.Work.find().lean()).map(w=>w.externalId):[...new Set((await service.list(false)).flatMap(r=>r.componentWorkIds||[r.workId]).filter(Boolean))];res.set('Cache-Control','no-store').json({items:[...(await service.workMap(ids)).works.values()]});}));
  app.get(`${prefix}/works/:id`,...guards,wrap(async(req,res)=>{if(!isAdmin&&!(await service.list(false)).some(r=>r.workId===req.params.id||r.componentWorkIds?.includes(req.params.id)))return res.status(404).json({message:'Work not found.'});const item=(await service.workMap([req.params.id])).works.get(req.params.id);if(!item)return res.status(404).json({message:'Work not found.'});res.json({item});}));
  app.get(`${prefix}/vocabulary`,...guards,wrap(async(req,res)=>{const query={};if(req.query.kind){query.kind=z.enum(contract.vocabularyKinds).parse(req.query.kind);}let rows=await service.models.Vocabulary.find(query).sort({name:1}).lean();if(req.query.q){const q=String(req.query.q).toLowerCase().slice(0,240);rows=rows.filter(r=>r.name.toLowerCase().includes(q));}res.set('Cache-Control','no-store').json({items:rows.map(entity)});}));
  app.get(`${prefix}/vocabulary/:id`,...guards,wrap(async(req,res)=>{const item=await service.models.Vocabulary.findOne({externalId:req.params.id}).lean();if(!item)return res.status(404).json({message:'Metadata entity not found.'});res.json({item:entity(item)});}));
 }
 app.post(`${admin}/vocabulary`,requireAdmin,wrap(async(req,res)=>res.status(201).json({item:entity(await service.saveVocabulary(req.body,null,actor(req)))})));
 app.put(`${admin}/vocabulary/:id`,requireAdmin,wrap(async(req,res)=>res.json({item:entity(await service.saveVocabulary(req.body,req.params.id,actor(req)))})));
 for(const [name,save] of [['works',service.saveWork],['recordings',service.saveRecording]]){
  for(const [method,suffix] of [['post',''],['put','/:id']])app[method](`${admin}/${name}${suffix}`,requireAdmin,wrap(async(req,res)=>{
   const id=await save(req.body,req.params.id||null,actor(req));
   const item=name==='works'?(await service.workMap([id])).works.get(id):(await service.list(true)).find(r=>r.id===id);
   res.status(method==='post'?201:200).json({item});
  }));
 }
 app.get(`${admin}/recordings/:id/versions`,requireAdmin,wrap(async(req,res)=>res.json({items:(await service.models.Version.find({recordingId:req.params.id}).sort({number:-1}).lean()).map(entity)})));
 app.delete(`${admin}/recordings/:id`,requireAdmin,wrap(async(req,res)=>{
  const schema=z.object({revision:z.number().int().nonnegative(),permanent:z.literal(true)}).strict();
  const {revision}=schema.parse(req.body);
  await service.transaction(async session=>{
   await require('mongoose').connection.collection('musicontologylocks').updateOne({_id:'source-graph'},{$inc:{revision:1}},{upsert:true,session});
   const row=await ArchiveItem.findOne({externalId:req.params.id}).session(session);
   if(!row)throw Object.assign(new Error('Recording not found.'),{status:404});
   if((row.ontologyRevision??0)!==revision)throw Object.assign(new Error('Recording changed. Reload before deleting.'),{status:409});
   if(await ArchiveItem.exists({externalId:{$ne:row.externalId},sourceRecordingIds:row.externalId}).session(session))throw Object.assign(new Error('This recording is used as a source. Remove its source reference from other recordings before deleting it.'),{status:409});
   await require('../music-archive').Collection.updateMany({recordingIds:row.externalId},{$pull:{recordingIds:row.externalId}},{session});
   await service.models.Version.deleteMany({recordingId:row.externalId}).session(session);
   const deleted=await ArchiveItem.deleteOne({_id:row._id,externalId:row.externalId,ontologyRevision:row.ontologyRevision}).session(session);
   if(deleted.deletedCount!==1||await ArchiveItem.exists({externalId:row.externalId}).session(session))throw Object.assign(new Error('Permanent deletion could not be confirmed.'),{status:409});
  });
  res.json({ok:true,deleted:true,id:req.params.id});
 }));

 return service;
}
module.exports={registerMusicOntology};
