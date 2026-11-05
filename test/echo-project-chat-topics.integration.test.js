const {test}=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const express=require('express');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {User}=require('../src/models');
const {isAdminUser}=require('../src/admin-role');
const {registerEchoProjectChat,Topic,Message,ReadState,Receipt}=require('../src/echo-project-chat');

test('discussion topics isolate persisted messages and unread state while preserving legacy General history',{timeout:45000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-chat-topics-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});
 let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();mongo.kill('SIGTERM');await new Promise(resolve=>mongo.exitCode!==null?resolve():mongo.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});});
 for(let i=0;i<50;i++){try{await mongoose.connect(`mongodb://127.0.0.1:${port}/isolated_chat_topics`,{serverSelectionTimeoutMS:300});break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 assert.equal(mongoose.connection.readyState,1);await Topic.init();
 const people=await User.create([
  {username:'khalilnahhat',firstName:'Khalil',lastName:'QA',email:'khalil@example.invalid',phoneNumber:'0',passwordHash:'unused'},
  {username:'topic-admin',firstName:'Admin',lastName:'QA',email:'admin@example.invalid',phoneNumber:'0',passwordHash:'unused',isAdmin:true,adminGrantedAt:new Date(),adminGrantedBy:new mongoose.Types.ObjectId()},
  {username:'client',firstName:'Client',lastName:'QA',email:'client@example.invalid',phoneNumber:'0',passwordHash:'unused'},
 ]);
 const [me,other,client]=people;const app=express();app.use(express.json());
 registerEchoProjectChat(app,{requireAdmin:(req,res,next)=>{const user=people.find(row=>String(row._id)===req.headers.authorization);if(!user)return res.status(401).end();if(!isAdminUser(user))return res.status(403).end();req.user=user;next();}});
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const call=async(route='',method='GET',body,actor=me)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/echo-project-chat${route}`,{method,headers:{'Content-Type':'application/json',...(actor?{Authorization:String(actor._id)}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json().catch(()=>({}))};};
 for(const actor of [null,client])for(const method of ['GET','POST'])assert.equal((await call('/topics',method,method==='POST'?{title:'Unauthorized'}:undefined,actor)).status,actor?403:401);
 assert.equal((await call('/topics','POST',{title:'   '})).status,400);
 assert.equal((await call('/topics','POST',{title:'General'})).status,409);
 assert.equal((await call('/topics','POST',{title:'Spoofed',createdBy:String(other._id)})).status,400);
 const a=(await call('/topics','POST',{title:'Website production'})).data.item;
 const b=(await call('/topics','POST',{title:'Live events'})).data.item;
 assert.equal((await Topic.findById(a.id)).createdBy,String(me._id));
 assert.equal((await call('/topics','POST',{title:'  WEBSITE   PRODUCTION  '})).status,409);
 assert.deepEqual((await call('/topics')).data.items.map(row=>row.title),['General','Website production','Live events']);
 const legacy={_id:new mongoose.Types.ObjectId(),senderId:String(other._id),senderName:'Admin',content:'Legacy message',createdAt:new Date('2025-01-01T00:00:00Z')};
 await Message.collection.insertOne(legacy);
 // The General cursor remains under the old user-only key.
 await ReadState.create({_id:String(me._id),readAt:legacy.createdAt,readId:legacy._id});
 const send=async(topicId,content,actor=other,attachment)=>{const result=await call('','POST',{topicId,content,...(attachment?{attachment}:{})},actor);assert.equal(result.status,201,JSON.stringify(result.data));return result.data.item;};
 const general=await send('general','New General message');
 const first=await send(a.id.toUpperCase(),'Website message');assert.equal(first.topicId,a.id);
 await send(a.id,'Website image',other,{type:'image',name:'QA',mimeType:'image/png',data:'data:image/png;base64,eA=='});
 const separate=await send(b.id,'Event message',other,{type:'audio',name:'QA',mimeType:'audio/webm',data:'data:audio/webm;base64,eA=='});
 const own=await send(a.id,'My website message',me);
 assert.deepEqual((await call()).data.items.map(row=>row.id),[String(legacy._id),general.id]);
 assert.equal((await call('?topicId='+a.id)).data.items.length,3);
 assert.deepEqual((await call('?topicId='+b.id)).data.items.map(row=>row.id),[separate.id]);
 const before=(await call('/status')).data;assert.deepEqual(before.topicUnreadCounts,{general:1,[a.id]:2,[b.id]:1});assert.equal(before.unreadCount,4);
 assert.equal((await call('/read','POST',{messageId:own.id,topicId:b.id})).status,404);
 const read=(await call('/read','POST',{messageId:own.id,topicId:a.id})).data;
 assert.equal(read.topicUnreadCounts[a.id],0);assert.equal(read.topicUnreadCounts[b.id],1);assert.equal(read.topicUnreadCounts.general,1);assert.equal(read.unreadCount,2);
 assert.equal((await ReadState.findById(String(me._id))).readId.toString(),legacy._id.toString());
 await call('/receipts','POST',{messageIds:[first.id],seen:true});
 assert.equal(await Receipt.countDocuments({messageId:separate.id}),0,'reading this topic does not send Seen for another topic');
 assert.equal((await call('/'+own.id,'PATCH',{content:'Edited',expectedContent:'My website message',topicId:b.id})).status,400);
 const edited=await call('/'+own.id,'PATCH',{content:'Edited',expectedContent:'My website message'});assert.equal(edited.status,200);assert.equal(edited.data.item.topicId,a.id);
 assert.equal((await call('/'+own.id,'DELETE')).status,200);assert.equal((await call('?topicId='+b.id)).data.items[0].id,separate.id);
 for(const id of ['invalid',new mongoose.Types.ObjectId().toString()]){assert.equal((await call('?topicId='+id)).status,id==='invalid'?400:404);assert.equal((await call('','POST',{topicId:id,content:'No orphan messages'})).status,id==='invalid'?400:404);}
 await Message.insertMany(Array.from({length:205},(_,i)=>({topicId:a.id,senderId:String(me._id),senderName:'QA',content:'Bounded '+i})));
 assert.equal((await call('?topicId='+a.id)).data.items.length,200);
 assert.equal((await call()).data.items.length,2,'one busy topic cannot push another topic out of its message window');
});
