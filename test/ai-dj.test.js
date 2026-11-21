const test=require('node:test'),assert=require('node:assert/strict');
const {createAiDj}=require('../src/ai-dj');
const state={current:{id:'a',title:'A',bpm:120},candidates:[{id:'b',title:'B',bpm:122},{id:'c',title:'C',bpm:90}],played:[],direction:'balanced'};

test('AI DJ validates the model selection against the supplied library',async()=>{
 const configService={load:async()=>({chat:{enabled:true,provider:'openai',model:'test'}})};
 const fetchImpl=async()=>Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({nextTrackId:'invented',transitionBars:8,cueSeconds:0,targetBpm:122,style:'smooth',reason:'x'})}]}]});
 const result=await createAiDj({configService,env:{OPENAI_API_KEY:'test'},fetchImpl})(state);
 assert.equal(result.nextTrackId,'b');assert.equal(result.source,'local');
});

test('AI DJ returns a valid provider plan',async()=>{
 const configService={load:async()=>({chat:{enabled:true,provider:'openai',model:'test'}})};
 const plan={nextTrackId:'c',transitionBars:16,cueSeconds:2,targetBpm:118,style:'energy-lift',reason:'Controlled contrast.'};
 const fetchImpl=async()=>Response.json({output:[{content:[{type:'output_text',text:JSON.stringify(plan)}]}]});
 assert.deepEqual(await createAiDj({configService,env:{OPENAI_API_KEY:'test'},fetchImpl})(state),{...plan,source:'ai'});
});
