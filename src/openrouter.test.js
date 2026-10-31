const {test}=require('node:test');const assert=require('node:assert/strict');
const {createOpenRouter}=require('./openrouter');
const model=(id,price='0',params=['structured_outputs'])=>({id,name:id,architecture:{output_modalities:['text']},supported_parameters:params,pricing:{prompt:price,completion:price}});
test('catalog filters unsupported models, preserves prices, and free-only rejects paid models',async()=>{
 const client=createOpenRouter({env:{OPENROUTER_API_KEY:'secret'},fetchImpl:async()=>Response.json({data:[model('vendor/free:free'),model('vendor/paid','0.000001'),model('embeddings','0',[])]})});
 const models=await client.models();assert.deepEqual(models.map(m=>m.id),['openrouter/free','vendor/free:free','vendor/paid']);assert.equal(models[2].rates.textInput,1);
 await assert.rejects(client.validate({model:'vendor/paid',freeOnly:true}),{status:400});assert.equal((await client.validate({model:'vendor/paid',freeOnly:false})).free,false);
 await assert.rejects(client.validate({model:'embeddings'}),{status:400});
});
test('missing key and incomplete provider output fail closed',async()=>{
 const body={config:{model:'openrouter/free'},instructions:'system',input:[],max_output_tokens:256,text:{format:{name:'test',schema:{type:'object'}}}};
 await assert.rejects(createOpenRouter({env:{}}).request(body),{status:503});
 for(const output of [{error:{message:'private'}},{choices:[{finish_reason:'length',message:{content:'partial'}}]}]){
  const client=createOpenRouter({env:{OPENROUTER_API_KEY:'secret'},fetchImpl:async url=>Response.json(url.endsWith('/models')?{data:[]}:output)});
  await assert.rejects(client.request(body),e=>e.status===502&&!e.message.includes('private'));
 }
});
test('Poe exposes account models and sends Responses requests with the server key',async()=>{
 const calls=[];
 const client=createOpenRouter({env:{POE_API_KEY:'poe-secret'},fetchImpl:async(url,options={})=>{
  calls.push({url,options});
  if(url.endsWith('/models'))return Response.json({data:[{id:'Claude-Sonnet',name:'Claude Sonnet'},{id:'GPT-4o'}]});
  return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'ok'}]}]});
 }});
 const models=await client.poe.models();
 assert.deepEqual(models.map(item=>item.id),['Claude-Sonnet','GPT-4o']);
 assert.equal(models[0].provider,'poe');assert.equal(models[0].pricingUnknown,true);
 const response=await client.request({config:{provider:'poe',model:'Claude-Sonnet'},instructions:'system',input:[],max_output_tokens:256});
 assert.equal(response.status,200);
 assert.equal(calls[2].url,'https://api.poe.com/v1/responses');
 assert.equal(calls[2].options.headers.Authorization,'Bearer poe-secret');
 assert.equal(JSON.parse(calls[2].options.body).model,'Claude-Sonnet');
 assert.equal(JSON.parse(calls[2].options.body).config,undefined);
});
test('Poe fails closed without a key or for models outside the account catalog',async()=>{
 const request={config:{provider:'poe',model:'unavailable'},input:[]};
 await assert.rejects(createOpenRouter({env:{}}).request(request),{status:503});
 const client=createOpenRouter({env:{POE_API_KEY:'secret'},fetchImpl:async()=>Response.json({data:[{id:'available'}]})});
 await assert.rejects(client.request(request),{status:400});
});
