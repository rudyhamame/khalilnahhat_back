const {test}=require('node:test');
const assert=require('node:assert/strict');
const {registerLiveComments}=require('../src/live-comments');
const member={_id:'member-one',firstName:'Ana',lastName:'Member',username:'ana'};
const requireAuth=(req,res,next)=>req.authUser?next():res.status(401).json({message:'Sign in is required.'});
function setup(){
 const routes={},rows=[],stream={isLive:true,webrtcRoomName:'set-one'};let now=1000;
 const model={find(query){this.query=query;return {sort:()=>({limit:()=>({lean:async()=>rows.filter(row=>row.session===query.session).slice().reverse()})})};},async create(value){const row={...value,_id:String(rows.length+1),createdAt:new Date(now)};rows.push(row);return row;}};
 registerLiveComments({get:(_,...handlers)=>routes.get=handlers,post:(_,...handlers)=>routes.post=handlers},{requireAuth,getLiveStreamConfig:async()=>stream,CommentModel:model,clock:()=>now});
 const call=async(method,body,user=member)=>{const res={statusCode:200,status(code){this.statusCode=code;return this;},set(){return this;},json(body){this.body=body;return this;}};const req={body,ip:'test',authUser:user};const run=index=>routes[method][index]?.(req,res,()=>run(index+1));await run(0);return res;};
 return {call,stream,rows,advance:()=>now+=60001};
}
test('comments persist and public output excludes session internals',async()=>{
 const ctx=setup();assert.equal((await ctx.call('post',{session:'set-one',name:' Ana ',text:' Great set! '})).statusCode,201);
 const result=await ctx.call('get');assert.equal(result.body.items[0].text,'Great set!');assert.equal(result.body.items[0].name,'Ana Member');assert.equal(result.body.items[0].session,undefined);
});
test('offline and stale-session comments cannot leak into a new live',async()=>{
 const ctx=setup();assert.equal((await ctx.call('post',{session:'old-set',text:'Hi'})).statusCode,409);
 await ctx.call('post',{session:'set-one',text:'Hello'});ctx.stream.webrtcRoomName='set-two';assert.deepEqual((await ctx.call('get')).body.items,[]);
 ctx.stream.isLive=false;assert.equal((await ctx.call('post',{session:'set-two',text:'Hi'})).statusCode,409);assert.equal((await ctx.call('get')).body.session,null);
});
test('comments reject invalid input and limit submission bursts',async()=>{
 const ctx=setup();for(const text of ['',' '.repeat(5),'x'.repeat(281)])assert.equal((await ctx.call('post',{session:'set-one',text})).statusCode,400);
 for(let i=0;i<5;i++)assert.equal((await ctx.call('post',{session:'set-one',text:'Hi'})).statusCode,201);
 assert.equal((await ctx.call('post',{session:'set-one',text:'Hi'})).statusCode,429);ctx.advance();assert.equal((await ctx.call('post',{session:'set-one',text:'Hi'})).statusCode,201);
});

test('anonymous readers and posters are rejected before data access',async()=>{const ctx=setup();assert.equal((await ctx.call('get',null,null)).statusCode,401);assert.equal((await ctx.call('post',{session:'set-one',text:'Hi'},null)).statusCode,401);assert.equal(ctx.rows.length,0);});
