const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerBookingSignup}=require('./booking-signup');
test('a visitor creates an account, confirms the email with a code, and is only then signed in',async()=>{
 const users=[],rows=new Map(),mails=[];let clock=1_000_000;
 const match=(u,q)=>u.email===q.email;
 const User={find:q=>({limit:()=>users.filter(u=>match(u,q))}),create:async data=>{const user={...data,_id:String(users.length+1),id:String(users.length+1)};users.push(user);return user;},updateOne:async(q,patch)=>{Object.assign(users.find(u=>u._id===q._id),patch);}};
 const app=express();app.use(express.json());
 registerBookingSignup(app,{User,serializeUser:u=>({id:u.id,email:u.email}),isAdminUser:u=>Boolean(u.isAdmin),issueSession:async u=>`token-${u.id}`,sendMail:async mail=>mails.push(mail),hashPassword:async p=>`hash:${p}`,now:()=>clock,randomCode:()=>'123456',
  store:{get:async e=>rows.get(e)||null,save:async(e,row)=>rows.set(e,{...(rows.get(e)||{}),...row}),bump:async e=>{rows.get(e).attempts++;},remove:async e=>rows.delete(e)}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}/api/booking-signup`;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const details={firstName:'Sam',lastName:'Client',email:'Sam@Example.com',password:'long-enough-pw',preferredContact:'meet-echo'};
 try{
  assert.equal((await post('/start',{...details,password:'short'})).status,400);assert.equal(users.length,0);
  assert.equal((await post('/start',{...details,lastName:''})).status,400);
  for(const key of ['firstName','lastName'])assert.equal((await post('/start',{...details,[key]:'x'.repeat(61)})).status,400);
  assert.equal(users.length,0);assert.equal(mails.length,0);
  assert.equal((await post('/start',details)).status,202);
  assert.equal(users.length,1);assert.equal(users[0].awaitingVerification,true);assert.equal(users[0].emailVerified,false);assert.equal(users[0].passwordHash,'hash:long-enough-pw');assert.equal(users[0].preferredContact,'meet-echo');
  assert.equal(mails.length,1);assert.equal(mails[0].to,'sam@example.com');assert.ok(mails[0].html.includes('123456'));
  assert.equal((await post('/start',details)).status,202);assert.equal(mails.length,1); // a quick retry does not send another email
  assert.equal((await post('/verify',{email:'sam@example.com',code:'000000'})).status,400);assert.equal(users[0].emailVerified,false); // no session without the right code
  const ok=await post('/verify',{email:'sam@example.com',code:'123456'});assert.equal(ok.status,200);assert.equal((await ok.json()).token,'token-1');
  assert.equal(users[0].emailVerified,true);assert.equal(users[0].awaitingVerification,false);
  assert.equal((await post('/verify',{email:'sam@example.com',code:'123456'})).status,400); // a code works once
  assert.equal((await post('/start',details)).status,409); // the account exists now: sign in
  users.push({_id:'9',id:'9',email:'admin@example.com',isAdmin:true,emailVerified:true});
  assert.equal((await post('/start',{...details,email:'admin@example.com'})).status,409);
  clock+=120_000;users.push({_id:'10',id:'10',email:'late@example.com',firstName:'L',awaitingVerification:true,emailVerified:false});
  assert.equal((await post('/resend',{email:'late@example.com'})).status,200);assert.equal(mails.length,2); // pending accounts can ask for a new code
  assert.equal((await post('/resend',{email:'nobody@example.com'})).status,200);assert.equal(mails.length,2);
  for(let i=0;i<5;i++)await post('/verify',{email:'late@example.com',code:'111111'});
  assert.equal((await post('/verify',{email:'late@example.com',code:'123456'})).status,429);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
