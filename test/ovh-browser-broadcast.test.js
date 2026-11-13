const test=require('node:test');const assert=require('node:assert/strict');
const {registerOvhBrowserRoutes}=require('../src/ovh-browser-broadcast');
function fixture(){
 const routes=new Map(),calls=[],recordings=[];let current={key:'live',isLive:false,webrtcRoomName:'',obsRoomName:''};
 const relay={configured:()=>true,sessionRoute:id=>'sessions/'+id,async request(route,options){calls.push({route,options});return route==='health'?{ok:true}:{state:'live',saveRecording:true};}};
 const Recording={async create(row){recordings.push({...row,_id:'recording-1'});},async findOne({roomName}){return recordings.find(r=>r.roomName===roomName);}};
 const deps={requireAdmin:(_req,_res,next)=>next(),getLiveStreamConfig:async()=>current,LiveStreamConfig:{async findOneAndUpdate(filter,values){if(filter.obsRoomName&&typeof filter.obsRoomName==='string'&&filter.obsRoomName!==current.obsRoomName)return null;current={...current,...values};return current;}},defaults:{key:'live',title:'Live'},serialize:row=>({isLive:row.isLive,broadcastMode:row.broadcastMode}),randomUUID:()=> '12345678-1234-1234-1234-123456789abc'};
 const legacy={async stop(){current={...current,isLive:false,obsRoomName:'',webrtcRoomName:''};return current;},async synchronize(){current={...current,isLive:true};return current;}};
 registerOvhBrowserRoutes({post:(path,...handlers)=>routes.set(path,handlers.at(-1))},deps,legacy,{relay,Recording,env:{ECHO_BROWSER_TRANSPORT:'ovh',ECHO_OBS_RELAY_URL:'https://relay.example',CLOUDINARY_API_SECRET:'test'}});
 async function request(path,body={}){const result={status:200};const response={set(){},status(code){result.status=code;return this;},json(data){result.body=data;return result;}};await routes.get('/api/live-stream/webrtc/'+path)({body},response,()=>{result.next=true;});return result;}
 return {request,calls,recordings,get current(){return current;}};
}
test('OVH claim returns one publisher and a server recording; only received media becomes live',async()=>{
 const f=fixture();const result=await f.request('go-live',{transport:'ovh',title:'Test set',saveRecording:true});assert.equal(result.status,201);assert.equal(result.body.transport,'ovh');assert.equal(result.body.recording.mode,'ovh');assert.equal(result.body.recording.id,'recording-1');assert.equal(f.current.isLive,false);assert.equal(f.recordings[0].provider,'ovh');assert.match(result.body.url,/\/whip$/);assert.equal(result.body.item.token,undefined);
 const ready=await f.request('ready',{roomName:result.body.roomName});assert.equal(ready.body.item.isLive,true);
 const stale=await f.request('end',{roomName:'old-room'});assert.equal(stale.body.ended,false);assert.equal(f.current.isLive,true);
 assert.equal((await f.request('end',{roomName:result.body.roomName})).body.ended,true);
});
test('recording-off creates no recording; older LiveKit clients pass through unchanged',async()=>{
 const f=fixture();assert.equal((await f.request('go-live',{recordingMode:'direct'})).next,true);const result=await f.request('go-live',{transport:'ovh',saveRecording:false});assert.deepEqual(result.body.recording,{mode:'none'});assert.equal(f.recordings.length,0);assert.equal(f.calls.find(c=>c.route==='sessions').options.body.saveRecording,false);
});
