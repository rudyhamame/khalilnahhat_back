const multer=require('multer');
const path=require('node:path');
const archiveFiles=require('./music-archive-files');
const {ownedAsset,deliveryUrl}=require('./music-archive');

const MAX_BYTES=25*1024*1024;
const languages=new Set(['ar','en','fr','es','de','it','pt','tr','fa','ur','hi','ru','uk','el','he','nl','pl','zh','ja','ko']);
const ALIBABA_BASE='https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
// Qwen-ASR takes one base64 data URL (10 MB limit incl. encoding, about 5 minutes of audio) and returns plain text without timestamps.
const ALIBABA_MAX_BYTES=7*1024*1024;
const alibabaLanguages=new Set(['ar','en','fr','es','de','it','pt','tr','uk','hi','ru','zh','ja','ko','pl']);
const mimeOf={'.mp3':'audio/mpeg','.mpeg':'audio/mpeg','.mpga':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.mp4':'audio/mp4','.webm':'audio/webm'};
const formats=new Set(['.mp3','.mp4','.mpeg','.mpga','.m4a','.wav','.webm']);

// Admin tool: returns editable lyrics and recording-specific playback timing.
function registerLyricsTranscription(app,{requireAdmin,configService,fetchImpl=fetch,env=process.env}){
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_BYTES,files:1,fields:3,fieldSize:4096}}).single('file');
 const requests=new Map(),active=new Set();
 app.get('/api/admin/music-ontology/lyrics-transcription/status',requireAdmin,async(_req,res)=>{
  res.set('Cache-Control','no-store');
  try{const config=await configService.load();const alibaba=config.stt?.provider==='alibaba';res.json({provider:alibaba?'alibaba':'openai',model:config.stt?.model||'whisper-1',enabled:Boolean(config.stt?.enabled),configured:Boolean(alibaba?env.DASHSCOPE_API_KEY:env.OPENAI_API_KEY),timedConfigured:Boolean(env.OPENAI_API_KEY),timestampModel:'whisper-1',timestampRatePerMinute:0.006});}catch{res.status(503).json({message:'Speech-to-text settings are unavailable.'});}
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
   if(!['whisper-1','qwen3-asr-flash'].includes(config.stt?.model))return res.status(503).json({message:'Select a speech-to-text model in ECHO AI Configuration.'});
   if(!config.stt?.enabled)return res.status(503).json({message:'Speech-to-text is disabled in ECHO AI Configuration.'});
   const timed=req.body?.timestamps==='true';
   // Timed lyrics always need Whisper segments; plain transcripts use the configured provider.
   const alibaba=config.stt.provider==='alibaba'&&!timed;
   if(alibaba?!env.DASHSCOPE_API_KEY:!env.OPENAI_API_KEY)return res.status(503).json({message:alibaba?'Configure DASHSCOPE_API_KEY on the server to use Alibaba Cloud speech-to-text.':timed&&config.stt.provider==='alibaba'?'Timed lyrics use OpenAI Whisper. Configure OPENAI_API_KEY on the server.':'Configure OPENAI_API_KEY on the server to use speech-to-text.'});
   if(req.body?.timestamps!==undefined&&!['true','false'].includes(req.body.timestamps))return res.status(400).json({message:'Invalid timestamp option.'});
   const sourceAudioUrl=typeof req.body?.audioUrl==='string'?req.body.audioUrl:'';
   if(sourceAudioUrl&&(!ownedAsset(sourceAudioUrl)||(!archiveFiles.localAssetPattern.test(sourceAudioUrl)&&!/^https:\/\/res\.cloudinary\.com\/[^/]+\/video\/(upload|authenticated)\//.test(sourceAudioUrl))))return res.status(400).json({message:'Choose audio uploaded to this website.'});
   if(!req.file&&!sourceAudioUrl)return res.status(400).json({message:'Choose an audio file or upload the recording audio first.'});
   if(timed&&!sourceAudioUrl)return res.status(400).json({message:'Timed lyrics must use the recording’s uploaded audio so they match playback.'});
   const language=req.body?.language||'';
   if(typeof language!=='string'||language&&!languages.has(language))return res.status(400).json({message:'Choose a supported language or automatic detection.'});
   if(active.has(owner))return res.status(409).json({message:'A transcription is already running. Wait for it to finish.'});
   const now=Date.now(),windowMs=10*60*1000;
   for(const [id,times] of requests)if(!times.some(time=>now-time<windowMs))requests.delete(id);
   const times=(requests.get(owner)||[]).filter(time=>now-time<windowMs);
   if(times.length>=config.stt.requestsPer10Min)return res.status(429).json({message:'Transcription limit reached. Try again in a few minutes.'});
   requests.set(owner,[...times,now]);active.add(owner);claimed=true;
   let file=req.file;
   if(sourceAudioUrl){
    if(archiveFiles.localAssetPattern.test(sourceAudioUrl))file=await archiveFiles.readLocalAudio(sourceAudioUrl,MAX_BYTES);
    else{
     const source=await fetchImpl(deliveryUrl(sourceAudioUrl),{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),cancelled.signal])});
     if(!source.ok)throw Error('Recording audio download failed');
     const chunks=[];let size=0;
     for await(const chunk of source.body){size+=chunk.length;if(size>MAX_BYTES){await source.body.cancel?.().catch(()=>{});throw Object.assign(Error('Choose recording audio under 25 MB.'),{status:400});}chunks.push(Buffer.from(chunk));}
     const extension=path.extname(new URL(sourceAudioUrl).pathname).toLowerCase();
     file={buffer:Buffer.concat(chunks),size,mimetype:source.headers.get('content-type')||'audio/mpeg',originalname:`recording${formats.has(extension)?extension:'.mp3'}`};
    }
   }
   const extension=path.extname(file?.originalname||'').toLowerCase();
   if(!file?.size||!formats.has(extension))return res.status(400).json({message:'Choose an MP3, MP4, MPEG, MPGA, M4A, WAV or WebM audio file.'});
   const model=timed?'whisper-1':config.stt.model;
   const requestConfig=timed?{...config,stt:{...config.stt,provider:'openai',model,providerRates:{audioMinute:0.006}}}:config;
   if(alibaba){
    if(file.size>ALIBABA_MAX_BYTES)return res.status(400).json({message:'Alibaba Cloud speech-to-text accepts audio under 7 MB (about 5 minutes). Use a shorter file or switch the provider to OpenAI.'});
    ticket=await configService.reserve({owner,mode:'stt',config:requestConfig});
    const base=String(env.DASHSCOPE_BASE_URL||ALIBABA_BASE).replace(/\/+$/,'');
    const asr={enable_itn:false,...(alibabaLanguages.has(language)?{language}:{})};
    const response=await fetchImpl(`${base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${env.DASHSCOPE_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:`data:${mimeOf[extension]||'audio/mpeg'};base64,${file.buffer.toString('base64')}`}}]}],asr_options:asr}),signal:AbortSignal.any([AbortSignal.timeout(180000),cancelled.signal])});
    if(!response.ok){
     const failure=await response.json().catch(()=>({})),code=failure.error?.code||failure.code;
     console.warn('Alibaba transcription rejected request',JSON.stringify({status:response.status,code:typeof code==='string'?code:null,model}));
     await configService.fail(ticket);ticket=null;
     const message=response.status===401||response.status===403?'Alibaba rejected the server API key or model access. Check DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL.':response.status===429?'Alibaba rate limit reached. Wait a moment and try again.':response.status===400?'Alibaba could not process this audio. Try an MP3 or WAV file under 5 minutes.':'Alibaba speech-to-text is unavailable. Try again shortly.';
     return res.status(response.status===429?429:502).json({message});
    }
    const result=await response.json(),content=result.choices?.[0]?.message?.content;
    if(typeof content!=='string'||content.length>100000)throw new Error('Invalid transcript');
    const seconds=result.usage?.seconds;
    await configService.complete(ticket,{...(Number.isFinite(seconds)?{durationSeconds:seconds}:{}),fileBytes:file.size},false);ticket=null;
    const detected=result.choices[0].message.annotations?.find(item=>typeof item?.language==='string')?.language;
    return res.json({text:content.trim(),model,segments:[],sourceAudioUrl:'',languages:detected?[detected]:[]});
   }
   const body=new FormData();
   body.append('file',new Blob([file.buffer],{type:file.mimetype||'application/octet-stream'}),`audio${extension}`);
   body.append('model',model);
   if(language)body.append('language',language);
   if(timed){body.append('response_format','verbose_json');body.append('timestamp_granularities[]','segment');}
   ticket=await configService.reserve({owner,mode:'stt',config:requestConfig});
   const response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},body,signal:AbortSignal.any([AbortSignal.timeout(180000),cancelled.signal])});
   if(!response.ok){
    const failure=await response.json().catch(()=>({})),code=failure.error?.code;
    console.warn('Lyrics transcription provider rejected request',JSON.stringify({status:response.status,code:typeof code==='string'?code:null,model,requestId:response.headers.get('x-request-id')}));
    await configService.fail(ticket);ticket=null;
    const message=response.status===401||response.status===403?'OpenAI rejected the server API key. Check OPENAI_API_KEY on the API server.':response.status===404||code==='model_not_found'?`The server OpenAI account cannot access ${model}. Check model access in ECHO AI Configuration.`:code==='insufficient_quota'?'The OpenAI account has insufficient API credits. Check the provider billing balance.':response.status===429?'OpenAI rate limit reached. Wait a moment and try again.':response.status===413?'The audio is too large for the transcription service. Try a smaller file.':response.status===400?'OpenAI could not process this audio or language selection. Try an MP3 or WAV file with automatic language detection.':'OpenAI could not complete the transcription. Please try again.';
    return res.status(response.status===429?429:502).json({message});
   }
   const result=await response.json();
   if(typeof result.text!=='string'||result.text.length>100000)throw new Error('Invalid transcript');
   const duration=result.usage?.seconds??result.duration;
   await configService.complete(ticket,{...(Number.isFinite(duration)?{durationSeconds:duration}:{}),fileBytes:file.size},false);ticket=null;
   const segments=timed&&Array.isArray(result.segments)?result.segments.map(row=>({start:row.start,end:row.end,text:typeof row.text==='string'?row.text.trim():''})).filter(row=>Number.isFinite(row.start)&&Number.isFinite(row.end)&&row.start>=0&&row.end>row.start&&row.text).sort((a,b)=>a.start-b.start):[];
   if(timed&&!segments.length)return res.status(422).json({message:'No timed lyric lines were detected. Try a clearer recording.'});
   res.json({text:timed?segments.map(row=>row.text).join('\n'):result.text,model,segments,sourceAudioUrl:timed?sourceAudioUrl:'',languages:Array.isArray(result.languages)?result.languages:[]});
  }catch(error){
   if(ticket)await configService.fail(ticket).catch(()=>{});
   res.status(error.status||502).json({message:error.status===400?error.message:error.name==='TimeoutError'?'Transcription timed out. Try a shorter audio file.':'Could not transcribe this audio. Your existing lyrics are unchanged.'});
  }finally{if(claimed)active.delete(owner);res.off('close',disconnect);}
 });
}
module.exports={registerLyricsTranscription};
