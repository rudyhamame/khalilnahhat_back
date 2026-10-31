const {randomUUID}=require('node:crypto');
const {providerKey}=require('../openrouter');
const {failure}=require('./route-adapter');
function messagesFrom(input,instructions){
 const messages=[{role:'system',content:instructions}];
 for(const item of input){
  if(item.type==='function_call'){const previous=messages[messages.length-1];const call={id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}};if(previous.role==='assistant'&&previous.tool_calls)previous.tool_calls.push(call);else messages.push({role:'assistant',content:null,tool_calls:[call]});}
  else if(item.type==='function_call_output')messages.push({role:'tool',tool_call_id:item.call_id,content:String(item.output)});
  else if(['user','assistant','developer','system'].includes(item.role))messages.push({role:item.role==='developer'?'system':item.role,content:typeof item.content==='string'?item.content:(item.content||[]).map(part=>part.text||'').join('\n')});
 }
 return messages;
}
async function providerRequest(body,config,{env=process.env,fetchImpl=fetch,signal}={}){
 const key=providerKey(env,config.provider);if(!key)throw failure(503,`Configure the server API key for Administrator ${config.provider}.`);
 if(config.provider==='openai')return fetchImpl('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 const base={openrouter:'https://openrouter.ai/api/v1',poe:'https://api.poe.com/v1',alibaba:env.DASHSCOPE_BASE_URL||'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',ollama:env.OLLAMA_BASE_URL||'https://ollama.com/v1'}[config.provider];
 if(!base)throw failure(400,'Unsupported Administrator text provider.');
 const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw failure(503,'The administrator provider endpoint must use HTTPS without embedded credentials.');
 const request={model:config.model,messages:messagesFrom(body.input,body.instructions),tools:body.tools.map(({type,name,description,parameters})=>({type,function:{name,description,parameters}})),tool_choice:'auto',parallel_tool_calls:false,max_tokens:body.max_output_tokens,stream:false,...(config.provider==='alibaba'?{enable_thinking:false}:{}),...(config.provider==='openrouter'?{provider:{require_parameters:true,allow_fallbacks:false,...(config.freeOnly?{max_price:{prompt:0,completion:0,request:0}}:{})}}:{})};
 const response=await fetchImpl(url.href.replace(/\/+$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Title':'Echo AI Administrator'},body:JSON.stringify(request),signal,redirect:'error'});
 if(!response.ok)return response;
 const result=await response.json(),choice=result.choices?.[0];if(result.error||!choice||!['stop','tool_calls'].includes(choice.finish_reason))throw failure(503,`${config.provider} did not complete the administrator response. No new action was executed.`);
 const message=choice.message;if(!message||message.refusal)throw failure(503,'The provider could not handle this administrator request.');
 const output=[];
 if(message.content)output.push({type:'message',role:'assistant',content:[{type:'output_text',text:message.content}]});
 for(const call of message.tool_calls||[]){if(call.type!=='function'||typeof call.function?.name!=='string'||typeof call.function.arguments!=='string')throw failure(503,'The provider returned an invalid action.');output.push({type:'function_call',id:call.id||randomUUID(),call_id:call.id||randomUUID(),name:call.function.name,arguments:call.function.arguments});}
 return new Response(JSON.stringify({status:'completed',output,usage:{input_tokens:result.usage?.prompt_tokens,output_tokens:result.usage?.completion_tokens,input_tokens_details:{cached_tokens:result.usage?.prompt_tokens_details?.cached_tokens}}}),{headers:{'Content-Type':'application/json'}});
}
module.exports={providerRequest};
