const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {User}=require('../src/models');
const {registerMobileAdmin}=require('../src/mobile-admin');
const {isAdminUser,hasGrantedAdminRole}=require('../src/admin-role');
const ownerId='aaaaaaaaaaaaaaaaaaaaaaaa',clientId='bbbbbbbbbbbbbbbbbbbbbbbb';

test('only an owner allowlist entry or a recorded grant confers administrator authority',()=>{
 assert.equal(isAdminUser(null),false);
 assert.equal(isAdminUser({username:'KHALILNAHHAT'}),true);
 assert.equal(isAdminUser({username:'client',isAdmin:true}),false);
 assert.equal(isAdminUser({username:'client',isAdmin:true,adminGrantedAt:new Date()}),false);
 const grant={username:'client',isAdmin:true,adminGrantedAt:new Date(),adminGrantedBy:ownerId};
 assert.equal(isAdminUser(grant),true);assert.equal(hasGrantedAdminRole(grant),true);
 assert.equal(isAdminUser({...grant,isAdmin:false}),false);
});

async function fixture(t){
 const users=new Map([[ownerId,{_id:ownerId,username:'khalilnahhat',firstName:'Owner',lastName:'Account',email:'owner@example.invalid',isAdmin:true}],
 [clientId,{_id:clientId,username:'google-client',firstName:'Rudy',lastName:'Hamame',email:'rudy@example.invalid',isAdmin:false,isBlocked:false,googleSubject:'existing-subject',sessionToken:'existing-session',passwordHash:'unchanged-password'}]]);
 const original={findById:User.findById,findOneAndUpdate:User.findOneAndUpdate};let writes=0;
 User.findById=async id=>users.get(String(id))||null;
 User.findOneAndUpdate=async(filter,update,options)=>{
  assert.equal(options.runValidators,true);assert.equal(options.new,true);writes++;
  const user=users.get(String(filter._id));if(!user||user.isBlocked||user.adminGrantedAt)return null;
  Object.assign(user,update.$set);return user;
 };
 const guard=(req,res,next)=>{
  const actor=req.headers.authorization==='Bearer owner'?users.get(ownerId):req.headers.authorization==='Bearer client'?users.get(clientId):null;
  if(!actor)return res.status(401).json({message:'Authentication required'});
  if(!isAdminUser(actor)||actor.isBlocked)return res.status(403).json({message:'Administrator required'});
  req.user=actor;next();
 };
 const app=express();app.use(express.json());registerMobileAdmin(app,{requireAdmin:guard,requireAuth:guard,serializeRequest:()=>({})});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{User.findById=original.findById;User.findOneAndUpdate=original.findOneAndUpdate;await new Promise(resolve=>server.close(resolve));});
 const grant=async({id=clientId,actor='owner',body={}}={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/clients/${id}/admin`,{method:'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+actor}:{})},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 return {users,grant,writes:()=>writes};
}
test('ordinary and signed-out clients cannot promote an account',async t=>{
 const f=await fixture(t);
 assert.equal((await f.grant({actor:null})).status,401);
 assert.equal((await f.grant({actor:'client'})).status,403);
 assert.equal(f.writes(),0);assert.equal(f.users.get(clientId).isAdmin,false);
});
test('a grant is recorded, effective, idempotent and retains the existing account credentials',async t=>{
 const f=await fixture(t),result=await f.grant();assert.equal(result.status,200);assert.equal(result.data.granted,true);assert.equal(result.data.item.id,clientId);assert.equal(result.data.item.isAdmin,true);
 const user=f.users.get(clientId);assert.equal(isAdminUser(user),true);assert.equal(String(user.adminGrantedBy),ownerId);assert.ok(user.adminGrantedAt instanceof Date);
 assert.equal(user.googleSubject,'existing-subject');assert.equal(user.sessionToken,'existing-session');assert.equal(user.passwordHash,'unchanged-password');assert.equal(user.username,'google-client');
 assert.equal(result.data.item.passwordHash,undefined);assert.equal(result.data.item.sessionToken,undefined);
 assert.equal((await f.grant()).status,200);assert.equal(f.writes(),1);
});
test('blocked, missing and malformed targets and role payload injection are rejected',async t=>{
 const f=await fixture(t);f.users.get(clientId).isBlocked=true;
 assert.equal((await f.grant()).status,409);
 assert.equal((await f.grant({id:'cccccccccccccccccccccccc'})).status,404);
 assert.equal((await f.grant({id:'invalid'})).status,400);
 assert.equal((await f.grant({body:{isAdmin:false,adminGrantedBy:'another-user'}})).status,400);
 assert.equal(f.writes(),0);
});
