const test=require('node:test'),assert=require('node:assert/strict');const{timedComments,normalizeTimeline}=require('../src/recording-comments');
test('comments and host replies follow media time across pause gaps and trimmed previews',()=>{
 const timeline=normalizeTimeline([{startMs:10000,endMs:20000,offsetSec:0},{startMs:30000,endMs:40000,offsetSec:10}]);
 const comments=[{_id:'a',name:'A',text:'Hello',createdAt:12000,reply:{text:'Answer',at:32000}},{_id:'b',createdAt:25000},{_id:'c',createdAt:34000,hidden:true},{_id:'d',createdAt:35000}];
 const full=timedComments(comments,{timeline});assert.deepEqual(full.map(c=>c.atSec),[2,15]);assert.equal(full[0].reply.atSec,12);
 const trimmed=timedComments(comments,{timeline,offsetSec:12,durationSec:5});assert.deepEqual(trimmed.map(c=>c.atSec),[3]);
});
test('timeline rejects overlapping ranges, invalid offsets and non-finite dates',()=>{for(const value of [[{startMs:1,endMs:2,offsetSec:2}],[{startMs:2,endMs:1,offsetSec:0}],{},[{startMs:NaN,endMs:1,offsetSec:0}]])assert.throws(()=>normalizeTimeline(value));});
