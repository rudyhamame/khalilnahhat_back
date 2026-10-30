const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const mongoose=require('mongoose');
const {ServiceRequest}=require('./models');
const {registerAvailability}=require('./availability');

const year=new Date().getUTCFullYear();
function chain(rows){return {select:()=>({limit:()=>({lean:async()=>rows}),sort:()=>({lean:async()=>rows})})};}
async function start(){
 const Block=mongoose.models.AvailabilityBlock,store=new Map();
 ServiceRequest.find=()=>({select:()=>({limit:()=>({lean:async()=>[{order:{event:{date:`${year}-06-10`,startTime:'18:00',endTime:'23:00'}}}]})})});
 Block.find=()=>({select:()=>({sort:()=>({lean:async()=>[...store.entries()].map(([date,note])=>({date,note})).sort((a,b)=>a.date<b.date?-1:1)})})});
 Block.bulkWrite=async ops=>{for(const op of ops)store.set(op.updateOne.filter.date,op.updateOne.update.$set.note);};
 Block.deleteMany=async q=>{for(const d of q.date.$in)store.delete(d);};
 const app=express();app.use(express.json());
 registerAvailability(app,{requireAdmin:(req,_res,next)=>next()});
 const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});
 const base=`http://127.0.0.1:${server.address().port}`;
 return {base,close:()=>server.close(),put:(body)=>fetch(`${base}/api/admin/availability/blocked`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};
}

test('blocked days show as fully booked to the public calendar and can be released',async()=>{
 const t=await start();
 assert.equal((await t.put({dates:[`${year}-07-04`,`${year}-07-05`],blocked:true,note:'Vacation'})).status,200);
 let pub=await (await fetch(`${t.base}/api/availability?year=${year}`)).json();
 assert.deepEqual(pub.days[`${year}-07-04`],[{start:0,end:1440}]);
 assert.deepEqual(pub.days[`${year}-06-10`],[{start:1080,end:1380}]);
 const admin=await (await fetch(`${t.base}/api/admin/availability?year=${year}`)).json();
 assert.deepEqual(admin.blocked.map(row=>row.date),[`${year}-07-04`,`${year}-07-05`]);assert.equal(admin.blocked[0].note,'Vacation');
 assert.equal((await t.put({dates:[`${year}-07-04`],blocked:false})).status,200);
 pub=await (await fetch(`${t.base}/api/availability?year=${year}`)).json();
 assert.equal(pub.days[`${year}-07-04`],undefined);assert.deepEqual(pub.days[`${year}-07-05`],[{start:0,end:1440}]);
 t.close();
});
test('blocking rejects invalid input',async()=>{
 const t=await start();
 for(const body of [{dates:[],blocked:true},{dates:['2026-13-40'],blocked:true},{dates:[`${year}-01-01`],blocked:'yes'},{dates:[`${year}-01-01`],blocked:true,note:'x'.repeat(201)}])assert.equal((await t.put(body)).status,400);
 t.close();
});
