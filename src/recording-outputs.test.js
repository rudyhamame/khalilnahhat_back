const {test}=require('node:test');const assert=require('node:assert/strict');
const {ratio,captureOutputs,outputView,recordingGroups}=require('./recording-outputs');
const {view}=require('./live-recordings');
test('capture metadata is bounded and aspect ratios are reduced without inventing legacy data',()=>{
 assert.equal(ratio(1920,1080),'16:9');assert.equal(ratio(720,1280),'9:16');assert.equal(ratio(undefined,720),null);
 assert.deepEqual(captureOutputs(undefined),[{key:'main'}]);
 for(const input of [[],[{key:'portrait',width:720,height:1280}],[{key:'main',width:0,height:720}],[{key:'main',width:9000,height:720}]])assert.throws(()=>captureOutputs(input));
 assert.equal(outputView({_id:'old'}).aspectRatio,null);
 assert.equal(outputView({_id:'part',parts:[{width:1080,height:1920}]}).aspectRatio,'9:16');
});
test('simultaneous cameras remain one row, duration is not doubled, and private source identities are omitted',()=>{
 const main={_id:'a',roomName:'session',title:'Both',outputKey:'main',width:1280,height:720,status:'ready',bytes:100,duration:30,parts:[{publicId:'secret-main',duration:30,bytes:100}]};
 const portrait={_id:'b',parentRecordingId:'a',outputKey:'portrait',width:720,height:1280,status:'ready',bytes:80,duration:29,parts:[{publicId:'secret-portrait',duration:29,bytes:80}]};
 const rows=recordingGroups([portrait,main],view);assert.equal(rows.length,1);assert.equal(rows[0].outputs.length,2);assert.equal(rows[0].bytes,180);assert.equal(rows[0].durationSec,30);assert.equal(rows[0].canRemove,true);
 assert.deepEqual(rows[0].outputs.map(out=>out.aspectRatio),['16:9','9:16']);assert.ok(!JSON.stringify(rows).includes('secret'));
 portrait.status='processing';const pending=recordingGroups([main,portrait],view)[0];assert.equal(pending.canRemove,false);assert.equal(pending.status,'processing');
});
test('the relay revokes both publishers before releasing the live reservation',async()=>{
 const relay=require('./obs-relay-client'),old=relay.request,calls=[];
 relay.request=async(route,options)=>{calls.push({route,method:options.method});return {};};
 const main='khalil-obs-12345678-1234-1234-1234-123456789abc',portrait='khalil-obs-12345678-1234-1234-1234-123456789abd';
 const updates=[];const service=require('./obs-relay-broadcast').createRelayBroadcast({defaults:{key:'live'},getLiveStreamConfig:async()=>({}),LiveStreamConfig:{findOneAndUpdate:async(filter,update)=>{updates.push(update);return update;}}});
 try{await service.stop({obsRoomName:main,obsPortraitRoomName:portrait});assert.deepEqual(calls.map(c=>c.route),['sessions/'+portrait,'sessions/'+main]);assert.equal(updates.at(-1).obsPortraitRoomName,'');
  relay.request=async()=>{throw Error('cannot revoke portrait');};updates.length=0;await assert.rejects(service.stop({obsRoomName:main,obsPortraitRoomName:portrait}));assert.equal(updates.length,1);assert.equal(updates[0].obsState,'ending');
 }finally{relay.request=old;}
});
