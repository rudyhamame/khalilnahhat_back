const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {User}=require('../src/models'),{registerMobileAdmin}=require('../src/mobile-admin'),{ADMIN_USERNAMES}=require('../src/default-data');
test('admins table is protected and shows only actual roles without secrets',async t=>{
 const original=User.find;let filter,selection;
 const rows=[
  {_id:'owner',username:[...ADMIN_USERNAMES][0],firstName:'Site',lastName:'Owner',email:'owner@example.invalid',passwordHash:'secret'},
  {_id:'granted',username:'granted',firstName:'Granted',isAdmin:true,adminGrantedAt:new Date(),adminGrantedBy:'owner',sessionToken:'secret'},
  {_id:'blocked',username:'blocked',firstName:'Blocked',isAdmin:true,isBlocked:true,adminGrantedAt:new Date(),adminGrantedBy:'owner'},
  {_id:'old-flag',username:'old-flag',isAdmin:true},{_id:'client',username:'client',isAdmin:false},
 ];
 User.find=query=>{filter=query;const cursor={select(fields){selection=fields;return this;},sort(){return this;},limit(){return this;},async lean(){return rows;}};return cursor;};
 const app=express();registerMobileAdmin(app,{requireAdmin:(req,res,next)=>req.headers.authorization==='admin'?next():res.status(403).json({message:'Admin required'}),requireAuth:(req,res,next)=>next(),serializeRequest:()=>({})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{User.find=original;await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}/api/admin/admins`;
 assert.equal((await fetch(base)).status,403);
 const response=await fetch(base+'?q=%5B%2B',{headers:{Authorization:'admin'}}),data=await response.json();
 assert.equal(response.status,200);assert.deepEqual(data.items.map(row=>row.id),['owner','granted','blocked']);
 assert.equal(data.items[0].role,'Owner');assert.equal(data.items[1].role,'Administrator');assert.equal(data.items[2].isBlocked,true);
 assert.equal(JSON.stringify(data).includes('secret'),false);assert.equal(selection.includes('passwordHash'),false);assert.equal(selection.includes('sessionToken'),false);
 assert.equal(filter.$and[1].$or[0].firstName.$regex,'\\[\\+');assert.ok(filter.$and[0].$or[1].adminGrantedAt);
});
