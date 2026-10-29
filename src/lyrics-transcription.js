const multer=require('multer');
const path=require('node:path');

const MAX_BYTES=25*1024*1024;
const formats=new Set(['.mp3','.mp4','.mpeg','.mpga','.m4a','.wav','.webm']);

// Admin tool: transcription drafts are returned for review, never saved as lyrics automatically.
function registerLyricsTranscription(app,{requireAdmin,configService,fetchImpl=fetch,env=process.env}){
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_BYTES,files:1,fields:1}}).single('file');
 const requests=new Map(),active=new Set();
 app.post('/api/admin/music-ontology/lyrics-transcription',requireAdmin,(req,res,next)=>{
  upload(req,res,error=>error?res.status(400).json({message:error.code==='LIMIT_FILE_SIZE'?'Choose an audio file under 25 MB.':'Could not read the audio upload.'}):next());
 },async(req,res)=>{
  res.set('Cache-Control','no-store');
  const owner=String(req.user?.externalId||req.user?._id||req.authUser?.id||'admin');
  let ticket,claimed=false;
  const cancelled=new AbortController();
  const disconnect=()=>{if(!res.writableEnded)cancelled.abort();};
  res.on('close',disconnect);
  try{
   const config=await configService.load();
   if(config.stt?.model!=='gpt-transcribe')return res.status(503).json({message:'Select GPT-Transcribe in ECHO AI Configuration.'});
   if(!config.stt?.enabled)return res.status(503).json({message:'Speech-to-text is disabled in ECHO AI Configuration.'});
   if(!env.OPENAI_API_KEY)return res.status(503).json({message:'Configure OPENAI_API_KEY on the server to use speech-to-text.'});
   const file=req.file,extension=path.extname(file?.originalname||'').toLowerCase();
   if(!file?.size||!formats.has(extension))return res.status(400).json({message:'Choose an MP3, MP4, MPEG, MPGA, M4A, WAV or WebM audio file.'});
   if(active.has(owner))return res.status(409).json({message:'A transcription is already running. Wait for it to finish.'});
   const now=Date.now(),windowMs=10*60*1000;
   for(const [id,times] of requests)if(!times.some(time=>now-time<windowMs))requests.delete(id);
   const times=(requests.get(owner)||[]).filter(time=>now-time<windowMs);
   if(times.length>=config.stt.requestsPer10Min)return res.status(429).json({message:'Transcription limit reached. Try again in a few minutes.'});
   requests.set(owner,[...times,now]);active.add(owner);claimed=true;
   const body=new FormData();
   body.append('file',new Blob([file.buffer],{type:file.mimetype||'application/octet-stream'}),`audio${extension}`);
   body.append('model',config.stt.model);
   ticket=await configService.reserve({owner,mode:'stt',config});
   const response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},body,signal:AbortSignal.any([AbortSignal.timeout(180000),cancelled.signal])});
   if(!response.ok){await configService.fail(ticket);ticket=null;return res.status(response.status===429?429:502).json({message:response.status===429?'The transcription service is busy or has reached its usage limit.':'The audio could not be transcribed. Check the model and provider account in ECHO AI Configuration.'});}
   const result=await response.json();
   if(typeof result.text!=='string'||result.text.length>100000)throw new Error('Invalid transcript');
   const duration=result.usage?.seconds??result.duration;
   await configService.complete(ticket,{...(Number.isFinite(duration)?{durationSeconds:duration}:{}),fileBytes:file.size},false);ticket=null;
   res.json({text:result.text,model:config.stt.model,languages:Array.isArray(result.languages)?result.languages:[]});
  }catch(error){
   if(ticket)await configService.fail(ticket).catch(()=>{});
   res.status(502).json({message:error.name==='TimeoutError'?'Transcription timed out. Try a shorter audio file.':'Could not transcribe this audio. Your existing lyrics are unchanged.'});
  }finally{if(claimed)active.delete(owner);res.off('close',disconnect);}
 });
}
module.exports={registerLyricsTranscription};
