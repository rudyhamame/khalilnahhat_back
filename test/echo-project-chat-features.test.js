const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {User}=require('../src/models');
const {isAdminUser}=require('../src/admin-role');
const {registerEchoProjectChat,Topic,Message,ReadState,Presence,Receipt,ONLINE_WINDOW_MS}=require('../src/echo-project-chat');
const a='aaaaaaaaaaaaaaaaaaaaaaaa',b='bbbbbbbbbbbbbbbbbbbbbbbb',c='cccccccccccccccccccccccc';
const id=n=>n.toString(16).padStart(24,'0');
const scalar=v=>v instanceof Date?v.getTime():v&&typeof v==='object'?String(v):v;
const field=(row,path)=>path.split('.').reduce((value,key)=>value?.[key],row);
function matches(row,filter){
 return Object.entries(filter).every(([key,want])=>{
  if(key==='$or')return want.some(branch=>matches(row,branch));
  if(key==='$and')return want.every(branch=>matches(row,branch));
  const value=field(row,key);
  if(want&&typeof want==='object'&&!(want instanceof Date)&&!want._bsontype)return Object.entries(want).every(([op,target])=>({
   $gt:()=>scalar(value)>scalar(target),$lt:()=>scalar(value)<scalar(target),$ne:()=>scalar(value)!==scalar(target),$exists:()=>Boolean(value!==undefined)===target,$in:()=>target.some(item=>scalar(value)===scalar(item)),
  })[op]());
  return scalar(value)===scalar(want);
 });
}
function query(rows){let result=[...rows];return {select(){return this;},sort(order){result.sort((x,y)=>{for(const [key,direction] of Object.entries(order)){if(scalar(x[key])<scalar(y[key]))return -direction;if(scalar(x[key])>scalar(y[key]))return direction;}return 0;});return this;},limit(n){result=result.slice(0,n);return this;},async lean(){return result;}};}
async function fixture(t){
 const people=[{_id:a,username:'khalilnahhat',firstName:'Khalil',isBlocked:false},{_id:b,username:'rudy',firstName:'Rudy',isAdmin:true,adminGrantedAt:new Date(),adminGrantedBy:a},{_id:c,username:'client',firstName:'Client'}];
 const topics=[],messages=[],reads=new Map(),presence=new Map(),receipts=new Map(),restore=[];
 const replace=(object,key,value)=>{restore.push(()=>object[key]=original);const original=object[key];object[key]=value;};
 replace(Topic,'find',()=>query(topics));
 replace(Topic,'exists',async filter=>topics.some(row=>String(row._id)===filter._id));
 replace(User,'find',filter=>query(people.filter(row=>matches(row,filter))));
 replace(Message,'find',(filter={})=>query(messages.filter(row=>matches(row,filter))));
 replace(Message,'aggregate',async stages=>{const counts=new Map();for(const row of messages.filter(row=>matches(row,stages[0].$match))){const id=row.topicId||'general';counts.set(id,(counts.get(id)||0)+1);}return [...counts].map(([_id,count])=>({_id,count}));});
 replace(Message,'countDocuments',async filter=>messages.filter(row=>matches(row,filter)).length);
 replace(Message,'findById',value=>{const item=messages.find(row=>String(row._id)===String(value));return {select(){return this;},async lean(){return item||null;}};});
 replace(Message,'findOneAndDelete',async filter=>{const index=messages.findIndex(row=>matches(row,filter));return index===-1?null:messages.splice(index,1)[0];});
 replace(Message,'findOneAndUpdate',async(filter,update)=>{const row=messages.find(item=>matches(item,filter));if(!row)return null;Object.assign(row,update.$set);return {...row,toObject:()=>row};});
 replace(ReadState,'find',filter=>query([...reads.values()].filter(row=>matches(row,filter))));
 replace(ReadState,'findById',value=>({lean:async()=>reads.get(String(value))||null}));
 replace(ReadState,'updateOne',async(filter,update,options)=>{let row=reads.get(filter._id);if(!row&&options?.upsert){row={_id:filter._id,...update.$setOnInsert};reads.set(filter._id,row);}if(row&&matches(row,filter))Object.assign(row,update.$set||{});});
 replace(Presence,'find',filter=>query([...presence.values()].filter(row=>matches(row,filter))));
 replace(Presence,'updateOne',async(filter,update)=>presence.set(filter._id,{_id:filter._id,...update.$set}));
 replace(Presence,'deleteOne',async filter=>{if(matches(presence.get(filter._id)||{},filter))presence.delete(filter._id);});
 replace(Receipt,'find',filter=>query([...receipts.values()].filter(row=>matches(row,filter))));
 replace(Receipt,'deleteMany',async filter=>{for(const [key,row] of receipts)if(matches(row,filter))receipts.delete(key);});
 replace(Receipt,'bulkWrite',async operations=>{for(const {updateOne:{filter,update}} of operations){let row=receipts.get(filter._id);if(!row){row={_id:filter._id,...update.$setOnInsert};receipts.set(filter._id,row);}for(const [key,date] of Object.entries(update.$min||{}))if(!row[key]||row[key]>date)row[key]=date;}});
 const app=express();app.use(express.json());
 registerEchoProjectChat(app,{requireAdmin:(req,res,next)=>{const user=people.find(row=>row._id===req.headers.authorization?.replace('Bearer ',''));if(!user)return res.status(401).json({});if(!isAdminUser(user)||user.isBlocked)return res.status(403).json({});req.user=user;next();}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{restore.reverse().forEach(fn=>fn());await new Promise(resolve=>server.close(resolve));});
 const request=async(path='',method='GET',body,actor=a)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/echo-project-chat${path}`,{method,headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+actor}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
 const add=(n,senderId=b,attachment)=>{const row={_id:id(n),senderId,senderName:'Fixture',content:'Message '+n,createdAt:new Date(1700000000000+n*1000),...(attachment?{attachment}:{})};messages.push(row);return row;};
 return {people,messages,reads,presence,receipts,request,add};
}
test('unread messages exclude your own and only displayed-message receipts move your cursor forward',async t=>{
 const f=await fixture(t);const first=f.add(1);f.add(2,a);const latest=f.add(3);
 assert.equal((await f.request('/status')).data.unreadCount,2);
 assert.equal((await f.request('/read','POST',{messageId:first._id})).data.unreadCount,1);
 assert.equal(f.reads.has(b),false,'one admin cannot mark another admin read');
 f.add(4);assert.equal((await f.request('/read','POST',{messageId:latest._id})).data.unreadCount,1,'a message arriving after the displayed snapshot stays unread');
 await f.request('/read','POST',{messageId:first._id});assert.equal(String(f.reads.get(a).readId),latest._id,'a delayed receipt cannot roll read state back');
 assert.equal((await f.request('/status')).data.unreadCount,1);
 assert.equal((await f.request('/read','POST',{messageId:id(900)})).status,404);
 assert.equal((await f.request('/read','POST',{messageId:'invalid'})).status,400);
});
test('online presence deduplicates tabs, ignores stale or revoked admins and stamps identity on the server',async t=>{
 const f=await fixture(t),tab1='11111111-1111-4111-8111-111111111111',tab2='22222222-2222-4222-8222-222222222222';
 await f.request('/presence','POST',{clientId:tab1,online:true});
 await f.request('/presence','POST',{clientId:tab2,online:true});
 await f.request('/presence','POST',{clientId:tab1,online:true},b);
 assert.deepEqual((await f.request('/status')).data.onlineAdmins.map(row=>row.name),['Khalil','Rudy']);
 await f.request('/presence','POST',{clientId:tab1,online:false});
 assert.equal((await f.request('/status')).data.onlineAdmins.length,2,'closing one tab must not hide another online tab');
 f.presence.get(a+':'+tab2).lastSeenAt=new Date(Date.now()-ONLINE_WINDOW_MS-1);
 assert.deepEqual((await f.request('/status')).data.onlineAdmins.map(row=>row.name),['Rudy']);
 f.people[1].isAdmin=false;assert.equal((await f.request('/status')).data.onlineAdmins.length,0);
 assert.equal((await f.request('/presence','POST',{clientId:tab1,online:true,userId:b})).status,400);
});
test('admin login times remain visible offline, exclude clients and blocked admins, and cannot be supplied by presence',async t=>{
 const f=await fixture(t),at=new Date('2026-11-05T14:30:00Z');f.people[0].lastLoginAt=at;
 const status=(await f.request('/status')).data;
 assert.deepEqual(status.admins.map(row=>row.name),['Khalil','Rudy']);
 assert.equal(status.admins[0].lastLoginAt,at.toISOString());assert.equal(status.admins[0].online,false);
 assert.equal(status.admins[1].lastLoginAt,null,'old accounts have no fabricated login date');
 const body={clientId:'11111111-1111-4111-8111-111111111111',online:true};
 const online=(await f.request('/presence','POST',body)).data;
 assert.equal(online.onlineAdmins[0].lastLoginAt,at.toISOString());assert.equal(online.admins[0].online,true);
 assert.equal(f.people[0].lastLoginAt,at,'heartbeats do not count as login');
 assert.equal((await f.request('/presence','POST',{...body,lastLoginAt:'2099-01-01'})).status,400);
 f.people[1].isBlocked=true;
 assert.deepEqual((await f.request('/status')).data.admins.map(row=>row.id),[a]);
 f.people[1].isBlocked=false;f.people[1].isAdmin=false;
 assert.deepEqual((await f.request('/status')).data.admins.map(row=>row.id),[a]);
 for(const key of ['email','sessionToken','androidSessionToken','adminGrantedBy'])assert.ok(!(key in online.admins[0]));
});
test('text edits require ownership and the previous version; deletes support all your message types',async t=>{
 const f=await fixture(t),own=f.add(1,a),other=f.add(2,b),image=f.add(3,a,{type:'image',data:'image'}),voice=f.add(4,a,{type:'audio',data:'voice'});
 assert.equal((await f.request('/'+other._id,'PATCH',{content:'Changed',expectedContent:other.content})).status,409);
 const result=await f.request('/'+own._id,'PATCH',{content:'Updated text',expectedContent:own.content});assert.equal(result.status,200);assert.equal(result.data.item.content,'Updated text');assert.ok(result.data.item.editedAt);
 assert.equal((await f.request('/'+own._id,'PATCH',{content:'Stale overwrite',expectedContent:'Message 1'})).status,409);
 assert.equal((await f.request('/'+image._id,'PATCH',{content:'Caption',expectedContent:image.content})).status,409);
 assert.equal((await f.request('/'+own._id,'PATCH',{content:' ',expectedContent:'Updated text'})).status,400);
 assert.equal((await f.request('/'+other._id,'DELETE')).status,404);
 for(const row of [own,image,voice]){const deleted=await f.request('/'+row._id,'DELETE');assert.equal(deleted.status,200);assert.equal(deleted.data.deleted,true);assert.equal(deleted.data.id,row._id);}
 assert.deepEqual(f.messages.map(row=>row._id),[other._id]);
});
test('clients and signed-out visitors cannot access notifications, presence, read receipts or mutations',async t=>{
 const f=await fixture(t);f.add(1,c);
 for(const actor of [null,c])for(const [path,method,body] of [['/status','GET'],['/receipts','POST',{messageIds:[id(1)],seen:true}],['/presence','POST',{clientId:'11111111-1111-4111-8111-111111111111',online:true}],['/read','POST',{messageId:id(1)}],['/'+id(1),'DELETE'],['/'+id(1),'PATCH',{content:'edit',expectedContent:'Message 1'}]])assert.equal((await f.request(path,method,body,actor)).status,actor?403:401);
 assert.equal(f.reads.size,0);assert.equal(f.presence.size,0);assert.equal(f.messages.length,1);
});
test('chat loads the newest 200 messages in chronological display order',async t=>{
 const f=await fixture(t);for(let i=1;i<=205;i++)f.add(i);
 const rows=(await f.request()).data.items;assert.equal(rows.length,200);assert.equal(rows[0].id,id(6));assert.equal(rows.at(-1).id,id(205));
});

test('Sent, Delivered and Seen times require real acknowledgements from another admin and preserve first receipt times',async t=>{
 const f=await fixture(t),message=f.add(1,a);
 let item=(await f.request()).data.items[0];assert.equal(item.sentAt,message.createdAt.toISOString());assert.equal(item.deliveredAt,null);assert.equal(item.seenAt,null);
 await f.request('/receipts','POST',{messageIds:[message._id],seen:true},a);assert.equal(f.receipts.size,0,'a sender cannot acknowledge their own message');
 await f.request('/receipts','POST',{messageIds:[message._id],seen:false},b);
 const receipt=f.receipts.get(message._id+':'+b),delivered=receipt.deliveredAt;assert.ok(delivered instanceof Date);assert.equal(receipt.seenAt,undefined);
 item=(await f.request()).data.items[0];assert.equal(item.deliveredAt,delivered.toISOString());assert.equal(item.seenAt,null);
 await f.request('/receipts','POST',{messageIds:[message._id],seen:true},b);const seen=receipt.seenAt;assert.ok(seen instanceof Date);
 await f.request('/receipts','POST',{messageIds:[message._id],seen:true},b);assert.equal(receipt.seenAt,seen);assert.equal(receipt.deliveredAt,delivered);
 item=(await f.request()).data.items[0];assert.equal(item.seenAt,seen.toISOString());
 const edited=await f.request('/'+message._id,'PATCH',{content:'Changed text',expectedContent:message.content});assert.equal(edited.data.item.seenAt,seen.toISOString(),'editing preserves delivery timestamps');
 assert.equal((await f.request('/receipts','POST',{messageIds:[message._id],seen:true,userId:a},b)).status,400);
 assert.equal((await f.request('/receipts','POST',{messageIds:[id(900)],seen:true},b)).status,200);assert.equal(f.receipts.size,1,'nonexistent messages receive no receipt');
 await f.request('/'+message._id,'DELETE');assert.equal(f.receipts.size,0);
});
