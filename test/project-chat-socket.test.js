const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {WebSocket}=require('ws');
const {createProjectChatSocket}=require('../src/project-chat-socket');

test('chat socket authenticates admins, isolates origins, and pushes changes without polling',async t=>{
 const admin={_id:'admin',username:'khalilnahhat',isBlocked:false};
 const realtime=createProjectChatSocket({authenticate:async req=>req.headers.authorization==='Bearer valid'?admin:null,allowedOrigins:['http://localhost:5176']});
 const server=http.createServer();realtime.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 const clients=[];t.after(async()=>{for(const client of clients)client.terminate();await new Promise(resolve=>server.close(resolve));});
 const url=`ws://127.0.0.1:${server.address().port}/api/echo-project-chat/socket`;
 const connect=async()=>{const client=new WebSocket(url,{origin:'http://localhost:5176'});clients.push(client);await once(client,'open');return client;};
 const client=await connect(),anonymous=await connect();let leaked=0;anonymous.on('message',()=>leaked++);
 const ready=once(client,'message');client.send(JSON.stringify({type:'authenticate',token:'valid'}));assert.equal(JSON.parse((await ready)[0]).type,'ready');
 const changed=once(client,'message');realtime.publish('messages');assert.deepEqual(JSON.parse((await changed)[0]),{type:'changed',reason:'messages'});assert.equal(leaked,0);
 const closed=once(anonymous,'close');anonymous.send(JSON.stringify({type:'authenticate',token:'invalid'}));assert.equal((await closed)[0],4401);
 await new Promise((resolve,reject)=>{const rejected=new WebSocket(url,{origin:'https://unrelated.invalid'});clients.push(rejected);rejected.on('error',()=>{});rejected.on('unexpected-response',(_req,res)=>{try{assert.equal(res.statusCode,403);res.resume();resolve();}catch(e){reject(e);}});rejected.on('open',()=>reject(new Error('Cross-origin socket accepted')));});
});

test('presence follows real heartbeats and clears dead connections without logging the admin out',{timeout:5000},async t=>{
 const admin={_id:'still-logged-in',username:'khalilnahhat',isBlocked:false};
 const online=new Map();let beats=0;
 const realtime=createProjectChatSocket({authenticate:async()=>admin,allowedOrigins:['http://localhost:5176'],heartbeatMs:25,
  onHeartbeat:async(user,id)=>{online.set(id,user._id);beats++;},onOffline:async(_user,id)=>online.delete(id)});
 const server=http.createServer();realtime.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 const clients=[];t.after(async()=>{for(const client of clients)client.terminate();await new Promise(resolve=>server.close(resolve));});
 const url=`ws://127.0.0.1:${server.address().port}/api/echo-project-chat/socket`;
 const connect=async options=>{const client=new WebSocket(url,{origin:'http://localhost:5176',...options});clients.push(client);await once(client,'open');const ready=once(client,'message');client.send('{"type":"authenticate","token":"valid"}');await ready;return client;};
 const active=await connect();const dead=await connect({autoPong:false});
 assert.equal(online.size,2);const gone=once(dead,'close');await gone;
 for(let i=0;i<40&&online.size!==1;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(online.size,1);assert.ok(beats>2,'active socket answered heartbeats');assert.equal(admin.isBlocked,false,'session stays signed in');
 const closed=once(active,'close');active.close();await closed;
 for(let i=0;i<40&&online.size;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(online.size,0);
});
