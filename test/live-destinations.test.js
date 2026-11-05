const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {validate,seal,unseal,createDestinationService,registerLiveDestinations}=require('../src/live-destinations');
const env={ECHO_STREAM_DESTINATION_KEY:'ab'.repeat(32),LIVEKIT_URL:'wss://qa.example',LIVEKIT_API_KEY:'qa',LIVEKIT_API_SECRET:'qa'};
const body={serverUrl:'rtmps://a.rtmps.youtube.com/live2',streamKey:'private-test-key'};
function setup(){
 const rows=[],jobs=[],started=[],stopped=[];
 const live={isLive:true,broadcastMode:'webrtc',webrtcRoomName:'owned'};
 const match=(row,filter)=>Object.entries(filter).every(([k,v])=>v&&typeof v==='object'?(!v.$nin||!v.$nin.includes(row[k])):row[k]===v);
 const query=fn=>({select:async()=>fn()});
 const Model={findOne:filter=>query(()=>rows.find(row=>match(row,filter))?{...rows.find(row=>match(row,filter))}:null),findOneAndUpdate:(filter,update,opts)=>query(()=>{let row=rows.find(row=>match(row,filter));if(!row&&opts?.upsert){if(rows.some(row=>row.platform===filter.platform))throw Object.assign(new Error('duplicate'),{code:11000});row={platform:filter.platform,_id:String(rows.length+1)};rows.push(row);}if(!row)return null;Object.assign(row,update.$set);for(const key of Object.keys(update.$unset||{}))delete row[key];return {...row};})};
 const client={async listEgress({roomName}){return jobs.filter(j=>j.roomName===roomName);},async startRoomCompositeEgress(room,output,options){started.push({room,output,options});const job={roomName:room,egressId:'job-'+started.length,status:1,streamResults:[{url:output.stream.urls[0]}]};jobs.push(job);return job;},async stopEgress(id){stopped.push(id);const job=jobs.find(j=>j.egressId===id);if(job)job.status=3;return job;}};
 const service=createDestinationService({Model,env,client:()=>client,getLiveStreamConfig:async()=>live});
 return {service,rows,jobs,live,client,started,stopped,Model};
}
test('credentials are authenticated encrypted and RTMPS URLs are strictly allowlisted',()=>{
 const encrypted=seal(body.streamKey,env);assert.equal(encrypted.includes(body.streamKey),false);assert.equal(unseal(encrypted,env),body.streamKey);
 assert.throws(()=>unseal(encrypted,{...env,ECHO_STREAM_DESTINATION_KEY:'cd'.repeat(32)}));
 for(const serverUrl of ['rtmp://a.rtmps.youtube.com/live2','rtmps://127.0.0.1/live2','rtmps://a.rtmps.youtube.com.attacker.test/live2','rtmps://a.rtmps.youtube.com/live2/key','rtmps://user:pass@a.rtmps.youtube.com/live2'])assert.throws(()=>validate('youtube',{...body,serverUrl}));
 assert.equal(validate('instagram',{serverUrl:'rtmps://live-upload.instagram.com:443/rtmp',streamKey:'valid-key?ds=1'}).streamKey,'valid-key?ds=1');
});
test('settings and status never reveal keys, encrypted payload or complete output URLs',async()=>{
 const h=setup();const saved=await h.service.save('youtube',body);assert.equal(saved.configured,true);assert.ok(!JSON.stringify(saved).includes(body.streamKey));
 const result=await h.service.start('youtube','owned');assert.equal(result.state,'live');assert.equal(h.started[0].options.encodingOptions.audioFrequency,48000);
 const status=await h.service.list();for(const secret of [body.streamKey,h.rows[0].secret])assert.ok(!JSON.stringify(status).includes(secret));
});
test('duplicate starts are fenced and a stale room cannot start or stop another session',async()=>{
 const h=setup();await h.service.save('youtube',body);await assert.rejects(h.service.start('youtube','stale'),/Start the browser/);
 const results=await Promise.allSettled([h.service.start('youtube','owned'),h.service.start('youtube','owned')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.started.length,1);
 await assert.rejects(h.service.stop('youtube','stale'),/session has changed/);assert.equal(h.stopped.length,0);
 await assert.rejects(h.service.save('youtube',body),/Stop this destination/);
});
test('Instagram uses portrait; ending one destination does not end the other or Echo',async()=>{
 const h=setup();await h.service.save('youtube',body);await h.service.save('instagram',{serverUrl:'rtmps://live-upload.instagram.com/rtmp',streamKey:'ig-private',accessConfirmed:true});
 await h.service.start('youtube','owned');await h.service.start('instagram','owned');assert.equal(h.started[1].options.encodingOptions.height,1280);assert.equal(h.started[1].options.encodingOptions.width,720);
 await h.service.stop('instagram','owned');await h.service.list();assert.deepEqual(h.stopped,['job-2']);assert.equal(h.rows[0].state,'live');assert.equal(h.live.isLive,true);
});
test('source session replacement stops only its old destination job',async()=>{
 const h=setup();await h.service.save('youtube',body);await h.service.start('youtube','owned');h.live.webrtcRoomName='replacement';await h.service.sweep();assert.deepEqual(h.stopped,['job-1']);assert.equal(h.live.webrtcRoomName,'replacement');
});
test('provider failures are redacted; uncertain starts remain reserved until the source ends',async()=>{
 const h=setup();await h.service.save('youtube',body);h.client.startRoomCompositeEgress=async()=>{throw new Error(body.streamKey);};
 await assert.rejects(h.service.start('youtube','owned'),e=>!e.message.includes(body.streamKey));
 assert.equal(h.rows[0].state,'starting');await h.service.stop('youtube','owned');assert.equal(h.rows[0].state,'stopping');await assert.rejects(h.service.start('youtube','owned'));
 h.live.isLive=false;h.live.webrtcRoomName='';await h.service.sweep();assert.equal(h.rows[0].state,'ended');
});
test('a definite provider rejection permits retry without exposing provider error text',async()=>{
 const h=setup();await h.service.save('youtube',body);h.client.startRoomCompositeEgress=async()=>{throw Object.assign(new Error(body.streamKey),{status:400});};
 await assert.rejects(h.service.start('youtube','owned'),/media service rejected/);assert.equal(h.rows[0].state,'failed');assert.ok(!JSON.stringify(await h.service.list()).includes(body.streamKey));
});
test('all destination endpoints enforce the existing admin guard including reads',async t=>{
 const app=express();app.use(express.json());const h=setup();let calls=0;
 registerLiveDestinations(app,{getLiveStreamConfig:async()=>h.live,requireAdmin:(req,res,next)=>req.headers.authorization==='Bearer admin'?next():res.status(403).json({message:'Admin only'}),service:{...h.service,list:async()=>{calls++;return {items:[]};}},startWorker:false});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port;
 for(const [method,path] of [['GET',''],['PUT','/youtube'],['POST','/youtube/start'],['POST','/instagram/stop'],['DELETE','/youtube'],['DELETE','/instagram']])assert.equal((await fetch(url+'/api/admin/live-destinations'+path,{method})).status,403);
 assert.equal(calls,0);assert.equal((await fetch(url+'/api/admin/live-destinations',{headers:{Authorization:'Bearer admin'}})).status,200);
});
test('social-only jobs do not suppress recording recovery or report capture failures',async()=>{
 const {createRecordingProviders}=require('../src/recording-providers');let restarted=0;
 const provider=createRecordingProviders({egress:()=>({listEgress:async()=>[{egressId:'social',status:1,streamResults:[{url:'redacted'}]},{egressId:'social-failed',status:4,streamResults:[]}]}),rooms:()=>({listParticipants:async()=>[{identity:'khalil-broadcaster',tracks:[{}]}]}),startCapture:async()=>{restarted++;}}).livekit;
 const result=await provider.inspect({roomName:'owned',captureAttempts:0,createdAt:new Date()}, {save:async()=>{}});
 assert.equal(restarted,1);assert.equal(result.captureState,'starting');assert.equal(result.warning,'');
});

test('Instagram stays ready for later without attempting output before access is confirmed',async()=>{
 const h=setup();const saved=await h.service.save('instagram',{serverUrl:'rtmps://live-upload.instagram.com/rtmp',streamKey:'ig-future'});
 assert.equal(saved.accessConfirmed,false);await assert.rejects(h.service.start('instagram','owned'),/Confirm Live Producer access/);assert.equal(h.started.length,0);
 await h.service.save('youtube',body);await h.service.start('youtube','owned');assert.equal(h.started.length,1);
});
const instagram={serverUrl:'rtmps://live-upload.instagram.com/rtmp',streamKey:'ig-private?auth=fixture',accessConfirmed:true};
for(const platform of ['youtube','instagram'])test(`${platform}: deleting its saved key removes the encrypted secret and requires a new key before streaming`,async()=>{
 const h=setup();await h.service.save('youtube',body);await h.service.save('instagram',instagram);
 const settings=platform==='youtube'?body:instagram;
 const result=await h.service.removeKey(platform);
 assert.equal(result.configured,false);assert.equal(result.serverUrl,settings.serverUrl);assert.equal(result.accessConfirmed,true);
 assert.equal(h.rows.find(row=>row.platform===platform).secret,undefined,'encrypted credential is removed from storage');
 assert.equal((await h.service.list()).items.find(row=>row.platform!==platform).configured,true,'the other key is retained');
 assert.ok(!JSON.stringify(result).includes(settings.streamKey));
 await assert.rejects(h.service.start(platform,'owned'),/Save this destination/);assert.equal(h.started.length,0);
 assert.equal((await h.service.removeKey(platform)).configured,false,'deleting an absent key is idempotent');
 await h.service.save(platform,settings);assert.equal((await h.service.start(platform,'owned')).state,'live');
});
test('active and uncertain outputs retain their saved key until stopped',async()=>{
 const h=setup();await h.service.save('youtube',body);const secret=h.rows[0].secret;
 for(const state of ['starting','live','stopping']){h.rows[0].state=state;await assert.rejects(h.service.removeKey('youtube'),/Stop this output/);assert.equal(h.rows[0].secret,secret);}
});
test('deleting a key fences a stream start that already read the old key',async()=>{
 const h=setup();await h.service.save('youtube',body);const update=h.Model.findOneAndUpdate;
 h.Model.findOneAndUpdate=(filter,patch,options)=>patch.$set?.state==='starting'?{select:async()=>{await h.service.removeKey('youtube');return update(filter,patch,options).select();}}:update(filter,patch,options);
 await assert.rejects(h.service.start('youtube','owned'),/destination changed/);
 assert.equal(h.started.length,0);assert.equal(h.rows[0].secret,undefined);
});
test('a stream start that wins the race blocks deletion of the now active key',async()=>{
 const h=setup();await h.service.save('youtube',body);const update=h.Model.findOneAndUpdate,secret=h.rows[0].secret;
 h.Model.findOneAndUpdate=(filter,patch,options)=>patch.$unset?.secret?{select:async()=>{await h.service.start('youtube','owned');return update(filter,patch,options).select();}}:update(filter,patch,options);
 await assert.rejects(h.service.removeKey('youtube'),/Destination changed/);
 assert.equal(h.started.length,1);assert.equal(h.rows[0].secret,secret);assert.equal(h.rows[0].state,'live');
});
test('authenticated delete endpoints confirm key removal on both platforms without media service setup',async t=>{
 const h=setup();await h.service.save('youtube',body);await h.service.save('instagram',instagram);
 const service=createDestinationService({Model:h.Model,env:{},getLiveStreamConfig:async()=>h.live});
 const app=express();registerLiveDestinations(app,{requireAdmin:(req,res,next)=>req.headers.authorization==='Bearer admin'?next():res.status(403).end(),service,startWorker:false});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const platform of ['youtube','instagram']){
  const url=`http://127.0.0.1:${server.address().port}/api/admin/live-destinations/${platform}`;
  assert.equal((await fetch(url,{method:'DELETE'})).status,403);
  assert.ok(h.rows.find(row=>row.platform===platform).secret);
  const response=await fetch(url,{method:'DELETE',headers:{Authorization:'Bearer admin'}});assert.equal(response.status,200);
  const value=await response.json();assert.equal(value.deleted,true);assert.equal(value.item.platform,platform);assert.equal(value.item.configured,false);
 }
});
