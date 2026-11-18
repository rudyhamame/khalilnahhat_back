const test=require('node:test');const assert=require('node:assert/strict');
const {registerOvhBrowserRoutes}=require('../src/ovh-browser-broadcast');
function fixture(overrides={}){
 const routes=new Map(),calls=[],recordings=[];let uuid=0;let current={key:'live',isLive:false,webrtcRoomName:'',obsRoomName:''};
 const relay={configured:()=>true,sessionRoute:id=>'sessions/'+id,async request(route,options){calls.push({route,options});return route==='health'?{ok:true}:{state:'live',saveRecording:true};}};
 const Recording={async create(row){const saved={...row,_id:'recording-'+(recordings.length+1),save:async()=>{}};recordings.push(saved);return saved;},async findOne({roomName}){return recordings.find(r=>r.roomName===roomName);}};
 const deps={requireAdmin:(_req,_res,next)=>next(),getLiveStreamConfig:async()=>current,LiveStreamConfig:{async findOneAndUpdate(filter,values){if(filter.obsRoomName&&typeof filter.obsRoomName==='string'&&filter.obsRoomName!==current.obsRoomName)return null;current={...current,...values};return current;}},defaults:{key:'live',title:'Live'},serialize:row=>({isLive:row.isLive,broadcastMode:row.broadcastMode}),randomUUID:()=> '12345678-1234-1234-1234-'+String(++uuid).padStart(12,'0')};
 const legacy={async stop(){current={...current,isLive:false,obsRoomName:'',webrtcRoomName:''};return current;},async synchronize(){current={...current,isLive:true};return current;}};
 registerOvhBrowserRoutes({post:(path,...handlers)=>routes.set(path,handlers.at(-1))},{...deps,...overrides},legacy,{relay,Recording,env:{ECHO_BROWSER_TRANSPORT:'ovh',ECHO_OBS_RELAY_URL:'https://relay.example',CLOUDINARY_API_SECRET:'test'}});
 async function request(path,body={}){const result={status:200};const response={set(){},status(code){result.status=code;return this;},json(data){result.body=data;return result;}};await routes.get('/api/live-stream/webrtc/'+path)({body},response,()=>{result.next=true;});return result;}
 return {request,calls,recordings,get current(){return current;}};
}
test('OVH prepares the selected running order in the exact reserved room while offline',async()=>{
 const calls=[];const f=fixture({prepareSetList:async id=>({id,install:async room=>calls.push({id,room})})});
 const response=await f.request('go-live',{transport:'ovh',setListId:'livestream',saveRecording:false});
 assert.equal(response.status,201);assert.deepEqual(calls,[{id:'livestream',room:response.body.roomName}]);assert.equal(f.current.liveSetListId,'livestream');assert.equal(f.current.isLive,false);
});
test('OVH releases its offline reservation if the set list cannot be installed',async()=>{
 const f=fixture({prepareSetList:async()=>({id:'livestream',install:async()=>{throw Error('Set list unavailable');}})});
 const response=await f.request('go-live',{transport:'ovh',setListId:'livestream',saveRecording:false});
 assert.equal(response.status,503);assert.equal(f.current.obsRoomName,'');assert.equal(response.body.token,undefined);
});
test('OVH claim returns one publisher and a server recording; only received media becomes live',async()=>{
 const f=fixture();const result=await f.request('go-live',{transport:'ovh',title:'Test set',saveRecording:true});assert.equal(result.status,201);assert.equal(result.body.transport,'ovh');assert.equal(result.body.recording.mode,'ovh');assert.equal(result.body.recording.id,'recording-1');assert.equal(f.current.isLive,false);assert.equal(f.recordings[0].provider,'ovh');assert.match(result.body.url,/\/whip$/);assert.equal(result.body.item.token,undefined);
 const ready=await f.request('ready',{roomName:result.body.roomName});assert.equal(ready.body.item.isLive,true);
 const stale=await f.request('end',{roomName:'old-room'});assert.equal(stale.body.ended,false);assert.equal(f.current.isLive,true);
 assert.equal((await f.request('end',{roomName:result.body.roomName})).body.ended,true);
});
test('recording-off creates no recording; older LiveKit clients pass through unchanged',async()=>{
 const f=fixture();assert.equal((await f.request('go-live',{recordingMode:'direct'})).next,true);const result=await f.request('go-live',{transport:'ovh',saveRecording:false});assert.deepEqual(result.body.recording,{mode:'none'});assert.equal(f.recordings.length,0);assert.equal(f.calls.find(c=>c.route==='sessions').options.body.saveRecording,false);
});

test('two cameras create two real relay recordings with one shared parent and survive reconnect',async()=>{
 const f=fixture(),outputs=[{key:'main',width:1280,height:720},{key:'portrait',width:720,height:1280}];
 const result=await f.request('go-live',{transport:'ovh',saveRecording:true,outputs});assert.equal(result.status,201);
 assert.equal(f.recordings.length,2);assert.equal(f.recordings[1].parentRecordingId,f.recordings[0]._id);assert.equal(f.recordings[1].sessionRoomName,f.recordings[0].roomName);
 assert.equal(result.body.recording.outputs.length,2);assert.notEqual(result.body.recording.outputs[0].id,result.body.recording.outputs[1].id);
 assert.match(result.body.portraitPublisher.url,/\/whip$/);assert.notEqual(result.body.portraitPublisher.url,result.body.url);
 assert.equal(f.calls.filter(c=>c.route==='sessions').length,2);
 const resumed=await f.request('resume');assert.deepEqual(resumed.body.recording.outputs,result.body.recording.outputs);assert.equal(resumed.body.portraitPublisher.url,result.body.portraitPublisher.url);
 await f.request('ready',{roomName:result.body.roomName});assert.ok(f.calls.some(c=>c.route==='sessions/'+f.current.obsPortraitRoomName));
});
test('two-camera live-only mode prepares both publishers without creating archive records',async()=>{
 const f=fixture();const result=await f.request('go-live',{transport:'ovh',saveRecording:false,outputs:[{key:'main',width:1280,height:720},{key:'portrait',width:720,height:1280}]});
 assert.equal(result.status,201);assert.equal(f.recordings.length,0);assert.equal(result.body.recording.mode,'none');assert.ok(result.body.portraitPublisher);assert.equal(f.calls.filter(c=>c.route==='sessions').length,2);
});
