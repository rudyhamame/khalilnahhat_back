const mongoose=require('mongoose');
const multer=require('multer');
const {randomUUID}=require('node:crypto');
const {z}=require('zod');
const cloudinary=require('cloudinary').v2;
const Job=mongoose.models.Equipment3DJob||mongoose.model('Equipment3DJob',new mongoose.Schema({
 externalId:{type:String,unique:true,required:true},owner:{type:String,index:true,required:true},requestId:{type:String,required:true},
 mode:String,prompt:String,providerId:String,previewId:String,phase:String,status:String,progress:Number,
 sourceUrl:String,modelUrl:String,message:String,credits:Number,activeKey:{type:String,unique:true,sparse:true},
},{timestamps:true}));
Job.schema.index({owner:1,requestId:1},{unique:true});
const ownerOf=req=>String(req.user?.externalId||req.user?._id||req.user?.id||req.authUser?.id||'');
const fault=(status,message)=>Object.assign(new Error(message),{status});
const isAsset=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='assets.meshy.ai'&&!u.username&&!u.password;}catch{return false;}};
const view=job=>({id:job.externalId,mode:job.mode,phase:job.phase,status:job.status,progress:job.progress||0,modelUrl:job.modelUrl||'',previewUrl:job.modelUrl||(isAsset(job.sourceUrl)?job.sourceUrl:''),message:job.message||'',credits:job.credits,createdAt:job.createdAt});
async function equipmentModelFields(req,modelJobId){
 if(modelJobId===undefined)return {};
 if(modelJobId===null||modelJobId==='')return {modelUrl:'',modelJobId:''};
 const job=await Job.findOne({externalId:modelJobId,owner:ownerOf(req),status:'SUCCEEDED'}).lean();
 if(!job?.modelUrl)throw fault(400,'Choose a completed 3D model and click Use this model first.');
 return {modelUrl:job.modelUrl,modelJobId:job.externalId};
}
function registerEquipment3D(app,{requireAdmin,env=process.env,fetchImpl=fetch}){
 const configured=()=>Boolean(env.MESHY_API_KEY);
 const storage=()=>Boolean(env.CLOUDINARY_CLOUD_NAME&&env.CLOUDINARY_API_KEY&&env.CLOUDINARY_API_SECRET);
 const ready=()=>{if(!configured())throw fault(503,'Configure MESHY_API_KEY on the backend to generate 3D equipment.');if(!storage())throw fault(503,'Configure Cloudinary storage before generating equipment models.');};
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{if(!ownerOf(req))throw fault(401,'Sign in again.');await fn(req,res);}catch(error){const status=error.status|| (error instanceof z.ZodError?400:500);if(status>=500)console.warn('Equipment 3D request failed',JSON.stringify({name:error.name,status}));res.status(status).json({message:error instanceof z.ZodError?error.issues[0].message:error.status?error.message:'The 3D request could not complete. Your equipment is unchanged.'});}};
 const path=mode=>mode==='photo'?'/openapi/v1/image-to-3d':'/openapi/v2/text-to-3d';
 const provider=async(endpoint,body)=>{
  const response=await fetchImpl('https://api.meshy.ai'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.MESHY_API_KEY,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw fault(response.status===429?429:502,response.status===401||response.status===403?'Meshy rejected the API key or account permissions. Check your Meshy Developer Platform.':response.status===402?'Meshy API credits are insufficient. Add API credits in Meshy.':response.status===429?'Meshy is busy or rate-limiting requests. Wait before retrying.':response.status===404?'This Meshy task has expired or is unavailable. Start a new generation.':response.status===400?'Meshy could not process this photo or description. Try a clear equipment photo or a more specific description.':'Meshy could not complete the request. Try again later.');
  return data;
 };
 const getJob=async req=>{const job=await Job.findOne({externalId:req.params.id,owner:ownerOf(req)});if(!job)throw fault(404,'3D generation not found.');return job;};
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1,fields:3,fieldSize:4000}}).single('photo');
 app.get('/api/admin/equipment-3d/config',requireAdmin,wrap(async(_req,res)=>res.json({provider:'Meshy',model:'meshy-7.1',configured:configured(),storageConfigured:storage(),photoCredits:30,textCredits:20,textureCredits:10,maxPhotoMB:8})));
 app.get('/api/admin/equipment-3d/jobs',requireAdmin,wrap(async(req,res)=>{
  await Job.updateMany({owner:ownerOf(req),activeKey:ownerOf(req),createdAt:{$lt:new Date(Date.now()-3*86400000)}},{$set:{status:'FAILED',message:'This generation expired. Start a new model.'},$unset:{activeKey:1}});
  res.json({items:(await Job.find({owner:ownerOf(req)}).sort({createdAt:-1}).limit(12).lean()).map(view)});
 }));
 app.post('/api/admin/equipment-3d/jobs',requireAdmin,(req,res,next)=>upload(req,res,error=>error?res.status(400).json({message:error.code==='LIMIT_FILE_SIZE'?'Choose a photo under 8 MB.':'Could not read the photo upload.'}):next()),wrap(async(req,res)=>{
  ready();
  const input=z.object({mode:z.enum(['text','photo']),prompt:z.string().trim().max(800).default(''),requestId:z.uuid()}).strict().parse(req.body);
  const previous=await Job.findOne({owner:ownerOf(req),requestId:input.requestId});if(previous)return res.json({item:view(previous)});
  if(input.mode==='text'&&input.prompt.length<10)throw fault(400,'Describe the equipment in at least 10 characters.');
  if(input.mode==='photo'&&(!req.file||!['image/png','image/jpeg','image/webp'].includes(req.file.mimetype)))throw fault(400,'Choose a JPG, PNG or WebP equipment photo.');
  if(await Job.countDocuments({owner:ownerOf(req),createdAt:{$gte:new Date(Date.now()-3600000)}})>=6)throw fault(429,'Limit of six new 3D generations per hour reached.');
  // The unique activeKey prevents duplicate simultaneous paid submissions per admin.
  let job;try{job=await Job.create({externalId:randomUUID(),owner:ownerOf(req),requestId:input.requestId,mode:input.mode,prompt:input.prompt,status:'SUBMITTING',phase:input.mode==='text'?'preview':'photo',credits:input.mode==='text'?20:30,activeKey:ownerOf(req)});}catch(error){if(error.code===11000)throw fault(409,'Another generation is running. Resume it from Recent generations.');throw error;}
  const common={ai_model:'meshy-7.1',model_type:'standard',should_remesh:true,target_polycount:30000,target_formats:['glb']};
  try{
   const data=await provider(path(input.mode),input.mode==='text'?{...common,mode:'preview',prompt:input.prompt}:{...common,image_url:'data:'+req.file.mimetype+';base64,'+req.file.buffer.toString('base64'),should_texture:true,enable_pbr:true,texture_resolution:'2k'});
   if(typeof data.result!=='string'||!data.result)throw Error('Invalid task response');
   job.providerId=data.result;job.status='PENDING';await job.save();
  }catch(error){job.status=error.status?'FAILED':'UNCERTAIN';job.message=error.status?error.message:'Meshy submission could not be confirmed. Check Meshy task history before starting another generation.';job.activeKey=undefined;await job.save();if(error.status)throw error;}
  res.status(202).json({item:view(job)});
 }));
 app.get('/api/admin/equipment-3d/jobs/:id',requireAdmin,wrap(async(req,res)=>{
  let job=await getJob(req);
  if(job.providerId&&!job.modelUrl&&!['FAILED','CANCELED'].includes(job.status)){
   if(!configured())throw fault(503,'Configure MESHY_API_KEY to resume this generation.');
   const data=await provider(path(job.mode)+'/'+encodeURIComponent(job.providerId));
   if(!['PENDING','IN_PROGRESS','SUCCEEDED','FAILED','CANCELED'].includes(data.status))throw fault(502,'Meshy returned an invalid task status.');
   const patch={status:data.status,progress:Math.max(0,Math.min(100,Number(data.progress)||0))};
   const terminal=['SUCCEEDED','FAILED','CANCELED'].includes(data.status);
   if(data.status==='SUCCEEDED'){
    if(!isAsset(data.model_urls?.glb))throw fault(502,'Meshy did not return a supported GLB model.');
    patch.sourceUrl=data.model_urls.glb;patch.message='';
   }else if(terminal)patch.message='Meshy generation '+data.status.toLowerCase()+'. Try another photo or description.';
   // A late preview poll cannot overwrite a texture task that started meanwhile.
   const updated=await Job.findOneAndUpdate({_id:job._id,providerId:job.providerId,phase:job.phase},{$set:patch,...(terminal?{$unset:{activeKey:1}}:{})},{new:true});
   job=updated||await Job.findById(job._id);
  }
  res.json({item:view(job)});
 }));
 app.post('/api/admin/equipment-3d/jobs/:id/texture',requireAdmin,wrap(async(req,res)=>{
  ready();let job=await getJob(req);
  if(job.phase==='refine')return res.json({item:view(job)});
  if(job.mode!=='text'||job.phase!=='preview'||job.status!=='SUCCEEDED')throw fault(400,'Complete a text preview before adding textures.');
  const locked=await Job.findOneAndUpdate({_id:job._id,phase:'preview',status:'SUCCEEDED'},{$set:{phase:'refine',status:'SUBMITTING',activeKey:ownerOf(req),previewId:job.providerId,progress:0}},{new:true}).catch(error=>{if(error.code===11000)throw fault(409,'Finish your other active generation first.');throw error;});
  if(!locked)throw fault(409,'Texture generation has already started. Refresh its status.');
  job=locked;
  try{const data=await provider(path('text'),{mode:'refine',preview_task_id:job.previewId,ai_model:'meshy-7.1',enable_pbr:true,texture_resolution:'2k',target_formats:['glb']});if(typeof data.result!=='string'||!data.result)throw Error('Invalid task response');job.providerId=data.result;job.sourceUrl='';job.modelUrl='';job.status='PENDING';job.credits=30;await job.save();}
  catch(error){job.status=error.status?'FAILED':'UNCERTAIN';job.message=error.status?error.message:'Texture submission could not be confirmed. Check Meshy task history before retrying.';job.activeKey=undefined;await job.save();if(error.status)throw error;}
  res.status(202).json({item:view(job)});
 }));
 const importing=new Map();
 app.post('/api/admin/equipment-3d/jobs/:id/store',requireAdmin,wrap(async(req,res)=>{
  const job=await getJob(req);if(job.modelUrl)return res.json({item:view(job)});
  ready();if(job.status!=='SUCCEEDED'||!isAsset(job.sourceUrl))throw fault(400,'Wait for the 3D model to finish.');
  if(!importing.has(job.externalId))importing.set(job.externalId,(async()=>{
   const response=await fetchImpl(job.sourceUrl,{redirect:'error',signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw fault(502,'The generated model download expired. Refresh the generation and retry.');
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>40*1024*1024)throw fault(400,'This model exceeds the 40 MB website limit.');chunks.push(Buffer.from(chunk));}
   const buffer=Buffer.concat(chunks);if(buffer.length<20||buffer.toString('ascii',0,4)!=='glTF'||buffer.readUInt32LE(4)!==2||buffer.readUInt32LE(8)!==buffer.length)throw fault(502,'The downloaded file is not a valid GLB model.');
   const result=await new Promise((resolve,reject)=>cloudinary.uploader.upload_stream({resource_type:'raw',type:'upload',public_id:'khalil/equipment-models/'+job.externalId+'-'+job.phase+'.glb',overwrite:true},(error,result)=>error?reject(error):resolve(result)).end(buffer));
   if(!result?.secure_url)throw Error('No stored model URL');
   const stored=await Job.findOneAndUpdate({_id:job._id,providerId:job.providerId,phase:job.phase,status:'SUCCEEDED'},{$set:{modelUrl:result.secure_url}},{new:true});
   if(!stored)throw fault(409,'The generation changed while saving. Refresh its status and review the latest model.');
   return view(stored);
  })().finally(()=>importing.delete(job.externalId)));
  res.json({item:await importing.get(job.externalId)});
 }));
}
module.exports={registerEquipment3D,equipmentModelFields};
