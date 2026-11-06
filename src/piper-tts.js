// Private server-to-server Piper proxy. Never send the origin credential to clients.
function piperConfigured(env=process.env){return Boolean(env.PIPER_TTS_URL&&env.PIPER_TTS_API_KEY);}
function registerPiperTts(app,{requireAuth,policy,admitted,fetchImpl=fetch,env=process.env}){
 const active=new Set();
 app.post('/api/ai-booking/speech',requireAuth,async(req,res)=>{
  const config=await policy(res,'voice');if(!config)return;
  if(config.tts?.provider!=='piper'||!piperConfigured(env))return res.status(503).json({message:'Piper is unavailable. Browser speech is available as fallback.'});
  const {text,language}=req.body||{};
  if(typeof text!=='string'||!text.trim()||text.length>600||!['en','ar'].includes(language))return res.status(400).json({message:'Provide 1–600 characters and an English or Arabic voice.'});
  const owner=String(req.authUser?._id||req.authUser?.id||'');
  if(!owner)return res.status(401).json({message:'Sign in to use speech.'});
  if(active.has(owner)||active.size>=8)return res.status(429).json({message:'Speech is busy. Please retry.'});
  if(!admitted(req,res,'chat',60,config,{bucketKind:'tts'}))return;
  active.add(owner);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnected);
  try{
   const origin=new URL(env.PIPER_TTS_URL);
   if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname)))throw Error('Invalid Piper origin');
   const upstream=await fetchImpl(origin,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.PIPER_TTS_API_KEY}`},body:JSON.stringify({text:text.trim(),language})});
   if(!upstream.ok||!upstream.headers.get('content-type')?.includes('audio/wav')){await upstream.body?.cancel();throw Error('Piper unavailable');}
   const chunks=[];let size=0;
   for await(const chunk of upstream.body){size+=chunk.length;if(size>4*1024*1024){controller.abort();throw Error('Piper output too large');}chunks.push(chunk);}
   if(!res.destroyed)res.set({'Content-Type':'audio/wav','Cache-Control':'no-store'}).send(Buffer.concat(chunks));
  }catch{if(!res.headersSent&&!res.destroyed)res.status(503).json({message:'Piper could not generate speech. Using browser speech fallback.'});}
  finally{clearTimeout(timer);res.off('close',disconnected);active.delete(owner);}
 });
}
module.exports={piperConfigured,registerPiperTts};
