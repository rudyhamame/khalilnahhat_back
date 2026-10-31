const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {sessionKey,externalBroadcastId}=require('../src/live-interactions');
const {registerLiveComments}=require('../src/live-comments');
const {registerLiveSuggestions}=require('../src/live-suggestions');

test('broadcast identity survives song, title, goal and timestamp edits but changes on a new start',()=>{
 const current={isLive:true,broadcastMode:'youtube',broadcastSessionId:externalBroadcastId(null,{isLive:true})};
 const edited={...current,title:'New title',goal:'radio',activeSessionId:'next-song',updatedAt:new Date()};
 assert.equal(sessionKey(edited),sessionKey(current));
 assert.equal(externalBroadcastId(current,edited),current.broadcastSessionId);
 assert.notEqual(externalBroadcastId({...current,streamUrl:'https://youtube.com/one'},{...current,streamUrl:'https://youtube.com/two'}),current.broadcastSessionId);
 const restarted={...current,broadcastSessionId:externalBroadcastId({...current,isLive:false},{isLive:true})};
 assert.notEqual(sessionKey(restarted),sessionKey(current));
 assert.equal(sessionKey({...restarted,isLive:false}),null);
 assert.equal(sessionKey({...restarted,webrtcRoomName:'new-obs-room'}),'new-obs-room');
 assert.equal(sessionKey({isLive:true,activeSessionId:'song',updatedAt:new Date()}),null);
});

test('HTTP routes reject guests, expired tokens, blocked accounts and submissions for a replaced stream',async t=>{
 const app=express();app.use(express.json());
 const stream={isLive:true,webrtcRoomName:'broadcast-a'},comments=[],requests=[];
 const requireAuth=(req,res,next)=>{
  if(req.get('authorization')==='Bearer blocked')return res.status(403).json({message:'Blocked'});
  if(req.get('authorization')!=='Bearer member')return res.status(401).json({message:'Sign in'});
  req.authUser={_id:'member-1',firstName:'Signed',lastName:'Member',email:'member@example.test'};return next();
 };
 registerLiveComments(app,{requireAuth,getLiveStreamConfig:async()=>stream,CommentModel:{
  find:query=>({sort:()=>({limit:()=>({lean:async()=>comments.filter(row=>row.session===query.session)})})}),
  create:async row=>{const item={...row,_id:String(comments.length),createdAt:new Date()};comments.push(item);return item;},
 }});
 registerLiveSuggestions(app,{requireAuth,getLiveStreamConfig:async()=>stream,RequestModel:{create:async row=>requests.push(row)}});
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(path,method='GET',body,token)=>fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
 for(const token of [undefined,'expired','blocked']){
  const expected=token==='blocked'?403:401;
  assert.equal((await call('live-comments','GET',undefined,token)).status,expected);
  assert.equal((await call('live-comments','POST',{session:'broadcast-a',text:'Hello'},token)).status,expected);
  assert.equal((await call('live-suggestions','POST',{session:'broadcast-a',track:'Song'},token)).status,expected);
 }
 assert.equal(comments.length,0);assert.equal(requests.length,0);
 assert.equal((await call('live-comments','POST',{session:'broadcast-a',name:'Impersonated',text:'Hello'},'member')).status,201);
 assert.equal(comments[0].name,'Signed Member');assert.equal(comments[0].authorId,'member-1');
 assert.equal((await call('live-suggestions','POST',{session:'broadcast-a',track:'Song'},'member')).status,201);
 stream.webrtcRoomName='broadcast-b';
 for(const [path,body]of [['live-comments',{text:'Stale'}],['live-suggestions',{track:'Stale'}]])assert.equal((await call(path,'POST',{session:'broadcast-a',...body},'member')).status,409);
 assert.equal((await call('live-comments?session=broadcast-a','GET',undefined,'member')).status,409);
 const result=await(await call('live-comments?session=broadcast-b','GET',undefined,'member')).json();
 assert.deepEqual(result.items,[]);assert.equal(result.session,'broadcast-b');
 assert.equal(comments.length,1);assert.equal(requests.length,1);assert.equal(requests[0].broadcastSessionId,'broadcast-a');
});
