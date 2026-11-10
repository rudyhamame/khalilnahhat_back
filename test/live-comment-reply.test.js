const {test}=require('node:test');
const assert=require('node:assert/strict');
const {registerLiveComments}=require('../src/live-comments');
const ID='64b7f0c2a1b2c3d4e5f60718';
function setup(){
 const routes={},stream={isLive:true,webrtcRoomName:'set-one'};let row={_id:ID,session:'set-one',name:'Ana',text:'Hi',createdAt:new Date()};
 const model={async findOneAndUpdate(filter,change){if(filter._id!==ID||filter.session!==row.session)return null;if(change.$set)Object.assign(row,change.$set);if(change.$unset)for(const k of Object.keys(change.$unset))delete row[k];return row;}};
 const app={get:()=>{},patch:()=>{},post:(path,...handlers)=>{routes[path]=handlers;}};
 registerLiveComments(app,{requireAuth:(_q,_r,n)=>n(),requireAdmin:(_q,_r,n)=>n(),getLiveStreamConfig:async()=>stream,CommentModel:model});
 const reply=async(id,body)=>{const res={statusCode:200,status(c){this.statusCode=c;return this;},set(){return this;},json(b){this.body=b;return this;}};await routes['/api/live-comments/:id/reply'].at(-1)({params:{id},body},res);return res;};
 return {reply,stream};
}
test('host reply is stored on the comment, validated, session-bound and removable',async()=>{
 const {reply,stream}=setup();
 const ok=await reply(ID,{session:'set-one',text:'  Thank you!  '});assert.equal(ok.body.item.reply.text,'Thank you!');
 assert.equal((await reply(ID,{session:'set-one',text:'x'.repeat(281)})).statusCode,400);
 assert.equal((await reply('nope',{session:'set-one',text:'Hi'})).statusCode,400);
 assert.equal((await reply(ID,{session:'old-set',text:'Hi'})).statusCode,409);
 assert.equal((await reply(ID,{session:'set-one',text:''})).body.item.reply,undefined);
 stream.webrtcRoomName='set-two';assert.equal((await reply(ID,{session:'set-one',text:'Hi'})).statusCode,409);
});
