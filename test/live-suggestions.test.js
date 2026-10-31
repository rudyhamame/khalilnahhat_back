const {test}=require('node:test'),assert=require('node:assert/strict');
const {registerLiveSuggestions,suggestionInput,platform}=require('../src/live-suggestions');
const member={_id:'member-one',firstName:'Ana',email:'ana@example.test'};
function harness(live=true){
 let handlers;const rows=[],stream={isLive:live,webrtcRoomName:'current-room'};
 const requireAuth=(req,res,next)=>req.authUser?next():res.status(401).json({message:'Sign in is required.'});
 registerLiveSuggestions({post:(p,...h)=>handlers=h},{requireAuth,getLiveStreamConfig:async()=>stream,RequestModel:{create:async row=>rows.push(row)}});
 return {rows,stream,call:async(body,user=member)=>{
  const res={code:200,status(c){this.code=c;return this;},set(){return this;},json(v){this.body=v;return this;}};
  const req={body:{session:'current-room',...body},ip:'qa',authUser:user};
  const run=index=>handlers[index]?.(req,res,()=>run(index+1));await run(0);return res;
 }};
}
test('signed-in name and link requests preserve track metadata and account ownership',async()=>{const h=harness();assert.equal((await h.call({track:'Song name',artist:'Artist'})).code,201);assert.equal((await h.call({sourceUrl:'https://youtu.be/example'})).code,201);assert.equal(h.rows[0].track,'Song name');assert.equal(h.rows[1].sourcePlatform,'youtube');assert.equal(h.rows[0].broadcastRoomName,'current-room');assert.equal(h.rows[0].requestStatus,'pending_admin');});
test('offline requests never enter the audience queue',async()=>{const h=harness(false);assert.equal((await h.call({track:'Song'})).code,409);assert.equal(h.rows.length,0);});
test('rate limit prevents repeated submissions and validates bounded HTTPS-only links',async()=>{const h=harness();for(let i=0;i<5;i++)assert.equal((await h.call({track:'Song'})).code,201);assert.equal((await h.call({track:'Song'})).code,429);for(const body of [{},{sourceUrl:'javascript:alert(1)'},{track:'a'.repeat(201)},{track:'Song',isAdmin:true}])assert.equal(suggestionInput.safeParse(body).success,false);assert.equal(platform('https://youtube.com.evil.example/a'),'link');});

test('guests and stale forms cannot submit into a different broadcast',async()=>{const h=harness();assert.equal((await h.call({track:'Song'},null)).code,401);assert.equal((await h.call({track:'Song',session:undefined})).code,400);h.stream.webrtcRoomName='next-room';assert.equal((await h.call({track:'Old form'})).code,409);assert.equal(h.rows.length,0);assert.equal((await h.call({track:'New song',session:'next-room'})).code,201);assert.equal(h.rows[0].broadcastSessionId,'next-room');assert.equal(h.rows[0].requesterUserId,member._id);});
