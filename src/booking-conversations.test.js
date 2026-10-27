const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { registerBookingConversations } = require('./booking-conversations');

async function fixture(t, storeOverride) {
  const records = new Map();
  const store = storeOverride || {
    list: async owner => [...records.values()].filter(item => item.owner === owner),
    get: async (owner,id) => records.get(id)?.owner === owner ? records.get(id) : null,
    append: async (owner,id,messages) => {
      const item=records.get(id)||{_id:id,owner,createdAt:new Date(),updatedAt:new Date(),messages:[]};
      if(item.owner!==owner)return null;
      for(const message of messages)if(!item.messages.some(existing=>existing.id===message.id))item.messages.push({...message,createdAt:new Date()});
      records.set(id,item);return {id};
    },
  };
  const app=express();app.use(express.json());
  registerBookingConversations(app,{store,requireAuth:(req,res,next)=>{if(!req.headers.authorization)return res.sendStatus(401);req.authUser={id:req.headers.authorization};next();}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return (path='',body,owner='alice')=>fetch(`http://127.0.0.1:${server.address().port}/api/ai-booking/conversations${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(owner?{Authorization:owner}:{})},body:body?JSON.stringify(body):undefined});
}
const body = () => ({id:randomUUID(),consent:true,messages:[{id:randomUUID(),role:'user',mode:'chat',content:'A wedding with a DJ.'},{id:randomUUID(),role:'assistant',mode:'chat',content:'What date are you considering?'}]});

test('chat and voice transcripts are retrievable only by their owner',async t=>{
  const request=await fixture(t),input=body();input.messages[1].mode='voice';
  assert.equal((await request('',input)).status,200);
  const list=await request();assert.equal(list.headers.get('cache-control'),'no-store');
  const {items}=await list.json();assert.equal(items.length,1);assert.equal(items[0].id,input.id);assert.equal(items[0].messages,undefined);
  const detail=await (await request('/'+input.id)).json();assert.equal(detail.item.messages.length,2);assert.equal(detail.item.messages[1].mode,'voice');assert.equal(detail.item.owner,undefined);
  assert.equal((await request('/'+input.id,undefined,'bob')).status,404);
  assert.equal((await request('',input,'bob')).status,404);
  assert.deepEqual((await (await request('',undefined,'bob')).json()).items,[]);
});
test('retries do not duplicate saved messages',async t=>{
  const request=await fixture(t),input=body();await request('',input);await request('',input);
  assert.equal((await (await request('/'+input.id)).json()).item.messages.length,2);
});
test('history rejects missing authentication, missing consent, arbitrary roles and oversized messages',async t=>{
  const request=await fixture(t);assert.equal((await request('',undefined,'')).status,401);
  const valid=body();
  for(const input of [{...valid,consent:false},{...valid,id:'not-an-id'},{...valid,messages:[{...valid.messages[0],role:'system'}]},{...valid,messages:[{...valid.messages[0],content:'x'.repeat(4001)}]}])assert.equal((await request('',input)).status,400);
  assert.equal((await request('/invalid')).status,400);
});
test('storage errors remain distinct from an empty history and do not leak transcripts',async t=>{
  const request=await fixture(t,{list:async()=>{throw new Error('secret transcript');}});
  const response=await request();assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/secret/);
});
