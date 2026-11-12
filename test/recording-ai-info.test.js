const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerRecordingAiInfo,isFree}=require('../src/recording-ai-info');
const chat={enabled:true,provider:'openrouter',model:'openrouter/free',freeOnly:true,providerRates:{textInput:0,textCached:0,textOutput:0}};
async function run({config=chat,reply,body}){
 const app=express();app.use(express.json());
 const calls=[];
 const fetchImpl=async(url,init)=>{
  if(String(url).includes('/models'))return Response.json({data:[]});
  calls.push(JSON.parse(init.body));
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(reply)}}],usage:{prompt_tokens:10,completion_tokens:10}});
 };
 registerRecordingAiInfo(app,{requireAdmin:(_q,_r,next)=>next(),configService:{load:async()=>({chat:config})},env:{OPENROUTER_API_KEY:'k'},fetchImpl});
 const server=app.listen(0);const port=server.address().port;
 const response=await fetch(`http://127.0.0.1:${port}/api/admin/music-archive/ai-info`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const json=await response.json();server.close();return {status:response.status,json,calls};
}
const body={filename:'Najwa_Karam_-_Lshhad_Hobak_REMIX_(House)_official.mp3',tags:{},analysis:{bpms:[124],keys:['A minor'],languages:['Arabic'],dialects:['Lebanese']},workTypes:[{id:'REMIX',name:'Remix'},{id:'MIX',name:'Mix'}]};
test('free model fills name and work type, only from allowed ids',async()=>{
 const {status,json,calls}=await run({reply:{title:'Najwa Karam - Lshhad Hobak (House Remix)',workTypeId:'REMIX',releaseYear:null,confidence:'high',reason:'The file name says remix.'},body});
 assert.equal(status,200);assert.equal(json.workTypeId,'REMIX');assert.match(json.title,/House Remix/);assert.equal(calls[0].response_format.json_schema.schema.properties.workTypeId.enum.includes('MIX'),true);
});
test('an id the model invents is dropped',async()=>{
 const {json}=await run({reply:{title:'X',workTypeId:'HACK',releaseYear:3000,confidence:'high',reason:''},body});
 assert.equal(json.workTypeId,null);assert.equal(json.releaseYear,null);
});
test('paid models are refused',async()=>{
 const {status}=await run({config:{...chat,freeOnly:false},reply:{},body});assert.equal(status,403);
 assert.equal(isFree({provider:'poe',providerRates:{textInput:1,textCached:0,textOutput:1}}),false);
});
