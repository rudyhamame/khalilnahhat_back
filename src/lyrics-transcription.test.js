const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerLyricsTranscription}=require('./lyrics-transcription');

async function start({stt,env,fetchImpl}){
 const calls=[];
 const configService={load:async()=>({stt}),reserve:async x=>{calls.push(['reserve',x.config.stt.provider,x.config.stt.model]);return {id:1};},complete:async(_t,m)=>calls.push(['complete',m]),fail:async()=>calls.push(['fail'])};
 const app=express();registerLyricsTranscription(app,{requireAdmin:(_q,_s,n)=>n(),configService,fetchImpl,env});
 const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});
 const post=async(fields={})=>{const form=new FormData();form.append('file',new Blob([Buffer.from('abc')],{type:'audio/mpeg'}),'a.mp3');for(const [k,v] of Object.entries(fields))form.append(k,v);return fetch(`http://127.0.0.1:${server.address().port}/api/admin/music-ontology/lyrics-transcription`,{method:'POST',body:form});};
 return {post,calls,close:()=>server.close()};
}
const alibabaStt={enabled:true,provider:'alibaba',model:'qwen3-asr-flash',providerRates:{audioMinute:0.0021},requestsPer10Min:6};

test('Alibaba speech-to-text sends a base64 data URL with the DashScope key and returns plain text',async()=>{
 const seen=[];
 const t=await start({stt:alibabaStt,env:{DASHSCOPE_API_KEY:'ds-key'},fetchImpl:async(url,init)=>{seen.push([url,init.headers.Authorization,JSON.parse(init.body)]);return {ok:true,json:async()=>({choices:[{message:{content:' hello there ',annotations:[{type:'audio_info',language:'en'}]}}],usage:{seconds:12}})};}});
 const response=await t.post({language:'en'});const body=await response.json();t.close();
 assert.equal(response.status,200);assert.equal(body.text,'hello there');assert.deepEqual(body.segments,[]);assert.deepEqual(body.languages,['en']);
 assert.match(seen[0][0],/dashscope-intl\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions$/);assert.equal(seen[0][1],'Bearer ds-key');
 assert.equal(seen[0][2].model,'qwen3-asr-flash');assert.match(seen[0][2].messages[0].content[0].input_audio.data,/^data:audio\/mpeg;base64,/);assert.equal(seen[0][2].asr_options.language,'en');
 assert.deepEqual(t.calls.find(c=>c[0]==='complete')[1],{durationSeconds:12,fileBytes:3});
});

test('Alibaba speech-to-text needs DASHSCOPE_API_KEY and unsupported languages fall back to auto-detect',async()=>{
 const missing=await start({stt:alibabaStt,env:{},fetchImpl:async()=>{throw Error('no call');}});
 assert.equal((await missing.post()).status,503);missing.close();
 const seen=[];
 const t=await start({stt:alibabaStt,env:{DASHSCOPE_API_KEY:'k'},fetchImpl:async(_u,init)=>{seen.push(JSON.parse(init.body));return {ok:true,json:async()=>({choices:[{message:{content:'x'}}]})};}});
 assert.equal((await t.post({language:'fa'})).status,200);t.close();
 assert.equal('language' in seen[0].asr_options,false);
});

test('Alibaba provider failures refund the reservation and hide provider detail',async()=>{
 const t=await start({stt:alibabaStt,env:{DASHSCOPE_API_KEY:'k'},fetchImpl:async()=>({ok:false,status:401,headers:new Headers(),json:async()=>({error:{code:'InvalidApiKey'}})})});
 const response=await t.post();const body=await response.json();t.close();
 assert.equal(response.status,502);assert.match(body.message,/DASHSCOPE_API_KEY/);assert.ok(t.calls.some(c=>c[0]==='fail'));
});

test('timed lyrics keep using OpenAI Whisper even when Alibaba is the provider',async()=>{
 const t=await start({stt:alibabaStt,env:{DASHSCOPE_API_KEY:'k'},fetchImpl:async()=>{throw Error('no call');}});
 const response=await t.post({timestamps:'true'});const body=await response.json();t.close();
 assert.equal(response.status,503);assert.match(body.message,/OPENAI_API_KEY/);
});
