const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerGuestVerification}=require('./guest-verification');
test('a guest verifies their email with a code, gets a passwordless guest account, and wrong codes and existing accounts are refused',async()=>{
 const users=[],rows=new Map(),mails=[];let clock=1_000_000,code='123456';
 const User={find:q=>({limit:()=>users.filter(u=>u.email===q.email)}),create:async data=>{const user={...data,id:String(users.length+1)};users.push(user);return user;}};
 const app=express();app.use(express.json());
 registerGuestVerification(app,{User,serializeUser:u=>({id:u.id,email:u.email,firstName:u.firstName,lastName:u.lastName}),isAdminUser:u=>Boolean(u.isAdmin),issueSession:async u=>`token-${u.id}`,sendMail:async mail=>mails.push(mail),now:()=>clock,randomCode:()=>code,
  store:{get:async e=>rows.get(e)||null,save:async(e,row)=>rows.set(e,{...(rows.get(e)||{}),...row}),bump:async e=>{rows.get(e).attempts++;},remove:async e=>rows.delete(e)}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}/api/guest/verify`;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  assert.equal((await post('/start',{email:'not an email'})).status,400);
  assert.equal((await post('/start',{email:'Guest@Example.com'})).status,200);assert.equal(mails.length,1);assert.equal(mails[0].to,'guest@example.com');assert.ok(mails[0].html.includes('123456'));
  assert.equal((await post('/start',{email:'guest@example.com'})).status,200);assert.equal(mails.length,1); // resend is throttled
  const body={email:'guest@example.com',fullName:'Sam Guest',phone:'',company:''};
  assert.equal((await post('/confirm',{...body,code:'000000'})).status,400);assert.equal(users.length,0);
  const ok=await post('/confirm',{...body,code:'123456'});assert.equal(ok.status,200);const result=await ok.json();
  assert.equal(result.token,'token-1');assert.equal(users[0].isGuest,true);assert.equal(users[0].emailVerified,true);assert.equal(users[0].lastName,'Guest');
  assert.equal((await post('/confirm',{...body,code:'123456'})).status,400); // a code works once
  // a registered (non-guest) account is never opened by a code, and gets no email
  users.push({id:'9',email:'client@example.com',isGuest:false});
  assert.equal((await post('/start',{email:'client@example.com'})).status,200);assert.equal(mails.length,1);
  clock+=120_000;rows.set('client@example.com',{codeHash:require('crypto').createHash('sha256').update('client@example.com:123456').digest('hex'),attempts:0,expiresAt:new Date(clock+60_000)});
  assert.equal((await post('/confirm',{email:'client@example.com',code:'123456',fullName:'X Y'})).status,409);
  // too many wrong codes lock the code
  clock+=120_000;await post('/start',{email:'other@example.com'});for(let i=0;i<5;i++)await post('/confirm',{email:'other@example.com',fullName:'A B',code:'111111'});
  assert.equal((await post('/confirm',{email:'other@example.com',fullName:'A B',code:'123456'})).status,429);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
