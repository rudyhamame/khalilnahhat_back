const {test}=require('node:test');
const assert=require('node:assert/strict');
const {registerLiveComments}=require('../src/live-comments');
function setup(){
 const routes={},rows=[],stream={isLive:true,webrtcRoomName:'set-one'};let now=1000;
 const model={find(query){this.query=query;return {sort:()=>({limit:()=>({lean:async()=>rows.filter(row=>row.session===query.session).slice().reverse()})})};},async create(value){const row={...value,_id:String(rows.length+1),createdAt:new Date(now)};rows.push(row);return row;}};
 registerLiveComments({get:(_,handler)=>routes.get=handler,post:(_,handler)=>routes.post=handler},{getLiveStreamConfig:async()=>stream,CommentModel:model,clock:()=>now});
 const call=async(method,body)=>{const res={statusCode:200,status(code){this.statusCode=code;return this;},set(){return this;},json(body){this.body=body;return this;}};await routes[method]({body,ip:'test'},res);return res;};
 return {call,stream,rows,advance:()=>now+=60001};
}
test('comments persist and public output excludes session internals',async()=>{
 const ctx=setup();assert.equal((await ctx.call('post',{session:'set-one',name:' Ana ',text:' Great set! '})).statusCode,201);
 const result=await ctx.call('get');assert.equal(result.body.items[0].text,'Great set!');assert.equal(result.body.items[0].name,'Ana');assert.equal(result.body.items[0].session,undefined);
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
