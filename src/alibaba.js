// Alibaba Cloud Model Studio (Qwen) through its OpenAI-compatible chat API. Needs DASHSCOPE_API_KEY on the server.
// DASHSCOPE_BASE_URL overrides the endpoint (default: the international one).
const failure=(status,message)=>Object.assign(new Error(message),{status});
const DEFAULT_BASE='https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const MODELS=[['qwen-plus','Qwen Plus'],['qwen-max','Qwen Max'],['qwen-turbo','Qwen Turbo']];
// Prices are not hard-coded: the admin enters them from the Model Studio price list, so cost estimates are never invented.
const catalog=()=>MODELS.map(([id,label])=>({id,provider:'alibaba',mode:'chat',label,free:false,editableRates:true,rates:{textInput:0,textCached:0,textOutput:0},source:'https://www.alibabacloud.com/help/en/model-studio/models'}));
function createAlibaba({env=process.env,fetchImpl=fetch}={}){
 const base=()=>String(env.DASHSCOPE_BASE_URL||DEFAULT_BASE).replace(/\/+$/,'');
 return {
  models:catalog,
  configured:()=>Boolean(env.DASHSCOPE_API_KEY),
  validate(config){const model=catalog().find(item=>item.id===config.model);if(!model)throw failure(400,'Select a supported Alibaba Cloud model.');return model;},
  // Takes the same Responses-style body as the other providers and returns a Responses-style reply.
  async request(body,{signal}={}){
   if(!env.DASHSCOPE_API_KEY)throw failure(503,'Configure DASHSCOPE_API_KEY on the server before using Alibaba Cloud.');
   const schema=body.text?.format?.schema;
   // JSON mode needs the word JSON in the prompt; the schema goes in the prompt because it is not enforced by the API.
   const instructions=`${body.instructions||''}\nReturn ONLY one valid JSON object, no markdown.${schema?` It must match this JSON Schema: ${JSON.stringify(schema)}`:''}`;
   const payload={model:body.config.model,messages:[{role:'system',content:instructions},...body.input],max_tokens:Math.min(body.max_output_tokens||2000,8192),response_format:{type:'json_object'},stream:false};
   const response=await fetchImpl(`${base()}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${env.DASHSCOPE_API_KEY}`,'Content-Type':'application/json'},signal,body:JSON.stringify(payload)});
   if(!response.ok)return response;
   const data=await response.json(),choice=data.choices?.[0];
   if(!choice||typeof choice.message?.content!=='string'||!['stop','tool_calls'].includes(choice.finish_reason))throw failure(502,'Alibaba Cloud did not complete the reply.');
   return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:choice.message.content}]}],usage:{input_tokens:data.usage?.prompt_tokens,output_tokens:data.usage?.completion_tokens,input_tokens_details:{cached_tokens:data.usage?.prompt_tokens_details?.cached_tokens}}}),{headers:{'Content-Type':'application/json'}});
  },
 };
}
module.exports={createAlibaba,catalog};
