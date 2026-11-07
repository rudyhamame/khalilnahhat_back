const {test}=require('node:test');const assert=require('node:assert/strict');const mongoose=require('mongoose');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const net=require('node:net');const {spawn,spawnSync}=require('node:child_process');const {randomUUID}=require('node:crypto');
const {createEngine}=require('../src/ai-admin/engine');const {createStore}=require('../src/ai-admin/store');const {createRegistry}=require('../src/ai-admin/registry');const {createRouteAdapter}=require('../src/ai-admin/route-adapter');const {createEchoAdminAgent}=require('../src/ai-admin/agent');
test('Live studio: authenticated media, audience ownership, concurrent review and AI approval contracts',{timeout:180000},async t=>{
 assert.equal(spawnSync('mongod',['--version'],{stdio:'ignore'}).status,0,'mongod required for real transaction tests');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-admin-integration-'));const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--replSet','adminQA','--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});
 t.after(async()=>{await mongoose.disconnect();mongo.kill('SIGTERM');await new Promise(resolve=>mongo.exitCode!==null?resolve():mongo.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});});
 const uri=`mongodb://127.0.0.1:${port}`;let direct;for(let i=0;i<50;i++){try{direct=await mongoose.createConnection(uri,{directConnection:true,serverSelectionTimeoutMS:300}).asPromise();break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 assert.ok(direct);await direct.db.admin().command({replSetInitiate:{_id:'adminQA',members:[{_id:0,host:`127.0.0.1:${port}`}]}});await direct.close();await mongoose.connect(uri+'/?replicaSet=adminQA',{dbName:'ai_administrator_isolated_test',serverSelectionTimeoutMS:20000});
 process.env.MUSIC_ARCHIVE_STORAGE_DIR=path.join(dir,'assets');process.env.CLOUDINARY_CLOUD_NAME='qa-cloud';process.env.CLOUDINARY_API_KEY='';process.env.CLOUDINARY_API_SECRET='';process.env.MUSIC_ARCHIVE_STORAGE_PROVIDER='local';process.env.RENDER='false';
 process.env.ECHO_STREAM_DESTINATION_KEY='ab'.repeat(32);
 process.env.LIVEKIT_URL='wss://media.example.invalid';process.env.LIVEKIT_API_KEY='qa-key';process.env.LIVEKIT_API_SECRET='qa-secret-that-is-longer-than-32-characters';process.env.ECHO_OBS_RELAY_URL='';process.env.ECHO_OBS_RELAY_TOKEN='';
 const {app}=require('../src/server');const {User,LiveStreamConfig,LiveRequest,LiveSession}=require('../src/models');const {ADMIN_USERNAME,defaultLiveStreamConfig}=require('../src/default-data');const {hashPassword}=require('../src/security');
 await Promise.all([User,LiveRequest,LiveSession,LiveStreamConfig].map(model=>model.init()));
 const admin=await User.create({firstName:'Admin',lastName:'QA',username:ADMIN_USERNAME,email:'admin@example.invalid',phoneNumber:'000',passwordHash:hashPassword('Isolated-QA-only-2026'),sessionToken:'qa-admin',isAdmin:true});
 const customer=await User.create({firstName:'Audience',lastName:'QA',username:'audience',email:'audience@example.invalid',phoneNumber:'001',passwordHash:'unused',sessionToken:'qa-member'});
 const other=await User.create({firstName:'Other',lastName:'QA',username:'other',email:'other@example.invalid',phoneNumber:'002',passwordHash:'unused',sessionToken:'qa-other'});
 await LiveStreamConfig.findOneAndUpdate({key:defaultLiveStreamConfig.key},{$set:{...defaultLiveStreamConfig,isLive:true,broadcastSource:'browser',broadcastMode:'webrtc',webrtcRoomName:'qa-session'}},{upsert:true,new:true});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=async(path,{token='qa-member',method='GET',body}={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {code:response.status,data:await response.json()};};
 await t.test('all live engagement and credential endpoints reject unsigned and expired sessions',async()=>{
  for(const token of ['', 'expired'])for(const [path,method] of [['/live-stream/playback','POST'],['/live-stream/webrtc/viewer-token','POST'],['/youtube/search?q=QA','GET'],['/live-comments','GET'],['/live-comments','POST'],['/live-suggestions','GET'],['/live-suggestions','POST'],['/live-requests','POST'],['/live-requests/analyze','POST']])assert.equal((await call(path,{token,method,body:method==='POST'?{session:'qa-session'}:undefined})).code,401,path);
  for(const path of ['/bootstrap','/live-stream']) {const result=await call(path,{token:''});assert.equal(result.code,200);const item=result.data.liveStream||result.data.item;assert.equal(item.streamUrl,'');assert.equal(item.requiresSignIn,true);}
 });
 await t.test('members receive subscriber-only tokens for the current session',async()=>{
  assert.equal((await call('/live-stream/playback',{method:'POST',body:{session:'old'}})).code,409);
  const result=await call('/live-stream/playback',{method:'POST',body:{session:'qa-session'}});assert.equal(result.code,200);const claims=JSON.parse(Buffer.from(result.data.token.split('.')[1],'base64url'));assert.equal(claims.video.canPublish,false);assert.equal(claims.video.canPublishData,false);assert.equal(claims.video.room,'qa-session');
 });
 let request,comment;
 await t.test('requests use signed-in identity and own status never exposes another member',async()=>{
  const result=await call('/live-suggestions',{method:'POST',body:{session:'qa-session',track:'QA unique song',requesterName:'Impersonated'}});assert.equal(result.code,201);request=await LiveRequest.findOne({confirmationCode:result.data.confirmationCode});assert.equal(request.requesterName,'Audience QA');assert.equal(request.requesterUserId,String(customer._id));
  assert.equal((await call('/live-suggestions?session=qa-session',{token:'qa-other'})).data.items.length,0);assert.equal((await call('/live-suggestions?session=qa-session')).data.items.length,1);
 });
 await t.test('only administrators moderate; hidden comments disappear for every audience member and can be restored',async()=>{
  const result=await call('/live-comments',{method:'POST',body:{session:'qa-session',text:'Original QA comment',name:'Spoofed'}});assert.equal(result.code,201);comment=result.data.item;assert.equal(comment.name,'Audience QA');
  const path='/live-comments/'+comment.id+'/moderation';assert.equal((await call(path,{method:'PATCH',body:{session:'qa-session',hidden:true}})).code,401);
  assert.equal((await call(path,{token:'qa-admin',method:'PATCH',body:{session:'old',hidden:true}})).code,409);
  assert.equal((await call(path,{token:'qa-admin',method:'PATCH',body:{session:'qa-session',hidden:true}})).code,200);
  assert.equal((await call('/live-comments?session=qa-session')).data.items.length,0);assert.equal((await call('/live-comments/admin',{token:'qa-admin'})).data.items[0].hidden,true);
 });
 await t.test('simultaneous reviews create one queue item and reject stale broadcast commands',async()=>{
  const path='/live-requests/'+request.externalId+'/review';assert.equal((await call(path,{token:'qa-admin',method:'PATCH',body:{session:'old',decision:'approved'}})).code,409);
  const results=await Promise.all([1,2].map(()=>call(path,{token:'qa-admin',method:'PATCH',body:{session:'qa-session',decision:'approved'}})));assert.deepEqual(results.map(row=>row.code).sort(),[200,409]);assert.equal(await LiveSession.countDocuments({requestExternalId:request.externalId}),1);assert.equal((await LiveRequest.findById(request._id)).requestStatus,'approved');assert.equal((await call('/live-suggestions?session=qa-session')).data.items[0].status,'approved');
 });
 const outputJobs=[];
 const {EgressClient}=require('livekit-server-sdk');
 t.mock.method(EgressClient.prototype,'startRoomCompositeEgress',async function(roomName,output,options){const job={roomName,egressId:'qa-output-'+(outputJobs.length+1),status:1,streamResults:[{url:output.stream.urls[0]}]};outputJobs.push(job);return job;});
 t.mock.method(EgressClient.prototype,'listEgress',async function({roomName}){return outputJobs.filter(job=>job.roomName===roomName);});
 t.mock.method(EgressClient.prototype,'stopEgress',async function(id){const job=outputJobs.find(job=>job.egressId===id);if(job)job.status=3;return job;});
 await t.test('social destination storage uses real MongoDB, admin authorization and encrypted write-only keys',async()=>{
  const {Destination}=require('../src/live-destinations');await Destination.init();
  assert.equal((await call('/admin/live-destinations',{token:''})).code,401);
  assert.equal((await call('/admin/live-destinations')).code,401);
  const saved=await call('/admin/live-destinations/youtube',{token:'qa-admin',method:'PUT',body:{serverUrl:'rtmps://a.rtmps.youtube.com/live2',streamKey:'qa-secret-platform-key'}});
  assert.equal(saved.code,200);assert.equal(saved.data.item.configured,true);
  const raw=await Destination.findOne({platform:'youtube'}).select('+secret');assert.ok(!raw.secret.includes('qa-secret-platform-key'));
  assert.equal((await Destination.findOne({platform:'youtube'})).secret,undefined);
  const status=await call('/admin/live-destinations',{token:'qa-admin'});assert.equal(status.code,200);assert.ok(!JSON.stringify(status.data).includes('qa-secret-platform-key'));assert.equal(outputJobs.length,0);
 });
 await t.test('AI tools require approval and independently verify title and comment changes through real handlers',async()=>{
  const invoke=createRouteAdapter(app),registry=createRegistry({invoke,app}),store=createStore();await store.init();const owner=String(admin._id),authorize=async id=>id===owner?admin:null;
  const run=async(name,args)=>{let called=false;const engine=createEngine({store,registry,authorize,agent:{next:async()=>{if(called)return {calls:[],text:'Completed',output:[]};called=true;const call={type:'function_call',name,call_id:randomUUID(),arguments:JSON.stringify(args)};return {calls:[call],output:[call]};}}});const task=await engine.submit(owner,{command:'QA '+name,requestId:randomUUID()});await engine.tick();const before=await store.get(task._id);assert.equal(before.state,'AWAITING_APPROVAL',JSON.stringify(before));await engine.approve(task._id,owner,before.pending.digest);await engine.tick();const after=await store.get(task._id);assert.equal(after.state,'COMPLETED',JSON.stringify(after));assert.equal(after.actions[0].result.verified,true);return after;};
  await run('live_title_update',{title:'Verified QA broadcast'});assert.equal((await LiveStreamConfig.findOne()).title,'Verified QA broadcast');
  await run('live_goal_update',{goal:'radio'});assert.equal((await LiveStreamConfig.findOne()).goal,'radio');
  await run('live_comment_moderate',{id:comment.id,session:'qa-session',hidden:false});assert.equal((await call('/live-comments')).data.items.length,1);
  const rejected=await LiveRequest.create({externalId:'qa-decline',confirmationCode:'QA-DECLINE',track:'Decline QA',message:'Decline QA',broadcastSessionId:'qa-session',paymentStatus:'none'});await run('live_request_review',{id:rejected.externalId,session:'qa-session',decision:'rejected'});assert.equal((await LiveRequest.findById(rejected._id)).requestStatus,'rejected');
  await run('live_youtube_start',{roomName:'qa-session'});assert.equal(outputJobs.length,1);assert.equal(outputJobs[0].status,1);
  const outputs=await registry.executeRead('live_destinations_read',{},admin);assert.equal(outputs.items[0].state,'live');assert.ok(!JSON.stringify(outputs).includes('qa-secret-platform-key'));
  await run('live_youtube_stop',{roomName:'qa-session'});assert.equal(outputJobs[0].status,3);
  const tiktok=await call('/admin/live-destinations/tiktok',{token:'qa-admin',method:'PUT',body:{serverUrl:'rtmps://push-rtmp-l1-gcp01.tiktokcdn.com:443/game',streamKey:'qa-tiktok-private',accessConfirmed:true}});assert.equal(tiktok.code,200);
  await run('live_tiktok_start',{roomName:'qa-session'});assert.equal(outputJobs[1].status,1);
  const social=await registry.executeRead('live_destinations_read',{},admin);assert.equal(social.items.find(item=>item.platform==='tiktok').state,'live');assert.ok(!JSON.stringify(social).includes('qa-tiktok-private'));
  await run('live_tiktok_stop',{roomName:'qa-session'});assert.equal(outputJobs[1].status,3);

  const state=await registry.executeRead('live_stream_read',{},admin);assert.equal(state.session,'qa-session');assert.equal('streamKey' in state,false);assert.equal('url' in state,false);
 });
 await t.test('ending a session closes requests/comments and stale client reads cannot leak into the next room',async()=>{
  await LiveStreamConfig.updateOne({},{$set:{webrtcRoomName:'replacement'}});assert.equal((await call('/live-comments?session=qa-session')).code,409);assert.equal((await call('/live-suggestions?session=qa-session')).code,409);assert.equal((await call('/live-requests/admin?broadcast=current',{token:'qa-admin'})).data.items.length,0);
  await LiveStreamConfig.updateOne({},{$set:{isLive:false}});assert.equal((await call('/live-comments',{method:'POST',body:{session:'replacement',text:'stale'}})).code,409);
 });
});
