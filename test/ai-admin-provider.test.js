const {test}=require('node:test');
const assert=require('node:assert/strict');
const {providerRequest}=require('../src/ai-admin/provider-request');
const {createEchoAdminAgent}=require('../src/ai-admin/agent');

test('OpenRouter Administrator permits compatible provider fallback',async()=>{
 let sent;
 const response=await providerRequest({
  input:[{role:'user',content:'Read the dashboard'}],instructions:'Use tools.',tools:[],max_output_tokens:1500,
 },{provider:'openrouter',model:'openrouter/free',freeOnly:true},{
  env:{OPENROUTER_API_KEY:'test-key'},
  fetchImpl:async(url,options)=>{sent={url,body:JSON.parse(options.body)};return Response.json({choices:[{finish_reason:'stop',message:{content:'Done'}}]});},
 });
 assert.equal(response.ok,true);
 assert.equal(sent.url,'https://openrouter.ai/api/v1/chat/completions');
 assert.equal(sent.body.provider.require_parameters,true);
 assert.equal(sent.body.provider.allow_fallbacks,true);
 assert.deepEqual(sent.body.provider.max_price,{prompt:0,completion:0,request:0});
});

test('Administrator explains an unavailable OpenRouter model instead of reporting a generic quota failure',async()=>{
 const agent=createEchoAdminAgent({
  registry:{list:()=>[]},
  env:{OPENROUTER_API_KEY:'test-key'},
  configService:{load:async()=>({})},
  adminServices:{load:async()=>({text:{enabled:true,provider:'openrouter',model:'vendor/retired-model',freeOnly:false,maxOutputTokens:1500}})},
  fetchImpl:async()=>Response.json({error:{code:404,message:'No endpoints found'}},{status:404}),
 });
 await assert.rejects(()=>agent.next({owner:'admin',input:[{role:'user',content:'Read the dashboard'}]}),error=>{
  assert.equal(error.status,503);
  assert.match(error.message,/compatible endpoint/);
  assert.match(error.message,/ECHO AI Configuration/);
  assert.doesNotMatch(error.message,/quota/i);
  return true;
 });
});
