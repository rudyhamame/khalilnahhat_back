const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {z}=require('zod');
const {registerLiveSetList}=require('../src/live-setlist');
const {registerRecordingSessionMetadata}=require('../src/recording-session-metadata');

function matches(row,filter){return Object.entries(filter).every(([key,value])=>key==='$or'?value.some(part=>matches(row,part)):value&&typeof value==='object'&&'$in'in value?value.$in.includes(row[key]??null):row[key]===value);}
function model(rows){return {
 find:filter=>({sort(){return this;},lean:async()=>rows.filter(row=>matches(row,filter)),then(resolve,reject){return Promise.resolve(rows.filter(row=>matches(row,filter))).then(resolve,reject);}}),
 create:async data=>{const row={...data};rows.push(row);return row;},
 findOneAndUpdate:async(filter,update)=>{const row=rows.find(row=>matches(row,filter));return row?Object.assign(row,update):null;},
};}
test('two broadcasts keep independent setlists and archived requests/comments; ended lives disappear from the client feed',async t=>{
 const app=express();app.use(express.json());
 let stream={isLive:true,webrtcRoomName:'session-a'};
 const songs=[{externalId:'legacy-global-song',track:'Unscoped legacy song'}];
 const requests=[{externalId:'request-a',broadcastSessionId:'session-a',requesterName:'Alice',requesterEmail:'private@example.test',track:'Song A',requestStatus:'approved'}, {externalId:'request-b',broadcastRoomName:'session-b',track:'Song B'}];
 const comments=[{_id:'comment-a',session:'session-a',name:'Alice',text:'Hello A',hidden:true,reply:{text:'Thanks A'}},{_id:'comment-b',session:'session-b',name:'Bob',text:'Hello B'}];
 const LiveSession=model(songs),LiveRequest=model(requests),LiveComment=model(comments);
 const requireAuth=(req,res,next)=>req.get('authorization')?next():res.sendStatus(401);
 const requireAdmin=(req,res,next)=>req.get('authorization')==='admin'?next():res.sendStatus(403);
 registerLiveSetList(app,{requireAuth,requireAdmin,getLiveStreamConfig:async()=>stream,LiveSession,
  input:z.object({track:z.string().min(1),playState:z.string().default('queued'),sortOrder:z.number().optional()}),serialize:row=>row,
  remove:async(_model,filter)=>{const index=songs.findIndex(row=>matches(row,filter));return index<0?null:songs.splice(index,1)[0];},
 });
 registerRecordingSessionMetadata(app,requireAdmin,{Recording:{findOne:async filter=>filter._id==='recording-a'?{roomName:'session-a'}:null},LiveSession,LiveRequest,LiveComment,isValidId:()=>true});
 const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(path,method='GET',body,auth='admin')=>fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})},body:body?JSON.stringify(body):undefined});
 assert.equal((await call('live-sessions','GET',undefined,'')).status,401);
 assert.equal((await call('live-sessions','POST',{session:'session-a',track:'Unauthorized'},'member')).status,403);
 assert.equal((await call('live-sessions','POST',{track:'Missing session'})).status,409);
 const created=await(await call('live-sessions','POST',{session:'session-a',track:'Song A',broadcastSessionId:'session-b'})).json();
 assert.equal(created.item.broadcastSessionId,'session-a');const id=created.item.externalId;
 assert.deepEqual((await(await call('live-sessions')).json()).items.map(row=>row.track),['Song A']);
 assert.equal((await call('live-sessions/'+id,'PATCH',{session:'session-a',playState:'played'})).status,200);
 stream={isLive:false};
 assert.deepEqual(await(await call('live-sessions')).json(),{session:null,items:[]});
 assert.equal((await call('live-sessions/'+id,'PATCH',{session:'session-a',track:'Changed after end'})).status,409);
 assert.equal((await call('live-sessions/'+id,'DELETE')).status,409);
 stream={isLive:true,webrtcRoomName:'session-b'};
 assert.deepEqual((await(await call('live-sessions')).json()).items,[]);
 assert.equal((await call('live-sessions?session=session-a')).status,409);
 assert.equal((await call('live-sessions','POST',{session:'session-a',track:'Stale form'})).status,409);
 assert.equal((await call('live-sessions/'+id,'PATCH',{session:'session-b',track:'Steal old song'})).status,404);
 assert.equal((await call('live-sessions/'+id,'DELETE')).status,404);
 assert.equal((await call('live-sessions','POST',{session:'session-b',track:'Song B'})).status,201);
 assert.deepEqual((await(await call('live-sessions')).json()).items.map(row=>row.track),['Song B']);
 assert.equal((await call('admin/live-recordings/recording-a/metadata','GET',undefined,'member')).status,403);
 assert.equal((await call('admin/live-recordings/missing/metadata')).status,404);
 const archive=await(await call('admin/live-recordings/recording-a/metadata')).json();
 assert.equal(archive.session,'session-a');assert.equal(archive.setList.length,1);assert.equal(archive.setList[0].track,'Song A');assert.equal(archive.setList[0].playState,'played');
 assert.deepEqual(archive.requests.map(item=>item.id),['request-a']);
 assert.deepEqual(archive.comments.map(item=>item.text),['Hello A']);assert.equal(archive.comments[0].hidden,true);assert.equal(archive.comments[0].reply.text,'Thanks A');
 assert.equal(JSON.stringify(archive).includes('private@example.test'),false);
});
