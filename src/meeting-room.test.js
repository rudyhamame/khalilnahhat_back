const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const mongoose=require('mongoose');
const {registerMeetingRoom,iceServers}=require('./meeting-room');

const start=new Date('2026-12-01T15:00:00Z'),id=String(new mongoose.Types.ObjectId()),clientId=new mongoose.Types.ObjectId(),stranger=new mongoose.Types.ObjectId();
const meeting={id,status:'booked',mode:'online',start,durationMin:30,bookedBy:clientId,bookedByName:'Ana Client',topic:'Wedding'};
async function boot(clock){
  const users={host:{_id:new mongoose.Types.ObjectId(),isAdmin:true,firstName:'Khalil'},guest:{_id:clientId,firstName:'Ana'},stranger:{_id:stranger,firstName:'X'}};
  const app=express();app.use(express.json());
  registerMeetingRoom(app,{requireAuth:(req,_res,next)=>{req.authUser=users[req.get('x-user')];next();},Meeting:{findById:async()=>meeting},now:()=>clock.t});
  const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});const base=`http://127.0.0.1:${server.address().port}/api/meetings/${id}/room`;
  const call=(who,path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-user':who},body:body?JSON.stringify(body):undefined});
  return {call,close:()=>server.close()};
}
test('only the booked client and an admin may enter, and the client only near the meeting time',async()=>{
  const clock={t:start.getTime()-5*60000},app=await boot(clock);
  assert.equal((await app.call('guest','')).status,200);assert.equal((await app.call('host','')).status,200);
  assert.equal((await app.call('stranger','')).status,404);
  clock.t=start.getTime()-2*3600000;
  assert.equal((await app.call('guest','')).status,403);assert.equal((await app.call('host','')).status,200);
  clock.t=start.getTime()+3*3600000;assert.equal((await app.call('guest','/poll')).status,403);
  app.close();
});
test('signals and chat flow between client and Khalil, with presence',async()=>{
  const clock={t:start.getTime()},app=await boot(clock);
  const room=await (await app.call('guest','')).json();assert.equal(room.role,'guest');assert.ok(room.iceServers.length>=1);
  assert.equal((await (await app.call('host','/poll')).json()).peerOnline,false);
  assert.equal((await (await app.call('guest','/poll')).json()).peerOnline,true);
  assert.equal((await app.call('guest','/signal',{type:'offer',data:{sdp:'x',kind:'video'}})).status,200);
  assert.equal((await app.call('guest','/signal',{type:'evil'})).status,400);
  const hostPoll=await (await app.call('host','/poll?signal=0')).json();
  assert.equal(hostPoll.signals.length,1);assert.equal(hostPoll.signals[0].type,'offer');
  assert.equal((await (await app.call('guest','/poll')).json()).signals.length,0);
  assert.equal((await app.call('host','/message',{text:'  Hello Ana  '})).status,201);
  assert.equal((await app.call('host','/message',{text:'   '})).status,400);
  const guestPoll=await (await app.call('guest','/poll')).json();
  assert.equal(guestPoll.messages[0].text,'Hello Ana');assert.equal(guestPoll.messages[0].from,'host');
  const later=await (await app.call('guest',`/poll?message=${guestPoll.messages[0].seq}`)).json();assert.equal(later.messages.length,0);
  app.close();
});
test('TURN servers are added only when fully configured',()=>{
  assert.equal(iceServers({}).length,1);
  assert.equal(iceServers({MEETING_TURN_URLS:'turn:t.example:3478',MEETING_TURN_USERNAME:'u',MEETING_TURN_CREDENTIAL:'c'}).length,2);
  assert.equal(iceServers({MEETING_TURN_URLS:'turn:t.example:3478'}).length,1);
});
