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
  let row={...meeting,clientJoinedAt:null,attendanceTrackingStartedAt:new Date(start.getTime()-3600000)};
  const Model={findById:async()=>row?{...row}:null,find:async()=>row?[{...row}]:[],updateOne:async(query,update)=>{if(!row||row.status!=='booked'||row.clientJoinedAt||String(row.bookedBy)!==String(query.bookedBy))return {matchedCount:0};Object.assign(row,update.$set);return {matchedCount:1};},findOneAndDelete:async query=>{assert.equal(query.status,'booked');assert.equal(query.mode,'online');assert.deepEqual(query.clientJoinedAt,{$type:'date'});if(!row||!row.clientJoinedAt)return null;const previous=row;row=null;return previous;}};
  registerMeetingRoom(app,{requireAuth:(req,_res,next)=>{req.authUser=users[req.get('x-user')];next();},Meeting:Model,now:()=>clock.t});
  const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});const base=`http://127.0.0.1:${server.address().port}/api/meetings/${id}/room`;
  const incoming=async who=>fetch(`http://127.0.0.1:${server.address().port}/api/meetings/room/incoming`,{headers:{'x-user':who}});
  const call=(who,path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-user':who},body:body?JSON.stringify(body):undefined});
  return {call,incoming,meeting:()=>row,end:who=>fetch(`http://127.0.0.1:${server.address().port}/api/meetings/${id}/end`,{method:'POST',headers:{'x-user':who}}),close:()=>server.close()};
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

test('the admin sees a client call while it rings, and not after it is answered, declined or ended',async()=>{
  const clock={t:start.getTime()+3600000},app=await boot(clock); // an hour in: earlier tests' rings in the shared room have expired
  assert.equal((await app.incoming('guest')).status,403);
  assert.deepEqual((await (await app.incoming('host')).json()).items,[]);
  await app.call('guest','/signal',{type:'offer',data:{sdp:'x',kind:'video'}});
  const ringing=(await (await app.incoming('host')).json()).items;
  await app.call('guest','/signal',{type:'candidate',data:{candidate:'c'}}); // ICE candidates follow an offer and must not stop the ring
  assert.equal((await (await app.incoming('host')).json()).items.length,1);
  assert.equal(ringing.length,1);assert.equal(ringing[0].meetingId,id);assert.equal(ringing[0].kind,'video');assert.equal(ringing[0].clientName,'Ana Client');
  clock.t+=61000;assert.deepEqual((await (await app.incoming('host')).json()).items,[]);
  await app.call('guest','/signal',{type:'offer',data:{sdp:'x',kind:'voice'}});
  await app.call('host','/signal',{type:'answer',data:{sdp:'y'}});assert.deepEqual((await (await app.incoming('host')).json()).items,[]);
  app.close();
});

test('only a real client room entry records attendance, and that first join survives later polls',async()=>{
 const clock={t:start.getTime()-31*60000},app=await boot(clock);
 try{
  assert.equal((await app.call('host','')).status,200);assert.equal(app.meeting().clientJoinedAt,null);
  assert.equal((await app.call('guest','')).status,403);assert.equal(app.meeting().clientJoinedAt,null);
  assert.equal((await app.call('stranger','')).status,404);assert.equal(app.meeting().clientJoinedAt,null);
  clock.t=start.getTime()+3*3600000;assert.equal((await app.call('guest','')).status,403);assert.equal(app.meeting().clientJoinedAt,null);
  clock.t=start.getTime()-5*60000;const first=await(await app.call('guest','')).json();assert.equal(first.meeting.clientJoinedAt,new Date(clock.t).toISOString());
  clock.t+=60000;const poll=await(await app.call('guest','/poll')).json();assert.equal(poll.clientJoinedAt,first.meeting.clientJoinedAt);
 }finally{app.close();}
});
test('only the host can end an attended meeting; ending deletes it without reopening its time',async()=>{
 const clock={t:start.getTime()},app=await boot(clock);
 try{
  assert.equal((await app.end('guest')).status,403);
  assert.equal((await app.end('host')).status,409);assert.ok(app.meeting());
  await app.call('guest','');assert.ok(app.meeting().clientJoinedAt);
  assert.equal((await app.end('host')).status,200);assert.equal(app.meeting(),null);
  assert.equal((await app.call('guest','/poll')).status,404);assert.equal((await app.call('host','')).status,404);
 }finally{app.close();}
});
