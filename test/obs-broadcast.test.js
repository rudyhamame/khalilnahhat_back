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
 const service=registerObsBroadcastRoutes({get:(path,auth,handler)=>{assert.equal(auth,deps.requireAdmin);routes[path]=handler;},post:(path,auth,handler)=>{assert.equal(auth,deps.requireAdmin);routes[path]=handler;}},deps);
 return {service,removed,rooms,setRow:values=>{row={...row,...values};},get row(){return row;},setMedia:values=>{media={...media,...values};},failDelete:value=>{failDelete=value;},call:async(path,body={})=>{const res={code:200,set(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await routes['/api/live-stream/obs'+path]({body},res);return res;}};
}
test('OBS prepare reserves offline, enables recording, and returns admin-only RTMP credentials',async()=>{
 let recorded;const c=setup({prepareRecording:async(name)=>{recorded=name;}});const result=await c.call('/prepare');
 assert.equal(result.code,201);assert.equal(c.row.isLive,false);assert.equal(recorded,c.row.obsRoomName);assert.equal(c.row.obsState,'waiting');assert.equal(c.row.obsStreamKey,'private-test-key');
});
test('OBS becomes live only after actual media, and disconnect revokes the key',async()=>{
 const c=setup();await c.call('/prepare');c.setMedia({status:2});await c.service.synchronize();assert.equal(c.row.isLive,false);
 c.setMedia({tracks:[{sid:'TR_video'}]});await c.service.synchronize();assert.equal(c.row.isLive,true);
 c.setMedia({status:0,tracks:[]});await c.service.synchronize();assert.equal(c.row.isLive,false);assert.equal(c.row.obsStreamKey,'');assert.deepEqual(c.removed,['IN_test']);
});
test('OBS setup never replaces an active browser/Android broadcast or another pending OBS',async()=>{
 const c=setup();c.setRow({isLive:true,webrtcRoomName:'phone'});assert.equal((await c.call('/prepare')).code,409);assert.equal(c.row.webrtcRoomName,'phone');
 c.setRow({isLive:false,obsRoomName:'reserved'});assert.equal((await c.call('/prepare')).code,409);
});
test('recording failure does not issue a key or leave an offline reservation',async()=>{
 const c=setup({prepareRecording:async()=>{throw new Error('no storage');}});assert.equal((await c.call('/prepare')).code,503);assert.equal(c.row.obsRoomName,'');assert.equal(c.row.isLive,false);
});
test('stale end and old OBS webhook leave a newer session untouched',async()=>{
 const c=setup();await c.call('/prepare');c.setRow({obsRoomName:'khalil-obs-new',isLive:true});
 assert.equal((await c.call('/end',{roomName:'khalil-obs-test'})).body.ended,false);
 await c.service.webhook({event:'room_finished',room:{name:'khalil-obs-test'}});assert.equal(c.row.isLive,true);assert.deepEqual(c.removed,[]);
});
test('failed key revocation retains reservation and retries instead of admitting another broadcaster',async()=>{
 const c=setup();await c.call('/prepare');c.failDelete(true);assert.equal((await c.call('/end',{roomName:c.row.obsRoomName})).code,503);
 assert.equal(c.row.obsState,'ending');assert.equal(c.row.isLive,false);assert.equal((await c.call('/prepare')).code,409);
 c.failDelete(false);await c.service.synchronize();assert.equal(c.row.obsRoomName,'');
});
test('unused OBS connection expires, revoking its key',async()=>{
 const c=setup();await c.call('/prepare');c.setRow({obsExpiresAt:new Date(Date.now()-1000)});await c.service.synchronize();assert.equal(c.row.obsRoomName,'');assert.deepEqual(c.removed,['IN_test']);
});
test('public serialization excludes all OBS connection secrets, including bootstrap',()=>{
 const fs=require('node:fs'),vm=require('node:vm');const source=fs.readFileSync(require.resolve('../src/server'),'utf8');
 const fn=source.slice(source.indexOf('function serializeLiveStreamConfig('),source.indexOf('function buildMuxPlaybackUrl('));
 const serialize=vm.runInNewContext(fn+';serializeLiveStreamConfig',{defaultLiveStreamConfig:{}});
 const item=serialize({isLive:true,obsStreamKey:'secret',obsUrl:'private',obsIngressId:'private-id',obsRoomName:'room',obs:{streamKey:'secret'},broadcastSource:'obs'});
 assert.equal(item.broadcastSource,'obs');assert.equal(JSON.stringify(item).includes('secret'),false);assert.equal('obs' in item,false);assert.equal('obsUrl' in item,false);
});

test('provider not_found releases an expired ingress instead of leaving the session stuck',async()=>{
 const c=setup({IngressClient:class {async createIngress(){return {ingressId:'IN_test',url:'rtmps://example',streamKey:'test'};}async listIngress(){throw Object.assign(new Error('gone'),{code:'not_found'});}async deleteIngress(){throw Object.assign(new Error('gone'),{code:'not_found'});}}});
 await c.call('/prepare');await c.service.synchronize();assert.equal(c.row.obsRoomName,'');
});

test('connected OBS without published media expires and cannot keep a false live status',async()=>{
 const c=setup();await c.call('/prepare');c.setMedia({status:2,tracks:[]});c.setRow({obsExpiresAt:new Date(Date.now()-1000)});
 await c.service.synchronize();assert.equal(c.row.isLive,false);assert.equal(c.row.obsRoomName,'');
});
