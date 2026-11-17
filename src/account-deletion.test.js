const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createAccountDeletion,registerAccountDeletion}=require('./account-deletion');

function fixture({failCleanup=false,failAssets=false}={}){
 const calls=[];
 const models={
  User:{deleteOne:async filter=>{calls.push(['user',filter]);return {deletedCount:1};}},
  EventDraft:{findById:owner=>({lean:async()=>{calls.push(['read-draft',owner]);return {draftId:'draft-1'};}}),deleteOne:async filter=>{calls.push(['draft',filter]);if(failCleanup)throw Error('private DB failure');}},
  Conversation:{find:filter=>({lean:async()=>{calls.push(['read-conversations',filter]);return [{_id:'conversation-1'}];}}),deleteMany:async filter=>calls.push(['conversations',filter])},
  SimulationDraft:{deleteOne:async filter=>calls.push(['simulation',filter])},
  retire:async(owner,id)=>calls.push(['retire',owner,id]),
  assets:{prepare:async()=>{calls.push(['prepare']);return ['upload'];},finish:async()=>{calls.push(['finish']);if(failAssets)throw Error('cloud unavailable');return {pending:false};}},
 };
 return {calls,remove:createAccountDeletion(models)};
}
test('client deletion removes only their profile and private drafts after recording upload cleanup',async()=>{
 const f=fixture();assert.deepEqual(await f.remove({_id:'alice',isAdmin:false}),{deleted:true,cloudinaryCleanupPending:false});
 assert.deepEqual(f.calls.find(row=>row[0]==='draft'),['draft',{_id:'alice'}]);
 assert.deepEqual(f.calls.find(row=>row[0]==='conversations'),['conversations',{owner:'alice'}]);
 assert.deepEqual(f.calls.find(row=>row[0]==='simulation'),['simulation',{_id:'alice'}]);
 assert.deepEqual(f.calls.find(row=>row[0]==='user'),['user',{_id:'alice',isAdmin:{$ne:true}}]);
 assert.ok(f.calls.findIndex(row=>row[0]==='prepare')<f.calls.findIndex(row=>row[0]==='draft'));
 assert.deepEqual(f.calls.filter(row=>row[0]==='retire'),[['retire','alice','draft-1'],['retire','alice','conversation-1']]);
});
test('cleanup failure does not delete the login, so the client can retry',async()=>{
 const f=fixture({failCleanup:true});await assert.rejects(f.remove({_id:'alice'}));assert.equal(f.calls.some(row=>row[0]==='user'),false);
});
test('upload cleanup outage does not report a deleted account as a failure',async()=>{
 const f=fixture({failAssets:true});assert.deepEqual(await f.remove({_id:'alice'}),{deleted:true,cloudinaryCleanupPending:true});
});
test('administrator deletion is rejected before any data is touched',async()=>{
 const f=fixture();await assert.rejects(f.remove({_id:'admin',isAdmin:true}),{status:403});assert.equal(f.calls.length,0);
});
test('endpoint requires a signed-in client and explicit confirmation, and ignores supplied owner IDs',async t=>{
 const app=express(),owners=[];app.use(express.json());
 registerAccountDeletion(app,{requireAuth:(req,res,next)=>{if(!req.headers.authorization)return res.sendStatus(401);req.authUser={_id:'alice',isAdmin:req.headers.authorization==='admin'};next();},deleteAccount:async user=>{owners.push(user._id);return {deleted:true};}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=(body,token='client')=>fetch(`http://127.0.0.1:${server.address().port}/api/auth/account`,{method:'DELETE',headers:{'Content-Type':'application/json',...(token?{Authorization:token}:{})},body:JSON.stringify(body)});
 assert.equal((await request({confirmation:'DELETE'},'')).status,401);
 assert.equal((await request({})).status,400);
 assert.equal((await request({confirmation:'DELETE'},'admin')).status,403);
 assert.equal((await request({confirmation:'DELETE',userId:'bob'})).status,200);
 assert.deepEqual(owners,['alice']);
});
