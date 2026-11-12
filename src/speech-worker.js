// Whisper on the OVH stem worker (the browser used to run these models and froze).
// Two small jobs, one 30 s clip each: the language of a clip, and the Arabic transcription of a clip.
// The runtime (@huggingface/transformers) is installed beside the worker (SPEECH_RUNTIME_DIR) and its models are cached on disk.
const express=require('express');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createRequire}=require('node:module');
const {WHISPER_LANGUAGES}=require('./whisper-languages');

const RUNTIME=process.env.SPEECH_RUNTIME_DIR||'/app/speech',CACHE=process.env.SPEECH_MODEL_DIR||'/models';
const MAX_BYTES=16000*2*31; // 31 s of 16-bit mono at 16 kHz
let runtime,language,asr,tail=Promise.resolve();
async function lib(){
 if(!runtime)runtime=(async()=>{
  const entry=createRequire(path.join(RUNTIME,'package.json')).resolve('@huggingface/transformers');
  const loaded=await import(pathToFileURL(entry).href),mod=loaded.env?loaded:loaded.default; // CommonJS entries put the exports under default
  mod.env.cacheDir=CACHE;return mod;
 })().catch(error=>{runtime=undefined;throw error;});
 return runtime;
}
async function loadLanguage(){
 if(!language)language=(async()=>{
  const M='onnx-community/whisper-tiny',t=await lib();
  const [tokenizer,processor,model]=await Promise.all([t.AutoTokenizer.from_pretrained(M),t.AutoProcessor.from_pretrained(M),t.WhisperForConditionalGeneration.from_pretrained(M,{dtype:'q8'})]);
  return {t,tokenizer,processor,model};
 })().catch(error=>{language=undefined;throw error;});
 return language;
}
async function loadAsr(){
 if(!asr)asr=lib().then(t=>t.pipeline('automatic-speech-recognition','onnx-community/whisper-base',{dtype:'q8'})).catch(error=>{asr=undefined;throw error;});
 return asr;
}
// Only the first decoder step: the probabilities Whisper gives its language tokens.
async function rankLanguages(clip){
 const {t,tokenizer,processor,model}=await loadLanguage(),inputs=await processor(clip),start=tokenizer.convert_tokens_to_ids(['<|startoftranscript|>'])[0];
 const ids=WHISPER_LANGUAGES.map(code=>tokenizer.convert_tokens_to_ids([`<|${code}|>`])[0]);
 const {logits}=await model({input_features:inputs.input_features,decoder_input_ids:new t.Tensor('int64',BigInt64Array.from([BigInt(start)]),[1,1])});
 const row=logits.data,scores=ids.map(id=>row[id]),top=Math.max(...scores),exp=scores.map(value=>Math.exp(value-top)),sum=exp.reduce((a,b)=>a+b,0);
 return WHISPER_LANGUAGES.map((code,index)=>({code,probability:exp[index]/sum})).sort((a,b)=>b.probability-a.probability).slice(0,5);
}
async function transcribeArabic(clip){
 const pipe=await loadAsr(),result=await pipe(clip,{language:'arabic',task:'transcribe'});
 return {text:String(result?.text||'')};
}
// Raw little-endian 16-bit mono PCM -> Float32Array in [-1, 1].
const toFloat=buffer=>{const view=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength-buffer.byteLength%2),out=new Float32Array(view.byteLength/2);for(let i=0;i<out.length;i++)out[i]=view.getInt16(i*2,true)/32768;return out;};
const inOrder=job=>{const run=tail.then(job);tail=run.catch(()=>{});return run;}; // one inference at a time (1 CPU thread)

function registerSpeech(app){
 const body=express.raw({type:'application/octet-stream',limit:MAX_BYTES});
 const handle=work=>async(req,res)=>{
  if(!Buffer.isBuffer(req.body)||req.body.length<3200)return res.status(400).json({message:'Send 16 kHz mono 16-bit audio.'});
  try{res.set('Cache-Control','no-store').json(await inOrder(()=>work(toFloat(req.body))));}
  catch(error){console.error('Speech worker:',error.message);res.status(503).json({message:'The speech model is unavailable right now.'});}
 };
 app.post('/api/admin/speech/language',body,handle(async clip=>({ranked:await rankLanguages(clip)})));
 app.post('/api/admin/speech/transcribe',body,handle(transcribeArabic));
}
module.exports={registerSpeech,toFloat};
