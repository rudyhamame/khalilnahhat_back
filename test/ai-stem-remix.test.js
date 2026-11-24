const test=require('node:test'),assert=require('node:assert/strict');
const {createAiStemRemix}=require('../src/ai-stem-remix');
const state={track:{id:'song',title:'A song title',bpm:120},style:'balanced'};
const configService={load:async()=>({mixer:{enabled:true,provider:'openai',model:'mixer-test'}})};
const valid={sequence:[{preset:'instrumental',bars:8},{preset:'full',bars:8}],reason:'Alternate vocals and instrumental sections.'};
const provider=value=>async(_url,options)=>{const body=JSON.parse(options.body);assert.equal(body.model,'mixer-test');assert.equal(body.text.format.name,'stem_remix_plan');return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]});};
test('AI remix plans can arrange only bounded stem presets within one recording',async()=>{
 const result=await createAiStemRemix({configService,env:{OPENAI_API_KEY:'test'},fetchImpl:provider(valid)})(state);assert.deepEqual(result,{...valid,source:'ai'});
});
test('unknown presets, unsafe durations, malformed responses and provider failures stay on labelled local plans',async()=>{
 for(const value of [{...valid,sequence:[{preset:'silence',bars:8},{preset:'full',bars:8}]},{...valid,sequence:[{preset:'rhythm',bars:1},{preset:'full',bars:8}]},{...valid,sequence:[{preset:'rhythm',bars:8},{preset:'instrumental',bars:8}]}])assert.equal((await createAiStemRemix({configService,fetchImpl:provider(value)})(state)).source,'local');
 assert.equal((await createAiStemRemix({configService,fetchImpl:async()=>{throw Error('offline');}})(state)).source,'local');
});
test('invalid client inputs fail before contacting the provider and disabled models use local arrangements',async()=>{
 let called=false;await assert.rejects(()=>createAiStemRemix({configService,fetchImpl:async()=>{called=true;}})({...state,track:{...state.track,bpm:999}}),{status:400});assert.equal(called,false);
 assert.equal((await createAiStemRemix({configService:{load:async()=>({mixer:{enabled:false}})},fetchImpl:async()=>{called=true;}})(state)).source,'local');assert.equal(called,false);
});
test('remix endpoint retains admin authorization and validates its body',async t=>{
 const express=require('express'),{registerAiDj}=require('../src/ai-dj');const app=express();app.use(express.json());registerAiDj(app,{requireAdmin:(req,res,next)=>req.headers.authorization==='admin'?next():res.sendStatus(403),configService:{load:async()=>({mixer:{enabled:false}})}});
 const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));t.after(()=>new Promise(done=>server.close(done)));
 const post=(body,auth='admin')=>fetch(`http://127.0.0.1:${server.address().port}/api/admin/ai-dj/remix-plan`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:auth},body:JSON.stringify(body)});
 assert.equal((await post(state,'client')).status,403);assert.equal((await post({})).status,400);const r=await post(state);assert.equal(r.status,200);assert.equal((await r.json()).plan.source,'local');
});
