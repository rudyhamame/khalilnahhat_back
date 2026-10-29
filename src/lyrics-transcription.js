const multer=require('multer');
const path=require('node:path');

const MAX_BYTES=25*1024*1024;
const languages=new Set(['ar','en','fr','es','de','it','pt','tr','fa','ur','hi','ru','uk','el','he','nl','pl','zh','ja','ko']);
const formats=new Set(['.mp3','.mp4','.mpeg','.mpga','.m4a','.wav','.webm']);

// Admin tool: transcription drafts are returned for review, never saved as lyrics automatically.
function registerLyricsTranscription(app,{requireAdmin,configService,fetchImpl=fetch,env=process.env}){
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_BYTES,files:1,fields:1}}).single('file');
 const requests=new Map(),active=new Set();
 app.get('/api/admin/music-ontology/lyrics-transcription/status',requireAdmin,async(_req,res)=>{
  res.set('Cache-Control','no-store');
  try{const config=await configService.load();res.json({model:config.stt?.model||'gpt-transcribe',enabled:Boolean(config.stt?.enabled),configured:Boolean(env.OPENAI_API_KEY)});}catch{res.status(503).json({message:'Speech-to-text settings are unavailable.'});}
 });
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
   const language=req.body?.language||'';
   if(typeof language!=='string'||language&&!languages.has(language))return res.status(400).json({message:'Choose a supported language or automatic detection.'});
   if(active.has(owner))return res.status(409).json({message:'A transcription is already running. Wait for it to finish.'});
   const now=Date.now(),windowMs=10*60*1000;
   for(const [id,times] of requests)if(!times.some(time=>now-time<windowMs))requests.delete(id);
   const times=(requests.get(owner)||[]).filter(time=>now-time<windowMs);
   if(times.length>=config.stt.requestsPer10Min)return res.status(429).json({message:'Transcription limit reached. Try again in a few minutes.'});
   requests.set(owner,[...times,now]);active.add(owner);claimed=true;
   const body=new FormData();
   body.append('file',new Blob([file.buffer],{type:file.mimetype||'application/octet-stream'}),`audio${extension}`);
   body.append('model',config.stt.model);
   if(language)body.append('languages[]',language);
   ticket=await configService.reserve({owner,mode:'stt',config});
   const response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},body,signal:AbortSignal.any([AbortSignal.timeout(180000),cancelled.signal])});
   if(!response.ok){
    const failure=await response.json().catch(()=>({})),code=failure.error?.code;
    console.warn('Lyrics transcription provider rejected request',JSON.stringify({status:response.status,code:typeof code==='string'?code:null,model:config.stt.model,requestId:response.headers.get('x-request-id')}));
    await configService.fail(ticket);ticket=null;
    const message=response.status===401||response.status===403?'OpenAI rejected the server API key. Check OPENAI_API_KEY on the API server.':response.status===404||code==='model_not_found'?'The server OpenAI account cannot access GPT-Transcribe. Check model access in ECHO AI Configuration.':code==='insufficient_quota'?'The OpenAI account has insufficient API credits. Check the provider billing balance.':response.status===429?'OpenAI rate limit reached. Wait a moment and try again.':response.status===413?'The audio is too large for the transcription service. Try a smaller file.':response.status===400?'OpenAI could not process this audio or language selection. Try an MP3 or WAV file with automatic language detection.':'OpenAI could not complete the transcription. Please try again.';
    return res.status(response.status===429?429:502).json({message});
   }
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
