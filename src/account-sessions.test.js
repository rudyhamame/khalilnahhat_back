const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {issueSession,sessionField,selectSession,sessionActor,revokeSession}=require('./account-sessions');
const isAdmin=user=>user.username==='administrator';
const browser={headers:{}},android={headers:{'x-echo-client':'android'}};
test('browser and Android administrator logins rotate independently and logout only revokes the initiating token',async()=>{
 const user={_id:'admin',username:'administrator',sessionToken:'legacy',save:async()=>{}};
 const phone=await issueSession(user,android,isAdmin);
 const web=await issueSession(user,browser,isAdmin);
 assert.equal(selectSession(user,phone),phone);assert.equal(selectSession(user,web),web);
 assert.equal(selectSession(user,'legacy'),null);
 const phone2=await issueSession(user,android,isAdmin);
 assert.equal(selectSession(user,phone),null);assert.equal(selectSession(user,web),web);
 assert.equal(selectSession(user,undefined,createHash('sha256').update(phone2).digest('hex')),phone2);
 assert.equal(sessionActor(user,phone2).sessionToken,phone2);
 const User={updateOne:async(filter,update)=>{const field=Object.keys(update.$set)[0];if(user[field]===filter[field])user[field]=update.$set[field];}};
 await revokeSession(User,user,phone2);assert.equal(selectSession(user,phone2),null);assert.equal(selectSession(user,web),web);
 await revokeSession(User,user,web);assert.equal(selectSession(user,web),null);
});
test('stale logout cannot clear a replacement login; blocking rejects every session',async()=>{
 const user={_id:'admin',username:'administrator',sessionToken:'new-web',androidSessionToken:'phone'};
 const User={updateOne:async(filter,update)=>{const field=Object.keys(update.$set)[0];if(user[field]===filter[field])user[field]=update.$set[field];}};
 await revokeSession(User,user,'old-web');assert.equal(user.sessionToken,'new-web');
 user.isBlocked=true;assert.equal(selectSession(user,'new-web'),null);assert.equal(selectSession(user,'phone'),null);
});
test('client header does not grant administrator status or extra sessions to customers',()=>{
 assert.equal(sessionField({username:'customer'},android,isAdmin),'sessionToken');
});
