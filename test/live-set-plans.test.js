const test=require('node:test');
const assert=require('node:assert/strict');
const {createLiveSetPlans,registerLiveSetPlans}=require('../src/live-set-plans');
const plan={segments:[{recordingIds:['a'],manualTracks:[{id:'m',title:'Manual song',artist:'Guest'}],entries:[{type:'manual',id:'m'},{type:'recording',id:'a'}]}]};
function fixture({available=true,insertFails=false}={}){
 const inserted=[],removed=[];let bookingQuery;
 const plans=createLiveSetPlans({getLiveStreamConfig:async()=>({djSetPlan:plan}),
  BookingModel:{find:()=>({select:()=>({lean:async()=>[{externalId:'booking-1',requestNumber:'ECHO-1',planning:{djSet:plan}}]})}),findOne:async query=>{bookingQuery=query;return query.externalId==='booking-1'?{planning:{djSet:plan}}:null;}},
  ArchiveModel:{find:()=>({lean:async()=>available?[{externalId:'a',title:'Archive song',artist:'Artist',audioUrl:'https://audio.example/song',audioPublicId:'must-not-copy',playState:'played'}]:[]})},
  LiveSession:{insertMany:async rows=>{inserted.push(...rows);if(insertFails)throw Error('Storage unavailable');},deleteMany:async query=>removed.push(query)}});
 return {plans,inserted,removed,get bookingQuery(){return bookingQuery;}};
}
test('saved DJ Builder lists include the live plan and confirmed booking plans',async()=>{
 const f=fixture();assert.deepEqual(await f.plans.list(),[{id:'livestream',title:'DJ Builder — Live stream',trackCount:2},{id:'booking:booking-1',title:'ECHO-1',trackCount:2}]);
 const saved=await f.plans.prepare('booking:booking-1');await saved.install('room');assert.deepEqual(f.bookingQuery.status,{$in:['confirmed']});
});
test('selected plan creates an ordered per-session snapshot without owning archive audio',async()=>{
 const f=fixture();const saved=await f.plans.prepare('livestream');await saved.install('new-room');
 assert.deepEqual(f.inserted.map(row=>row.track),['Manual song','Archive song']);
 assert.deepEqual(f.inserted.map(row=>row.sortOrder),[100,200]);
 for(const row of f.inserted){assert.equal(row.broadcastSessionId,'new-room');assert.equal(row.playState,'queued');assert.equal(row.audioPublicId,undefined);}
 assert.equal(f.inserted[1].audioUrl,'https://audio.example/song');
 assert.notEqual(f.inserted[0].externalId,f.inserted[1].externalId);
 plan.segments[0].manualTracks[0].title='Changed later';assert.equal(f.inserted[0].track,'Manual song');plan.segments[0].manualTracks[0].title='Manual song';
});
test('No set list and old clients leave the new session empty',async()=>{
 const f=fixture();await (await f.plans.prepare('none')).install('free-room');await (await f.plans.prepare()).install('old-client-room');assert.deepEqual(f.inserted,[]);
});
test('unknown, missing and withdrawn plans fail before creating a running order',async()=>{
 for(const id of [null,{},'bad','booking:missing'])await assert.rejects(fixture().plans.prepare(id),{status:409});
 const f=fixture({available:false});await assert.rejects(f.plans.prepare('livestream'),{status:409});assert.deepEqual(f.inserted,[]);
});
test('partial insertion is cleaned up only for the newly reserved session',async()=>{
 const f=fixture({insertFails:true});await assert.rejects((await f.plans.prepare('livestream')).install('new-room'));assert.deepEqual(f.removed,[{broadcastSessionId:'new-room'}]);
});
test('set-list catalog is protected by administrator middleware',async()=>{
 let handlers;const auth=()=>{};registerLiveSetPlans({get:(path,...values)=>{assert.equal(path,'/api/admin/dj-service-builder/set-lists');handlers=values;}},{requireAdmin:auth,plans:fixture().plans});
 assert.equal(handlers[0],auth);let body;await handlers[1]({}, {set(){return this;},json(data){body=data;}});assert.equal(body.items.length,2);
});
