const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerEventDrafts}=require('./event-drafts');
const {createEventOrder}=require('./event-order');
async function fixture(t){
  const records=new Map();const store={get:async owner=>records.get(owner)||null,put:async(owner,version,order)=>{const old=records.get(owner);if((old?.version||0)!==version)return null;const item={order,version:version+1,updatedAt:new Date()};records.set(owner,item);return item;},remove:async(owner,version)=>{if(records.get(owner)?.version!==version)return false;return records.delete(owner);}};
  const app=express();app.use(express.json());registerEventDrafts(app,{store,requireAuth:(req,res,next)=>{if(!req.headers.authorization)return res.sendStatus(401);req.authUser={id:req.headers.authorization};next();}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  return (method='GET',body,owner='alice',query='')=>fetch(`http://127.0.0.1:${server.address().port}/api/ai-booking/event-draft${query}`,{method,headers:{'Content-Type':'application/json',...(owner?{Authorization:owner}:{})},body:body?JSON.stringify(body):undefined});
}
test('incomplete drafts are private, persist and resume without submitting',async t=>{
  const request=await fixture(t),order=createEventOrder();order.event.type='wedding';
  assert.equal((await request('GET',undefined,'')).status,401);
  assert.equal((await request('PUT',{version:0,order})).status,200);
  const item=(await(await request()).json()).item;assert.equal(item.order.event.type,'wedding');assert.equal(item.version,1);assert.equal(item.owner,undefined);
  assert.equal((await(await request('GET',undefined,'bob')).json()).item,null);
  assert.equal((await request('DELETE',undefined,'bob','?version=1')).status,409);
  assert.equal((await request()).headers.get('cache-control'),'no-store');
});
test('stale saves and deletes cannot overwrite another device',async t=>{
  const request=await fixture(t),order=createEventOrder();await request('PUT',{version:0,order});
  assert.equal((await request('PUT',{version:0,order})).status,409);
  assert.equal((await request('PUT',{version:1,order})).status,200);
  assert.equal((await request('DELETE',undefined,'alice','?version=1')).status,409);
  assert.equal((await request('DELETE',undefined,'alice','?version=2')).status,200);
  assert.equal((await(await request()).json()).item,null);
});
test('invalid values and supplied account identifiers are rejected',async t=>{
  const request=await fixture(t),order=createEventOrder();order.event.guestCount='bad';
  assert.equal((await request('PUT',{version:0,order})).status,400);
  assert.equal((await request('PUT',{version:0,order:createEventOrder(),owner:'bob'})).status,400);
});
