const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const mongoose=require('mongoose');
const vouchers=require('./vouchers');

function fake(){
 const docs=[],redemptions=[];
 const {Voucher,Redemption}=vouchers;
 const wrap=d=>d&&Object.assign(d,{});
 Voucher.create=async data=>{if(docs.some(v=>v.code===data.code))throw Object.assign(new Error('dup'),{code:11000});const d={_id:new mongoose.Types.ObjectId(),redeemed:0,active:true,announce:false,maxRedemptions:0,perClientLimit:1,startsAt:null,endsAt:null,amountCents:0,percent:0,title:'',description:'',createdAt:new Date(),updatedAt:new Date(),...data};docs.push(d);return d;};
 Voucher.findOne=async q=>docs.find(v=>v.code===q.code)||null;
 Voucher.find=()=>({sort:()=>({limit:async()=>[...docs].filter(v=>v.active&&v.announce)})});
 Voucher.findOneAndUpdate=async(q)=>{const d=docs.find(v=>String(v._id)===String(q._id));if(!d||!d.active||(d.maxRedemptions&&d.redeemed>=d.maxRedemptions))return null;d.redeemed++;return d;};
 Voucher.updateOne=async q=>{const d=docs.find(v=>String(v._id)===String(q._id));if(d&&d.redeemed>0)d.redeemed--;};
 Redemption.countDocuments=async q=>redemptions.filter(r=>String(r.voucherId)===String(q.voucherId)&&String(r.userId)===String(q.userId)).length;
 Redemption.create=async data=>{redemptions.push(data);return data;};
 return {docs,redemptions};
}

test('voucher is claimed once per client, respects the cap, and releases on failure',async()=>{
 const state=fake();
 const created=await vouchers.Voucher.create({code:'ECHO10',kind:'percent',percent:10,maxRedemptions:2,perClientLimit:1});
 const alice={_id:new mongoose.Types.ObjectId(),firstName:'Alice',lastName:'A',email:'a@x.ca'},bob={_id:new mongoose.Types.ObjectId()},carol={_id:new mongoose.Types.ObjectId()};
 let r=await vouchers.reserve('echo10',alice);assert.ok(r.voucher);await vouchers.record(r.voucher,alice,{externalId:'sr-1',requestNumber:'ECHO-1'});
 assert.equal(state.redemptions[0].customerEmail,'a@x.ca');
 assert.match((await vouchers.reserve('ECHO10',alice)).error,/already used/);
 r=await vouchers.reserve('ECHO10',bob);assert.ok(r.voucher);
 assert.match((await vouchers.reserve('ECHO10',carol)).error,/fully redeemed/);
 await vouchers.release(r.voucher);
 assert.ok((await vouchers.reserve('ECHO10',carol)).voucher);
 assert.match((await vouchers.reserve('nope!',carol)).error,/valid voucher code/);
 created.active=false;assert.match((await vouchers.evaluate('ECHO10',carol._id)).error,/not valid/);
});

test('admin API validates input and the public announcement shows only an active announced voucher',async()=>{
 fake();
 const app=express();app.use(express.json());
 vouchers.registerVouchers(app,{requireAdmin:(_q,_s,n)=>n(),requireAuth:(q,_s,n)=>{q.authUser={_id:new mongoose.Types.ObjectId()};n();}});
 const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('/api/admin/vouchers',{code:'x',kind:'percent',percent:10})).status,400);
 assert.equal((await post('/api/admin/vouchers',{code:'SAVE50',kind:'amount',amountCents:0})).status,400);
 assert.equal((await post('/api/admin/vouchers',{code:'SAVE50',kind:'amount',amountCents:5000,announce:true,title:'$50 off your first booking'})).status,201);
 assert.equal((await post('/api/admin/vouchers',{code:'save50',kind:'amount',amountCents:5000})).status,409);
 const announcement=await (await fetch(base+'/api/vouchers/announcement')).json();
 assert.equal(announcement.voucher.code,'SAVE50');assert.equal(announcement.voucher.amountCents,5000);
 const check=await (await post('/api/vouchers/validate',{code:'save50'})).json();assert.equal(check.valid,true);
 assert.equal((await post('/api/vouchers/validate',{code:'WRONG1'})).status,400);
 server.close();
});
