const {createAlibaba}=require('./alibaba');
const failure=(status,message)=>Object.assign(new Error(message),{status});
const router={id:'openrouter/free',provider:'openrouter',mode:'chat',label:'Free models router',free:true,rates:{textInput:0,textCached:0,textOutput:0},source:'https://openrouter.ai/openrouter/free'};
function createOpenRouter({env=process.env,fetchImpl=fetch}={}){
 let cache=null,until=0,pending=null;
 const alibaba=createAlibaba({env,fetchImpl});
 const models=async()=>{
  if(cache&&Date.now()<until)return structuredClone(cache);
  if(!pending)pending=(async()=>{
   const r=await fetchImpl('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(15000)});
   if(!r.ok)throw failure(503,'OpenRouter model catalog is unavailable. Please retry.');
   const body=await r.json();if(!Array.isArray(body.data))throw failure(503,'Invalid OpenRouter model catalog.');
   cache=[router,...body.data.filter(m=>m.id!=='openrouter/free'&&m.architecture?.output_modalities?.includes('text')&&m.supported_parameters?.includes('structured_outputs')).flatMap(m=>{
    const input=Number(m.pricing?.prompt),output=Number(m.pricing?.completion),request=Number(m.pricing?.request||0);
    if(![input,output,request].every(n=>Number.isFinite(n)&&n>=0)||typeof m.id!=='string')return [];
    return [{id:m.id,provider:'openrouter',mode:'chat',label:m.name||m.id,free:input===0&&output===0&&request===0,rates:{textInput:input*1e6,textCached:Math.min(input,Number(m.pricing?.input_cache_read||input))*1e6,textOutput:output*1e6},source:`https://openrouter.ai/${m.id}`,checkedOn:new Date().toISOString().slice(0,10)}];
   })];until=Date.now()+300000;return cache;
  })().finally(()=>{pending=null;});
  return structuredClone(await pending);
 };
 const validate=async config=>{
  const model=(await models()).find(m=>m.id===config.model);
  if(!model)throw failure(400,'Select an available OpenRouter text model with structured outputs.');
  if(config.freeOnly!==false&&!model.free)throw failure(400,'Free-only mode blocks paid models.');
  return model;
 };
 return {models,validate,alibaba,configured:()=>Boolean(env.OPENROUTER_API_KEY),async request(body,{signal}={}){
  if(body.config?.provider==='alibaba')return alibaba.request(body,{signal});
  if(!env.OPENROUTER_API_KEY)throw failure(503,'Configure OPENROUTER_API_KEY in Render before using OpenRouter.');
  await validate(body.config);
  const request={model:body.config.model,messages:[{role:'system',content:body.instructions},...body.input],max_tokens:body.max_output_tokens,response_format:{type:'json_schema',json_schema:{name:body.text.format.name,strict:true,schema:body.text.format.schema}},stream:false,provider:{require_parameters:true,allow_fallbacks:false,...(body.config.freeOnly!==false?{max_price:{prompt:0,completion:0,request:0}}:{})}};
  let data;let usageKnown=true;const totals={prompt_tokens:0,completion_tokens:0,cached_tokens:0};
  for(let attempt=0;attempt<2;attempt++){
   const response=await fetchImpl('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'Content-Type':'application/json','X-Title':'Echo Event Entertainment'},signal,body:JSON.stringify(request)});
   if(!response.ok)return response;
   data=await response.json();if(!Number.isInteger(data.usage?.prompt_tokens)||!Number.isInteger(data.usage?.completion_tokens))usageKnown=false;for(const field of ['prompt_tokens','completion_tokens'])totals[field]+=data.usage?.[field]||0;totals.cached_tokens+=data.usage?.prompt_tokens_details?.cached_tokens||0;
   if(data.choices?.[0]?.finish_reason!=='length'||attempt||body.config.freeOnly===false)break;
   const nextTokens=Math.min(Math.max((request.max_tokens||600)*2,1600),body.config.maxOutputTokens||4096);if(nextTokens<=request.max_tokens)break;request.max_tokens=nextTokens;
  }
  const choice=data.choices?.[0];
  if(data.error||!choice||!['stop','tool_calls'].includes(choice.finish_reason))throw failure(502,'OpenRouter did not complete the booking reply.');
  const message=choice.message;
  if(!message?.refusal&&typeof message?.content!=='string')throw failure(502,'OpenRouter returned an invalid booking reply.');
  return new Response(JSON.stringify({status:'completed',output:[{content:[message.refusal?{type:'refusal',refusal:message.refusal}:{type:'output_text',text:message.content}]}],usage:{input_tokens:usageKnown?totals.prompt_tokens:undefined,output_tokens:usageKnown?totals.completion_tokens:undefined,input_tokens_details:{cached_tokens:usageKnown?totals.cached_tokens:undefined}}}),{headers:{'Content-Type':'application/json'}});
 }};
}
// The API key a chat provider needs; every chat call site uses this so a new provider only has to be added here.
const providerKey=(env,provider)=>provider==='openrouter'?env.OPENROUTER_API_KEY:provider==='alibaba'?env.DASHSCOPE_API_KEY:env.OPENAI_API_KEY;
module.exports={createOpenRouter,providerKey};
