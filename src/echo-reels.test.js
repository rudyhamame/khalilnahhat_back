const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {isEchoReel,publicReels,registerEchoReels}=require('./echo-reels');
const recordingId='a'.repeat(24),renderId='b'.repeat(24);
const ready=()=>({_id:renderId,name:'Published portrait',goal:'echo-reel-9x16',status:'ready',publicId:'private-render',width:1080,height:1920,duration:15,createdAt:new Date('2026-11-16T12:00:00Z')});
async function fixture(t,render=ready()){
 // The feed also lists gallery videos the admin published to Reels; there is no database here, so that list is empty.
 const content=require('./content'),realFind=content.MediaItem.find;content.MediaItem.find=()=>({select:()=>({sort:()=>({limit:()=>({lean:async()=>[]})})})});t.after(()=>{content.MediaItem.find=realFind;});
 const row={_id:recordingId,title:'Private source title',privateSource:'secret',renders:[render]};row.renders.id=id=>row.renders.find(item=>String(item._id)===id);
 let raced=false;
 const Recording={find:()=>({select:()=>({sort:()=>({limit:()=>({lean:async()=>[row]})})})}),findOne:async()=>row,findOneAndUpdate:async(filter,update)=>{if(raced)return null;Object.assign(render,{echoPublished:update.$set['renders.$.echoPublished'],echoPublishedAt:update.$set['renders.$.echoPublishedAt']});return row;}};
 const app=express();app.use(express.json());registerEchoReels(app,{Recording,serialize:row=>({id:String(row._id),renders:row.renders.map(({_id,echoPublished})=>({id:String(_id),echoPublished}))}),requireAdmin:(req,res,next)=>req.headers.authorization==='Bearer admin'?next():res.status(403).end(),videoUrl:r=>`https://cdn.invalid/${r._id}.mp4`});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {row,render,race:()=>{raced=true;},request:(path,body,admin=false)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(admin?{Authorization:'Bearer admin'}:{})},...(body?{body:JSON.stringify(body)}:{})})};
}
test('only finished, genuinely portrait Echo renders are eligible',()=>{
 assert.equal(isEchoReel(ready()),true);
 for(const patch of [{goal:'instagram-reel-9x16'},{status:'processing'},{status:'failed'},{publicId:''},{width:1920,height:1080},{width:null}])assert.equal(isEchoReel({...ready(),...patch}),false);
});
test('public projection never exposes private originals, unpublished renders, other platforms, tests or deleted sources',()=>{
 const published={...ready(),echoPublished:true},calls=[];
 const items=publicReels([{title:'Original private title',privateSource:'secret',renders:[published,{...ready(),_id:'draft',echoPublished:false},{...published,_id:'instagram',goal:'instagram-reel-9x16'}]},{test:true,renders:[published]},{deletedAt:new Date(),renders:[published]}],item=>{calls.push(item._id);return 'https://cdn.invalid/video.mp4';});
 assert.deepEqual(calls,[renderId]);assert.equal(items.length,1);assert.equal(items[0].title,'Published portrait');assert.doesNotMatch(JSON.stringify(items),/privateSource|secret|private-render|Original private title/);
});
test('publishing requires admin, persists per-render state and unpublishing removes it from the feed',async t=>{
 const f=await fixture(t),path=`/api/admin/live-recordings/${recordingId}/renders/${renderId}/echo`;
 assert.equal((await f.request(path,{published:true})).status,403);
 assert.deepEqual((await(await f.request('/api/reels')).json()).items,[]);
 const saved=await f.request(path,{published:true},true);assert.equal(saved.status,200);assert.equal(f.render.echoPublished,true);
 assert.equal((await(await f.request('/api/reels')).json()).items.length,1);
 assert.equal((await f.request(path,{published:false},true)).status,200);assert.equal(f.render.echoPublished,false);
 assert.deepEqual((await(await f.request('/api/reels')).json()).items,[]);
});
test('unfinished or non-Echo exports cannot be published and stale writes return a conflict',async t=>{
 const f=await fixture(t,{...ready(),goal:'youtube-short-9x16'}),path=`/api/admin/live-recordings/${recordingId}/renders/${renderId}/echo`;
 assert.equal((await f.request(path,{published:true},true)).status,409);
 f.render.goal='echo-reel-9x16';f.race();assert.equal((await f.request(path,{published:true},true)).status,409);
 assert.equal((await f.request(path,{published:'yes'},true)).status,400);
});
