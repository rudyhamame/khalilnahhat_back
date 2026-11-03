const {uploadAsset}=require('./cloudinary-assets');
const mongoose=require('mongoose');
const multer=require('multer');
const {randomUUID}=require('node:crypto');
const MAX_MB=25;
const Job=mongoose.models.Equipment3DJob||mongoose.model('Equipment3DJob',new mongoose.Schema({
 externalId:{type:String,unique:true,required:true},owner:{type:String,index:true,required:true},requestId:{type:String,required:true},
 mode:String,prompt:String,providerId:String,previewId:String,phase:String,status:String,progress:Number,
 sourceUrl:String,modelUrl:String,message:String,credits:Number,activeKey:{type:String,unique:true,sparse:true},
},{timestamps:true}));
Job.schema.index({owner:1,requestId:1},{unique:true});
const ownerOf=req=>String(req.user?.externalId||req.user?._id||req.user?.id||req.authUser?.id||'');
const fault=(status,message)=>Object.assign(new Error(message),{status});
const view=job=>({id:job.externalId,name:job.prompt||'',modelUrl:job.modelUrl||'',createdAt:job.createdAt});
async function equipmentModelFields(req,modelJobId){
 if(modelJobId===undefined)return {};
 if(modelJobId===null||modelJobId==='')return {modelUrl:'',modelJobId:''};
 const job=await Job.findOne({externalId:modelJobId,owner:ownerOf(req),status:'SUCCEEDED'}).lean();
 if(!job?.modelUrl)throw fault(400,'Choose a completed 3D model and click Use this model first.');
 return {modelUrl:job.modelUrl,modelJobId:job.externalId};
}
function registerEquipment3D(app,{requireAdmin,env=process.env,uploadAssetImpl=uploadAsset}){
 const storage=()=>Boolean(env.CLOUDINARY_CLOUD_NAME&&env.CLOUDINARY_API_KEY&&env.CLOUDINARY_API_SECRET);
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{if(!ownerOf(req))throw fault(401,'Sign in again.');await fn(req,res);}catch(error){const status=error.status||500;if(status>=500)console.warn('Equipment 3D request failed',JSON.stringify({name:error.name,status}));res.status(status).json({message:error.status?error.message:'The 3D upload could not complete. Your equipment is unchanged.'});}};
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_MB*1024*1024,files:1,fields:1}}).single('model');
 app.get('/api/admin/equipment-3d/config',requireAdmin,wrap(async(_req,res)=>res.json({storageConfigured:storage(),maxMB:MAX_MB})));
 app.post('/api/admin/equipment-3d/upload',requireAdmin,(req,res,next)=>upload(req,res,error=>error?res.status(400).json({message:error.code==='LIMIT_FILE_SIZE'?'Choose a .glb under '+MAX_MB+' MB.':'Could not read the upload.'}):next()),wrap(async(req,res)=>{
  if(!storage())throw fault(503,'Configure Cloudinary storage before uploading equipment models.');
  const buffer=req.file?.buffer;
  if(!buffer||buffer.length<20||buffer.toString('ascii',0,4)!=='glTF'||buffer.readUInt32LE(4)!==2||buffer.readUInt32LE(8)!==buffer.length)throw fault(400,'Choose a valid binary .glb (glTF 2.0) file.');
  const id=randomUUID();
  const result=await uploadAssetImpl(buffer,{resource_type:'raw',type:'upload',folder:'khalil/equipment-models',public_id:'model.glb'});
  if(!result?.secure_url)throw Error('No stored model URL');
  // The job record lets equipmentModelFields verify ownership when the equipment is saved.
  const job=await Job.create({externalId:id,owner:ownerOf(req),requestId:id,mode:'upload',prompt:String(req.file.originalname||'').slice(0,160),status:'SUCCEEDED',modelUrl:result.secure_url});
  res.status(201).json({item:view(job)});
 }));
}
module.exports={registerEquipment3D,equipmentModelFields};
