const {test}=require('node:test');
const assert=require('node:assert/strict');
const {registerObsBroadcastRoutes}=require('../src/obs-broadcast');
function setup(overrides={}) {
 const routes={}; const removed=[]; const rooms=[];
 let row={key:'live',isLive:false,obsRoomName:'',obsState:'',obsIngressId:''};
 let media={status:0,tracks:[]};let failDelete=false;
 const match=(value,condition)=>condition&&typeof condition==='object' ? ('$in' in condition ? condition.$in.includes(value??null) : '$ne' in condition ? value!==condition.$ne : false) : value===condition;
 const deps={requireAdmin:()=>{},disableObsTimer:true,defaults:{key:'live',title:'Live',statusLabel:'Offline'},randomUUID:()=> 'test',
 getLiveStreamConfig:async()=>({...row}),getConfig:()=>({}),serialize:value=>value,
 LiveStreamConfig:{findOneAndUpdate:async(filter,update)=>{if(!Object.entries(filter).every(([k,v])=>match(row[k],v)))return null;row={...row,...update};return {...row};}},
 prepareRecording:async()=>{},
 IngressClient:class {async createIngress(_type,options){assert.equal(options.participantIdentity,'khalil-obs');return {ingressId:'IN_test',url:'rtmps://ingress.example/live',streamKey:'private-test-key'};}async listIngress(){return [{state:{status:media.status}}];} async deleteIngress(id){if(failDelete)throw new Error('network');removed.push(id);}},
 RoomServiceClient:class{async listParticipants(){return [{identity:'khalil-obs',tracks:media.tracks}];}async deleteRoom(name){rooms.push(name);}},...overrides};
 const service=registerObsBroadcastRoutes({patch:(path,auth,handler)=>{assert.equal(auth,deps.requireAdmin);routes[path]=handler;},get:(path,auth,handler)=>{assert.equal(auth,deps.requireAdmin);routes[path]=handler;},post:(path,auth,handler)=>{assert.equal(auth,deps.requireAdmin);routes[path]=handler;}},deps);
 return {service,removed,rooms,setRow:values=>{row={...row,...values};},get row(){return row;},setMedia:values=>{media={...media,...values};},failDelete:value=>{failDelete=value;},call:async(path,body={})=>{const res={code:200,set(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await routes['/api/live-stream/obs'+path]({body},res);return res;}};
}
function seedLegacy(c) {
 c.setRow({obsRoomName:'khalil-obs-test',webrtcRoomName:'khalil-obs-test',broadcastSource:'obs',broadcastMode:'webrtc',obsIngressId:'IN_test',obsState:'waiting',obsStreamKey:'private-test-key',obsExpiresAt:new Date(Date.now()+120000)});
}
test('without the OVH relay, OBS setup is refused and allocates nothing (LiveKit ingress stays retired)',async()=>{
 let allocations=0;
 const c=setup({prepareRecording:async()=>{allocations++;},IngressClient:class{constructor(){allocations++;}}});
 const original={...c.row};
 const result=await c.call('/prepare',{title:'No relay'});
 assert.equal(result.code,503);assert.equal(result.body.code,'OBS_RELAY_UNAVAILABLE');assert.equal(allocations,0);assert.deepEqual(c.row,original);
});
test('with the OVH relay, prepare reserves a live-only WHIP session and returns admin-only credentials',async()=>{
 const relay=require('../src/obs-relay-client'),recordings=require('../src/live-recordings'),saved={configured:relay.configured,request:relay.request,create:recordings.LiveRecording.create};
 const calls=[],created=[];
 relay.configured=()=>true;
 relay.request=async(route,options={})=>{calls.push([route,options.method||'GET',options.body]);return route==='sessions'?{server:'https://relay.example/whip',streamKey:'bearer-token',expiresAt:new Date(Date.now()+120000).toISOString()}:{};};
 recordings.LiveRecording.create=async value=>{created.push(value);};
 try{
  const c=setup();c.setRow({obsSaveRecording:true});const result=await c.call('/prepare',{title:'OBS night',saveRecording:true});
  assert.equal(result.code,201);assert.equal(c.row.broadcastMode,'whep');assert.equal(c.row.broadcastSource,'obs');assert.equal(c.row.isLive,false);
  assert.equal(c.row.obsUrl,'https://relay.example/whip');assert.equal(c.row.obsStreamKey,'bearer-token');assert.equal(c.row.obsState,'waiting');
  assert.equal(created.length,0);assert.equal(c.row.obsSaveRecording,false);assert.equal(calls.find(([route])=>route==='sessions')[2].saveRecording,false);
  assert.equal((await c.call('/prepare')).code,409);
 }finally{Object.assign(relay,{configured:saved.configured,request:saved.request});recordings.LiveRecording.create=saved.create;}
});
test('OBS becomes live only after actual media, and disconnect revokes the key',async()=>{
 const c=setup();seedLegacy(c);c.setMedia({status:2});await c.service.synchronize();assert.equal(c.row.isLive,false);
 c.setMedia({tracks:[{sid:'TR_video'}]});await c.service.synchronize();assert.equal(c.row.isLive,true);
 c.setMedia({status:0,tracks:[]});await c.service.synchronize();assert.equal(c.row.isLive,false);assert.equal(c.row.obsStreamKey,'');assert.deepEqual(c.removed,['IN_test']);
});
test('OBS setup never replaces an active browser/Android broadcast or another pending OBS',async()=>{
 const c=setup();c.setRow({isLive:true,webrtcRoomName:'phone'});assert.equal((await c.call('/prepare')).code,503);assert.equal(c.row.webrtcRoomName,'phone');
 c.setRow({isLive:false,obsRoomName:'reserved'});assert.equal((await c.call('/prepare')).code,503);
});
test('stale end and old OBS webhook leave a newer session untouched',async()=>{
 const c=setup();seedLegacy(c);c.setRow({obsRoomName:'khalil-obs-new',isLive:true});
 assert.equal((await c.call('/end',{roomName:'khalil-obs-test'})).body.ended,false);
 await c.service.webhook({event:'room_finished',room:{name:'khalil-obs-test'}});assert.equal(c.row.isLive,true);assert.deepEqual(c.removed,[]);
});
test('failed key revocation retains reservation and retries instead of admitting another broadcaster',async()=>{
 const c=setup();seedLegacy(c);c.failDelete(true);assert.equal((await c.call('/end',{roomName:c.row.obsRoomName})).code,503);
 assert.equal(c.row.obsState,'ending');assert.equal(c.row.isLive,false);assert.equal((await c.call('/prepare')).code,503);
 c.failDelete(false);await c.service.synchronize();assert.equal(c.row.obsRoomName,'');
});
test('unused OBS connection expires, revoking its key',async()=>{
 const c=setup();seedLegacy(c);c.setRow({obsExpiresAt:new Date(Date.now()-1000)});await c.service.synchronize();assert.equal(c.row.obsRoomName,'');assert.deepEqual(c.removed,['IN_test']);
});
test('public serialization excludes all OBS connection secrets, including bootstrap',()=>{
 const fs=require('node:fs'),vm=require('node:vm');const source=fs.readFileSync(require.resolve('../src/server'),'utf8');
 const fn=source.slice(source.indexOf('function serializeLiveStreamConfig('),source.indexOf('function buildMuxPlaybackUrl('));
 const serialize=vm.runInNewContext(fn+';serializeLiveStreamConfig',{liveBroadcastSession:require('../src/live-interactions').sessionKey,defaultLiveStreamConfig:{}});
 const item=serialize({isLive:true,obsStreamKey:'secret',obsUrl:'private',obsIngressId:'private-id',obsRoomName:'room',obs:{streamKey:'secret'},broadcastSource:'obs'});
 assert.equal(item.broadcastSource,'obs');assert.equal(JSON.stringify(item).includes('secret'),false);assert.equal('obs' in item,false);assert.equal('obsUrl' in item,false);
});

test('provider not_found releases an expired ingress instead of leaving the session stuck',async()=>{
 const c=setup({IngressClient:class {async createIngress(){return {ingressId:'IN_test',url:'rtmps://example',streamKey:'test'};}async listIngress(){throw Object.assign(new Error('gone'),{code:'not_found'});}async deleteIngress(){throw Object.assign(new Error('gone'),{code:'not_found'});}}});
 seedLegacy(c);await c.service.synchronize();assert.equal(c.row.obsRoomName,'');
});

test('connected OBS without published media expires and cannot keep a false live status',async()=>{
 const c=setup();seedLegacy(c);c.setMedia({status:2,tracks:[]});c.setRow({obsExpiresAt:new Date(Date.now()-1000)});
 await c.service.synchronize();assert.equal(c.row.isLive,false);assert.equal(c.row.obsRoomName,'');
});

test('OBS cannot replace a pending Android or browser preparation',async()=>{const c=setup();c.setRow({isLive:false,webrtcRoomName:'pending-camera',broadcastSource:'android'});const relay=require('../src/obs-relay-client'),saved={configured:relay.configured,request:relay.request};relay.configured=()=>true;relay.request=async()=>({});try{assert.equal((await c.call('/prepare')).code,409);}finally{Object.assign(relay,saved);}assert.equal(c.row.webrtcRoomName,'pending-camera');});

test('AI offers browser/Android controls and legacy cleanup without OBS setup tools',()=>{
 const tools=[];
 require('../src/ai-admin/live-tools').registerLiveTools({add:tool=>tools.push(tool),invoke:()=>{throw new Error('Registration must not call services');}});
 const names=tools.map(tool=>tool.name);
 assert.ok(names.includes('live_browser_end'));assert.ok(names.includes('live_obs_end'));
 assert.ok(!names.includes('live_obs_prepare'));assert.ok(!names.includes('live_recording_update'));
 assert.ok(!tools.some(tool=>['/api/live-stream/obs/prepare','/api/live-stream/obs/recording'].includes(tool.route.path)));
});
test('OBS relay media only makes the connection ready; the site goes live when the admin presses Go live',async()=>{
 const relay=require('../src/obs-relay-client'),recordings=require('../src/live-recordings'),saved={configured:relay.configured,request:relay.request,create:recordings.LiveRecording.create};
 let relayState='waiting';
 relay.configured=()=>true;
 relay.request=async(route)=>route==='sessions'?{server:'https://relay.example/whip',streamKey:'bearer-token',expiresAt:new Date(Date.now()+120000).toISOString()}:route==='health'?{}:{state:relayState,playbackUrl:'https://relay.example/play'};
 recordings.LiveRecording.create=async()=>{};
 try{
  const c=setup({randomUUID:()=>'11111111-1111-4111-8111-111111111111'});assert.equal((await c.call('/prepare',{title:'Night'})).code,201);assert.equal(c.row.obsGoLive,false);
  const room=c.row.obsRoomName;
  const early=await c.call('/go-live',{roomName:room});assert.equal(early.code,409,'no media yet: Go live is refused '+JSON.stringify(early.body));
  relayState='live';await c.service.synchronize();
  assert.equal(c.row.isLive,false,'media alone must not put the site on air');assert.equal(c.row.obsState,'ready');
  assert.equal((await c.call('/go-live',{roomName:room})).code,200);
  assert.equal(c.row.isLive,true);assert.equal(c.row.obsState,'live');assert.equal(c.row.streamUrl,'https://relay.example/play');
 }finally{Object.assign(relay,{configured:saved.configured,request:saved.request});recordings.LiveRecording.create=saved.create;}
});

test('the retired recording preference cannot re-enable capture',async()=>{
 const c=setup();const result=await c.call('/recording',{saveRecording:true});
 assert.equal(result.code,410);assert.equal(result.body.code,'LIVE_RECORDING_REMOVED');assert.equal(c.row.obsSaveRecording,undefined);
});
test('legacy OBS synchronization cannot restart an automatic recording',async()=>{
 let starts=0;const c=setup({ensureRecording:async()=>{starts++;}});seedLegacy(c);c.setRow({obsSaveRecording:true});c.setMedia({status:2,tracks:[{sid:'video'}]});
 await c.service.synchronize();assert.equal(c.row.isLive,true);assert.equal(starts,0);
});
