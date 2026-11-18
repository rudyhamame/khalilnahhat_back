const {test}=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const express=require('express');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {User}=require('../src/models');
const {Presence}=require('../src/echo-project-chat');
const {registerEchoProjectChatCalls}=require('../src/echo-project-chat-calls');

test('placing, accepting and ending a call each publish a "call" realtime event',{timeout:45000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-calls-rt-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});
 let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();mongo.kill('SIGTERM');await new Promise(resolve=>mongo.exitCode!==null?resolve():mongo.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});});
 for(let i=0;i<50;i++){try{await mongoose.connect(`mongodb://127.0.0.1:${port}/isolated_calls_rt`,{serverSelectionTimeoutMS:300});break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 const admin=(username)=>({username,firstName:username,lastName:'QA',email:`${username}@example.invalid`,phoneNumber:'0',passwordHash:'unused',isAdmin:true,adminGrantedAt:new Date(),adminGrantedBy:new mongoose.Types.ObjectId()});
 const [a,b]=await User.create([admin('caller'),admin('callee')]);
 await Presence.create({_id:randomUUID(),userId:String(b._id),lastSeenAt:new Date()});
 const events=[];const app=express();app.use(express.json());
 registerEchoProjectChatCalls(app,{
  requireAdmin:(req,res,next)=>{const user=[a,b].find(u=>String(u._id)===req.headers.authorization);if(!user)return res.status(401).end();req.user=user;next();},
  getConfig:()=>({apiKey:'k',apiSecret:'s'.repeat(32),wsUrl:'wss://127.0.0.1:1'}),
  publish:reason=>events.push(reason)});
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const api=async(route,method,body,actor)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/echo-project-chat/calls${route}`,{method,headers:{'Content-Type':'application/json',Authorization:String(actor._id)},body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const placed=await api('','POST',{calleeId:String(b._id),clientId:randomUUID()},a);
 assert.equal(placed.status,201);assert.deepEqual(events,['call']);
 const id=placed.body.call.id;
 assert.equal((await api(`/${id}/accept`,'POST',{clientId:randomUUID()},b)).status,200);assert.deepEqual(events,['call','call']);
 assert.equal((await api(`/${id}/end`,'POST',{},a)).status,200);assert.deepEqual(events,['call','call','call']);
 assert.equal((await api(`/${id}/end`,'POST',{},a)).status,200);assert.deepEqual(events,['call','call','call'],'ending an already-ended call must not publish again');
});
