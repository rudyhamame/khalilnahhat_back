const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerLiveAccess,signViewer,verifyViewer}=require('../src/live-access');
const relayVerifier=require('../deploy/obs-relay/live-access.cjs').verifyViewer;
const secret='a-private-controller-secret-that-is-at-least-40-bytes';
test('relay capabilities are short-lived, authenticated and restricted to one room',()=>{
 const token=signViewer('room-a','member-a',secret,100000);
 for(const verify of [verifyViewer,relayVerifier]) {
  assert.ok(verify(token,'room-a',secret,100000));
  assert.equal(verify(token,'room-b',secret,100000),false);
  assert.equal(verify(token,'room-a',secret,220000),false);
  assert.equal(verify(token,'room-a','wrong secret',100000),false);
  assert.equal(verify(token+'extra','room-a',secret,100000),false);
  assert.equal(verify('', 'room-a',secret,100000),false);
 }
});
test('playback routes reject guests and stale sessions before creating media credentials',async t=>{
 let minted=0;const current={isLive:true,broadcastMode:'webrtc',webrtcRoomName:'room-a'};
 const app=express();app.use(express.json());
 const requireAuth=(req,res,next)=>{if(req.get('authorization')!=='Bearer signed-in')return res.status(401).json({message:'Sign in'});req.authUser={_id:'member-a',username:'Ana'};next();};
 registerLiveAccess(app,{requireAuth,getLiveStreamConfig:async()=>current,createToken:async options=>{minted++;assert.equal(options.canPublish,false);assert.ok(options.identity.startsWith('member-member-a-'));return 'subscriber-token';},getConfig:()=>({wsUrl:'wss://media.example'}),relay:{configured:()=>true},env:{ECHO_OBS_RELAY_URL:'https://relay.example',ECHO_OBS_RELAY_TOKEN:secret}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(path,session,auth)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer signed-in'}:{})},body:JSON.stringify({session})});
 for(const path of ['/api/live-stream/playback','/api/live-stream/webrtc/viewer-token'])assert.equal((await call(path,'room-a',false)).status,401);
 assert.equal(minted,0);assert.equal((await call('/api/live-stream/playback','old-room',true)).status,409);assert.equal(minted,0);
 const response=await call('/api/live-stream/playback','room-a',true);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).token,'subscriber-token');assert.equal(minted,1);
 Object.assign(current,{broadcastMode:'whep',webrtcRoomName:'',obsRoomName:'room-b',streamUrl:'https://evil.example'});
 const whep=await(await call('/api/live-stream/playback','room-b',true)).json();assert.equal(whep.url,'https://relay.example/live/room-b/whep');assert.ok(verifyViewer(whep.token,'room-b',secret));assert.equal(JSON.stringify(whep).includes(secret),false);
 current.isLive=false;assert.equal((await call('/api/live-stream/playback','room-b',true)).status,409);
 Object.assign(current,{isLive:true,broadcastMode:'youtube'});assert.equal((await call('/api/live-stream/playback','room-b',true)).status,409);
});

test('relay rejects direct anonymous WHEP reads and never confuses viewer and publisher grants',()=>{
 const {authorizeMedia}=require('../deploy/obs-relay/live-access.cjs');
 const now=100000,row={id:'room',state:'live',publishToken:'publisher-only-secret',expiresAt:200000};
 const read={action:'read',protocol:'webrtc',path:'live/room'};
 assert.equal(authorizeMedia(read,row,secret,now),false);
 assert.equal(authorizeMedia({...read,token:row.publishToken},row,secret,now),false);
 const token=signViewer('room','member',secret,now);
 assert.equal(authorizeMedia({...read,token},row,secret,now),true);
 assert.equal(authorizeMedia({...read,action:'publish',token},row,secret,now),false);
 assert.equal(authorizeMedia({...read,action:'publish',token:row.publishToken},row,secret,now),true);
 assert.equal(authorizeMedia({...read,token},{...row,state:'ending'},secret,now),false);
 assert.equal(authorizeMedia({...read,token},{...row,id:'another-room'},secret,now),false);
 assert.equal(authorizeMedia({...read,action:'publish',token:row.publishToken},{...row,state:'waiting',expiresAt:now-1},secret,now),false);
});
