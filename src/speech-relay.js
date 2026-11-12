// API side of the speech jobs: the admin editor sends one 30 s clip, the stem worker on OVH runs Whisper and answers.
const express=require('express');
const MAX_BYTES=16000*2*31;
function registerSpeechRelay(app,{requireAdmin,env=process.env,fetchImpl=fetch}){
 const body=express.raw({type:'application/octet-stream',limit:MAX_BYTES});
 const relay=task=>async(req,res)=>{
  if(!env.STEM_WORKER_URL)return res.status(503).json({message:'The speech service is not configured.'});
  if(!Buffer.isBuffer(req.body)||req.body.length<3200)return res.status(400).json({message:'Send 16 kHz mono 16-bit audio.'});
  try{
   const response=await fetchImpl(new URL(`/api/admin/speech/${task}`,env.STEM_WORKER_URL),{method:'POST',headers:{'Content-Type':'application/octet-stream',Authorization:`Bearer ${env.STEM_WORKER_TOKEN||''}`},body:req.body,redirect:'error',signal:AbortSignal.timeout(90000)});
   res.status(response.status).set('Cache-Control','no-store').json(await response.json());
  }catch(error){console.error('Speech relay:',error.name);res.status(503).json({message:'The speech service is unavailable right now.'});}
 };
 app.post('/api/admin/music-archive/speech/language',requireAdmin,body,relay('language'));
 app.post('/api/admin/music-archive/speech/transcribe',requireAdmin,body,relay('transcribe'));
}
// Asked before an OVH worker process starts: is the server too busy right now? Unreachable counts as busy.
function registerWorkerLoad(app,{requireAdmin,env=process.env,fetchImpl=fetch}){
 app.get('/api/admin/music-archive/worker-load',requireAdmin,async(_req,res)=>{
  res.set('Cache-Control','no-store');
  if(!env.STEM_WORKER_URL)return res.json({busy:true,reason:'The OVH worker is not configured.'});
  try{
   const response=await fetchImpl(new URL('/api/admin/worker-load',env.STEM_WORKER_URL),{headers:{Authorization:`Bearer ${env.STEM_WORKER_TOKEN||''}`},redirect:'error',signal:AbortSignal.timeout(8000)});
   if(!response.ok)throw Error(`HTTP ${response.status}`);
   res.json(await response.json());
  }catch{res.json({busy:true,reason:'The OVH worker is not answering.'});}
 });
}
module.exports={registerWorkerLoad,registerSpeechRelay};
