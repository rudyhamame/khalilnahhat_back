const test=require('node:test'),assert=require('node:assert/strict');
const {meetingJoinWindow,pruneMissedMeetings}=require('./meeting-attendance');
const minute=60000,now=Date.parse('2026-11-25T20:00:00Z');
const row=(id,changes={})=>({_id:id,status:'booked',mode:'online',start:new Date(now-120*minute),durationMin:30,clientJoinedAt:null,attendanceTrackingStartedAt:new Date(now-180*minute),...changes});
function fixture(rows,beforeDelete=()=>{}){
 const deleted=[];return {deleted,Model:{
  updateMany:async(query,update)=>{assert.equal(query.mode,'online');assert.equal(query.status,'booked');for(const row of rows)if(row.status==='booked'&&row.mode==='online'&&!row.clientJoinedAt&&!row.attendanceTrackingStartedAt&&row.start>query.start.$gt)Object.assign(row,update.$set);},
  find:query=>{assert.ok(query.$expr);return {limit:()=>({lean:async()=>rows.map(row=>({...row}))})};},
  findOneAndDelete:async query=>{assert.equal(query.clientJoinedAt,null);assert.deepEqual(query.attendanceTrackingStartedAt,{$type:'date'});assert.equal(query.mode,'online');assert.equal(query.status,'booked');await beforeDelete(query,rows);const index=rows.findIndex(row=>row._id===query._id&&row.status==='booked'&&row.mode==='online'&&!row.clientJoinedAt&&row.attendanceTrackingStartedAt&&meetingJoinWindow(row).closesAt.getTime()<now);if(index<0)return null;const [removed]=rows.splice(index,1);deleted.push(removed._id);return removed;}
 }};
}
test('the existing join window includes thirty minutes before start and one hour after the end',()=>{
 const start=new Date('2026-11-25T20:00:00Z'),window=meetingJoinWindow({start,durationMin:30});
 assert.equal(window.opensAt.toISOString(),'2026-11-25T19:30:00.000Z');assert.equal(window.closesAt.toISOString(),'2026-11-25T21:30:00.000Z');
});
test('cleanup removes only tracked, missed online bookings after the full window, preserving attendees and legacy unknowns',async()=>{
 const rows=[row('missed'),row('joined',{clientJoinedAt:new Date(now-100*minute)}),row('unknown',{attendanceTrackingStartedAt:null}),row('open',{status:'open'}),row('phone',{mode:'phone'}),row('within-window',{start:new Date(now-45*minute)}),row('exact-close',{start:new Date(now-90*minute)}),row('future-legacy',{start:new Date(now+120*minute),attendanceTrackingStartedAt:null}),row('already-open-legacy',{start:new Date(now-5*minute),attendanceTrackingStartedAt:null})];
 const fixtureData=fixture(rows),forgotten=[];assert.deepEqual(await pruneMissedMeetings({Model:fixtureData.Model,clock:()=>now,onDeleted:id=>forgotten.push(id)}),{deleted:1});
 assert.deepEqual(fixtureData.deleted,['missed']);assert.deepEqual(forgotten,['missed']);assert.equal(rows.length,8);
 assert.ok(rows.find(row=>row._id==='future-legacy').attendanceTrackingStartedAt);
 assert.equal(rows.find(row=>row._id==='unknown').attendanceTrackingStartedAt,null);
 assert.equal(rows.find(row=>row._id==='already-open-legacy').attendanceTrackingStartedAt,null);
});
test('a client joining between candidate lookup and deletion prevents the deletion atomically',async()=>{
 const rows=[row('joined-during-sweep')],fixtureData=fixture(rows,async(_query,rows)=>{rows[0].clientJoinedAt=new Date(now-1000);});
 assert.deepEqual(await pruneMissedMeetings({Model:fixtureData.Model,clock:()=>now}),{deleted:0});assert.equal(rows.length,1);
});
