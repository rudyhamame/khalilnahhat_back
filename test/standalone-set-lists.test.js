const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerDjServiceBuilder}=require('../src/dj-service-builder');

async function server(t,{authorized=true,failSave=false}={}){
 const rows=new Map();let next=1;
 const query=value=>({lean:async()=>structuredClone(value),sort(){return this;},limit(){return this;}});
 const StandaloneModel={
  find:()=>query([...rows.values()].reverse()),
  create:async data=>{const row={...data,_id:String(next++).padStart(24,'0'),djSet:{segments:[],notes:''}};rows.set(row._id,row);return {toObject:()=>structuredClone(row)};},
  findById:id=>query(rows.get(id)),
  findByIdAndUpdate:(id,update)=>{if(failSave)throw new Error('Unavailable');const row=rows.get(id);if(row)Object.assign(row,structuredClone(update.$set));return query(row);},
 };
 const app=express();app.use(express.json());
 registerDjServiceBuilder(app,{requireAdmin:(_req,res,next)=>authorized?next():res.sendStatus(403),StandaloneModel,BookingModel:{findOne:()=>{throw new Error('Standalone lists must not access bookings');}},StreamModel:{findOne:()=>{throw new Error('Standalone lists must not access live streams');}}});
 const instance=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
 t.after(()=>new Promise(resolve=>instance.close(resolve)));
 const base=`http://127.0.0.1:${instance.address().port}/api/admin/dj-service-builder/standalone`;
 return async(path='',method='GET',body)=>{const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json().catch(()=>null)};};
}
const plan={segments:[{id:'set',title:'Set list',startsAt:'',endsAt:'',recordingIds:[],manualTracks:[{id:'one',title:'First song',artist:''},{id:'two',title:'Second song',artist:''}],entries:[{type:'manual',id:'two'},{type:'manual',id:'one'}]}],notes:'Practice mix'};

test('standalone lists create, save and reopen an ordered set without a booking or live stream',async t=>{
 const api=await server(t);
 assert.deepEqual((await api()).body.items,[]);
 const created=await api('','POST',{title:'  Practice  '});assert.equal(created.status,201);assert.equal(created.body.item.title,'Practice');
 const id=created.body.item.id;
 const saved=await api('/'+id,'PUT',{djSet:plan});assert.equal(saved.status,200);assert.equal(saved.body.item.trackCount,2);
 const reopened=await api('/'+id);assert.equal(reopened.status,200);assert.deepEqual(reopened.body.djSet.segments[0].entries,plan.segments[0].entries);assert.equal(reopened.body.djSet.notes,'Practice mix');
 const second=await api('','POST',{title:'Another list'});assert.equal(second.status,201);
 assert.equal((await api('/'+second.body.item.id)).body.djSet.segments.length,0);
 const listed=(await api()).body.items;assert.equal(listed.length,2);assert.equal(listed.find(row=>row.id===id).trackCount,2);
});
test('standalone list routes reject invalid titles, invalid plans and missing lists',async t=>{
 const api=await server(t);
 for(const body of [{title:' '},{title:'x'.repeat(181)},{title:'Good',bookingId:'booking'}])assert.equal((await api('','POST',body)).status,400);
 const id=(await api('','POST',{title:'Practice'})).body.item.id;
 assert.equal((await api('/'+id,'PUT',{djSet:{...plan,goal:'booking'}})).status,400);
 assert.equal((await api('/'+id,'PUT',{djSet:{segments:[{...plan.segments[0],entries:[{type:'manual',id:'one'},{type:'manual',id:'one'}]}]}})).status,400);
 for(const missing of ['invalid','000000000000000000000099']){assert.equal((await api('/'+missing)).status,404);assert.equal((await api('/'+missing,'PUT',{djSet:plan})).status,404);}
});
test('all standalone routes require admin access',async t=>{
 const api=await server(t,{authorized:false});
 for(const [path,method,body] of [['','GET'],['','POST',{title:'Practice'}],['/000000000000000000000001','GET'],['/000000000000000000000001','PUT',{djSet:plan}]])assert.equal((await api(path,method,body)).status,403);
});
test('standalone save failure returns a retryable error',async t=>{
 const api=await server(t,{failSave:true});const id=(await api('','POST',{title:'Practice'})).body.item.id;
 const response=await api('/'+id,'PUT',{djSet:plan});assert.equal(response.status,503);assert.match(response.body.message,/retry/);
 assert.equal((await api('/'+id)).body.djSet.segments.length,0);
});
