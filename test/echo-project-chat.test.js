const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerEchoProjectChat,Message}=require('../src/echo-project-chat');
const {isAdminUser}=require('../src/admin-role');

test('Production Chat denies client reads and sends; only authenticated admins reach storage',async t=>{
 const original={find:Message.find,create:Message.create};let reads=0,writes=0;
 Message.find=()=>{reads++;return {sort:()=>({limit:()=>({lean:async()=>[]})})};};
 Message.create=async value=>{writes++;return {toObject:()=>({_id:'message',...value,createdAt:new Date()})};};
 const actors={admin:{_id:'admin-id',username:'khalilnahhat',firstName:'Admin'},client:{_id:'client-id',username:'customer',isAdmin:false}};
 const app=express();app.use(express.json());
 registerEchoProjectChat(app,{requireAdmin:(req,res,next)=>{
  const user=actors[req.headers.authorization?.replace('Bearer ','')];
  if(!user)return res.status(401).json({message:'Sign in required'});
  if(!isAdminUser(user))return res.status(403).json({message:'Administrator required'});
  req.user=user;next();
 }});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{Message.find=original.find;Message.create=original.create;await new Promise(resolve=>server.close(resolve));});
 const request=async(actor,method)=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/echo-project-chat`,{method,headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+actor}:{})},...(method==='POST'?{body:JSON.stringify({content:'Fixture message',senderId:'spoofed-client',senderName:'Someone else'})}:{})});
  return {status:response.status,body:await response.json()};
 };
 for(const method of ['GET','POST']){
  assert.equal((await request(null,method)).status,401);
  assert.equal((await request('client',method)).status,403);
 }
 assert.equal(reads,0);assert.equal(writes,0);
 assert.equal((await request('admin','GET')).status,200);assert.equal(reads,1);
 const result=await request('admin','POST');assert.equal(result.status,201);assert.equal(writes,1);
 assert.equal(result.body.item.senderId,'admin-id');assert.equal(result.body.item.senderName,'Admin');
});
