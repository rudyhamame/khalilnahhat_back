const mongoose=require('mongoose');
const multer=require('multer');
const {z}=require('zod');
const {providerKey}=require('../openrouter');
const {failure}=require('./route-adapter');
const Settings=mongoose.models.EchoAdminServices||mongoose.model('EchoAdminServices',new mongoose.Schema({_id:String,revision:Number,text:mongoose.Schema.Types.Mixed,stt:mongoose.Schema.Types.Mixed,voice:mongoose.Schema.Types.Mixed,updatedBy:String},{timestamps:true}));
const serviceSchema=z.object({enabled:z.boolean(),provider:z.string(),model:z.string().trim().min(1).max(200)}).strict();
const schema=z.object({revision:z.number().int().min(0),text:serviceSchema.extend({provider:z.enum(['openai','openrouter','poe','alibaba','ollama']),freeOnly:z.boolean(),maxOutputTokens:z.number().int().min(1500).max(8000)}),stt:serviceSchema.extend({provider:z.enum(['browser','openai','alibaba'])}),voice:serviceSchema.extend({provider:z.enum(['browser','openai']),maxCallSeconds:z.number().int().min(30).max(900)})}).strict();
const audioCatalog=[
 {mode:'stt',provider:'browser',id:'browser-recognition',label:'Browser speech recognition'},
 {mode:'stt',provider:'openai',id:'whisper-1',label:'Whisper'},
 {mode:'stt',provider:'openai',id:'gpt-4o-mini-transcribe',label:'GPT-4o Mini Transcribe'},
 {mode:'stt',provider:'alibaba',id:'qwen3-asr-flash',label:'Qwen3 ASR Flash'},
 {mode:'voice',provider:'browser',id:'browser-speech',label:'Browser voice'},
 {mode:'voice',provider:'openai',id:'gpt-4o-mini-tts',label:'GPT-4o Mini TTS'},
];
function createAdminServices({configService,env=process.env,fetchImpl=fetch}){
 const load=async()=>{const saved=await Settings.findById('administrator').lean();if(saved)return schema.parse({revision:saved.revision,text:saved.text,stt:saved.stt,voice:saved.voice});const old=await configService.load();return {revision:0,text:{enabled:true,provider:'openai',model:env.OPENAI_ADMIN_MODEL||(old.chat?.provider==='openai'?old.chat.model:env.OPENAI_BOOKING_CHAT_MODEL||'gpt-4o-mini'),freeOnly:false,maxOutputTokens:3000},stt:{enabled:true,provider:'browser',model:'browser-recognition'},voice:{enabled:true,provider:'browser',model:'browser-speech',maxCallSeconds:300}};};
 const configured=provider=>provider==='browser'||Boolean(providerKey(env,provider));
 const describe=async()=>{const config=await configService.describe();return {item:await load(),catalog:[...config.catalog.filter(row=>row.mode==='chat').map(row=>({...row,mode:'text'})),...audioCatalog],providers:{...config.providers,browser:{configured:true}},catalogError:config.catalogError};};
 const save=async(body,actor)=>{
  const data=schema.parse(body),old=await load();if(data.revision!==old.revision)throw failure(409,'Administrator settings changed. Reload before saving.');
  for(const mode of ['stt','voice'])if(!audioCatalog.some(row=>row.mode===mode&&row.provider===data[mode].provider&&row.id===data[mode].model))throw failure(400,`Choose a supported Administrator ${mode} model.`);
  const catalog=await describe();
  for(const mode of ['text','stt','voice']){
   const current=data[mode],previous=old[mode];
   if(current.provider!==previous.provider||current.model!==previous.model){const model=catalog.catalog.find(row=>row.mode===mode&&row.provider===current.provider&&row.id===current.model);if(!model)throw failure(400,`Select an available ${mode} model for this provider.`);}
   if(current.enabled&&!configured(current.provider))throw failure(503,`Configure the server API key for ${current.provider} before enabling Administrator ${mode}.`);
  }
  if(data.text.provider==='openrouter'&&data.text.freeOnly&&!catalog.catalog.some(row=>row.mode==='text'&&row.provider==='openrouter'&&row.id===data.text.model&&row.free))throw failure(400,'Choose a free OpenRouter model or turn off Free models only.');
  const next={...data,revision:data.revision+1,updatedBy:actor};
  if(!old.revision){try{await Settings.create({_id:'administrator',...next});}catch(error){if(error.code===11000)throw failure(409,'Administrator settings changed. Reload before saving.');throw error;}}
  else if(!(await Settings.updateOne({_id:'administrator',revision:data.revision},{$set:next})).matchedCount)throw failure(409,'Administrator settings changed. Reload before saving.');
  return load();
 };
 const limits=new Map(),active=new Set();
 const run=async(req,res,mode,fn)=>{
  const owner=String(req.user._id||req.user.id),key=owner+':'+mode,now=Date.now();
  const times=(limits.get(key)||[]).filter(at=>now-at<600000);if(active.has(key))throw failure(409,'This audio service is already busy.');if(times.length>=30)throw failure(429,'Administrator audio limit reached. Wait before trying again.');
  for(const [id,rows] of limits)if(!rows.some(at=>now-at<600000))limits.delete(id);
  limits.set(key,[...times,now]);active.add(key);const controller=new AbortController(),close=()=>{if(!res.writableEnded)controller.abort();};res.on('close',close);
  try{const settings=await load(),config=settings[mode];if(!config.enabled)throw failure(503,`Administrator ${mode} is disabled.`);if(!configured(config.provider))throw failure(503,`The ${config.provider} server API key is missing.`);await fn(config,AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]));}finally{active.delete(key);res.off('close',close);}
 };
 function register(app,requireAdmin,guard){
  const base='/api/admin/ai-administrator';
  app.get(base+'/services',requireAdmin,guard(async(_req,res)=>res.json(await describe())));
  app.put(base+'/services',requireAdmin,guard(async(req,res)=>res.json({item:await save(req.body,String(req.user._id||req.user.id))})));
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:7*1024*1024,files:1,fields:0}}).single('file');
  app.post(base+'/transcribe',requireAdmin,(req,res,next)=>upload(req,res,error=>error?res.status(400).json({message:'Choose a microphone recording under 7 MB.'}):next()),guard(async(req,res)=>run(req,res,'stt',async(config,signal)=>{
   if(config.provider==='browser')throw failure(400,'Browser transcription runs on your device. Reload the assistant settings.');
   const file=req.file;if(!file?.size||!/^audio\/(webm|ogg|mp4|mpeg|wav|x-wav)(;.*)?$/.test(file.mimetype))throw failure(400,'Record supported microphone audio.');
   let response;
   if(config.provider==='openai'){const form=new FormData();form.set('file',new Blob([file.buffer],{type:file.mimetype}),file.originalname);form.set('model',config.model);form.set('response_format','json');response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},body:form,signal});}
   else response=await fetchImpl(`${String(env.DASHSCOPE_BASE_URL||'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${env.DASHSCOPE_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.model,stream:false,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:`data:${file.mimetype};base64,${file.buffer.toString('base64')}`}}]}],asr_options:{enable_itn:false}}),signal});
   if(!response.ok)throw failure(response.status===429?429:503,`${config.provider} transcription failed (HTTP ${response.status}). Check model access and provider credits.`);
   const result=await response.json(),text=config.provider==='openai'?result.text:result.choices?.[0]?.message?.content;if(typeof text!=='string')throw failure(503,'The transcription service returned an invalid response.');res.json({text:text.trim().slice(0,8000),provider:config.provider,model:config.model});
  })));
  app.post(base+'/speech',requireAdmin,guard(async(req,res)=>run(req,res,'voice',async(config,signal)=>{
   if(config.provider!=='openai')throw failure(400,'Browser voice playback runs on your device. Reload the assistant settings.');
   const {text}=z.object({text:z.string().trim().min(1).max(4000)}).strict().parse(req.body);
   const response=await fetchImpl('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.model,voice:'coral',input:text,response_format:'mp3'}),signal});
   if(!response.ok)throw failure(response.status===429?429:503,`OpenAI voice playback failed (HTTP ${response.status}). Check model access and provider credits.`);
   const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>12*1024*1024)throw failure(503,'The voice response was too large.');res.type('audio/mpeg').send(bytes);
  })));
 }
 return {load,describe,save,configured,register};
}
module.exports={createAdminServices,audioCatalog};
