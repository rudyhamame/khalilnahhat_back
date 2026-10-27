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
