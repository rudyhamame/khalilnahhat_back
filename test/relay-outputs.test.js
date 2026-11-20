const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildArgs,createOutputs}=require('../deploy/obs-relay/outputs.cjs');
const {authorizeMedia}=require('../deploy/obs-relay/live-access.cjs');
const id='khalil-obs-'+'a'.repeat(8)+'-'+'b'.repeat(4)+'-'+'c'.repeat(4)+'-'+'d'.repeat(4)+'-'+'e'.repeat(12);
test('YouTube copies video; Instagram crops to 9:16; both send AAC over RTMPS',()=>{
 const yt=buildArgs(id,'youtube','rtmps://x/live2/key'),ig=buildArgs(id,'instagram','rtmps://y/rtmp/key');
 assert.deepEqual(yt.slice(yt.indexOf('-c:v'),yt.indexOf('-c:v')+2),['-c:v','copy']);
 assert.ok(ig.includes('scale=720:1280')||ig.some(a=>a.endsWith('scale=720:1280')));assert.ok(ig.includes('libx264'));
 for(const a of [yt,ig]){assert.ok(a.includes('aac'));assert.equal(a.at(-1).startsWith('rtmps://'),true);}
 assert.throws(()=>buildArgs('bad','youtube','rtmps://x'));assert.throws(()=>buildArgs(id,'facebook','rtmps://x'));
});
test('outputs track state, refuse duplicates and stop with the session',()=>{
 const children=[];const spawnProcess=()=>{const handlers={};const child={kill(){child.killed=true;},on(e,f){handlers[e]=f;},handlers};children.push(child);return child;};
 const o=createOutputs({spawnProcess});
 o.start(id,'youtube','rtmps://x/live2/key');assert.equal(o.states(id).youtube,'starting');
 assert.throws(()=>o.start(id,'youtube','rtmps://x/live2/key'));
 o.stopAll(id);assert.equal(children[0].killed,true);assert.equal(o.states(id).youtube,'stopped');
});
test('only loopback RTSP may read a live session; the public cannot',()=>{
 const row={id,state:'live',publishToken:'t'};
 assert.equal(authorizeMedia({protocol:'rtsp',action:'read',ip:'127.0.0.1'},row,'s'),true);
 assert.equal(authorizeMedia({protocol:'rtsp',action:'read',ip:'203.0.113.9'},row,'s'),false);
 assert.equal(authorizeMedia({protocol:'rtsp',action:'publish',ip:'127.0.0.1'},row,'s'),false);
 assert.equal(authorizeMedia({protocol:'rtsp',action:'read',ip:'127.0.0.1'},{...row,state:'waiting'},'s'),false);
});
