// Ollama Cloud text provider. Credentials and endpoint configuration stay on the API server.
const failure=(status,message)=>Object.assign(new Error(message),{status});
function createOllama({env=process.env,fetchImpl=fetch}={}){
 let cached=null,until=0,pending=null;
 const base=()=>{
  const url=new URL(env.OLLAMA_BASE_URL||'https://ollama.com/v1');
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw failure(503,'OLLAMA_BASE_URL must be an HTTPS API endpoint without embedded credentials.');
  return url.href.replace(/\/+$/,'');
 };
 const models=async()=>{
  if(cached&&Date.now()<until)return structuredClone(cached);
  if(!pending)pending=(async()=>{
   const response=await fetchImpl(`${base().replace(/\/v1$/,'')}/api/tags`,{signal:AbortSignal.timeout(12000),redirect:'error'});
   if(!response.ok)throw failure(503,'Ollama Cloud model catalog is unavailable. Reload to retry.');
   const data=await response.json();
   if(!Array.isArray(data.models))throw failure(503,'Invalid Ollama Cloud model catalog.');
   cached=data.models.filter(item=>typeof item.name==='string'&&item.name.length<=200&&item.capabilities?.includes('completion')).map(item=>({id:item.name,provider:'ollama',mode:'chat',label:item.name,free:false,pricingUnknown:true,rates:{textInput:0,textCached:0,textOutput:0},source:'https://ollama.com/pricing',checkedOn:new Date().toISOString().slice(0,10)}));
   until=Date.now()+300000;return cached;
  })().finally(()=>{pending=null;});
  return structuredClone(await pending);
 };
 const validate=async config=>{
  const model=(await models()).find(item=>item.id===config.model);
  if(!model)throw failure(400,'Select an available Ollama Cloud text model.');
  return model;
 };
 return {models,validate,configured:()=>Boolean(env.OLLAMA_API_KEY),async request(body,{signal}={}){
  if(!env.OLLAMA_API_KEY)throw failure(503,'Configure OLLAMA_API_KEY on the API server before using Ollama Cloud.');
  await validate(body.config);
  const schema=body.text?.format?.schema;
  // Cloud does not enforce structured outputs. Keep the schema in the prompt;
  // each existing consumer still validates its JSON before applying changes.
  const instructions=`${body.instructions||''}\nReturn exactly one valid JSON object, without markdown or additional text.${schema?` Match this JSON Schema: ${JSON.stringify(schema)}`:''}`;
  const response=await fetchImpl(`${base()}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${env.OLLAMA_API_KEY}`,'Content-Type':'application/json'},signal,redirect:'error',body:JSON.stringify({model:body.config.model,messages:[{role:'system',content:instructions},...body.input],max_tokens:Math.min(body.max_output_tokens||2400,4096),reasoning_effort:'none',stream:false})});
  if(response.status===402)throw failure(503,'The Ollama Cloud account needs usage credits or an active subscription. Choose another configured provider or add credits in Ollama.');
  if(!response.ok)return response;
  const data=await response.json(),choice=data.choices?.[0];
  if(data.error||choice?.finish_reason!=='stop'||typeof choice.message?.content!=='string'||!choice.message.content.trim())throw failure(502,'Ollama Cloud did not complete the reply. Try a different model or retry.');
  return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:choice.message.content}]}],usage:{input_tokens:data.usage?.prompt_tokens,output_tokens:data.usage?.completion_tokens,input_tokens_details:{cached_tokens:data.usage?.prompt_tokens_details?.cached_tokens}}}),{headers:{'Content-Type':'application/json'}});
 }};
}
module.exports={createOllama};
