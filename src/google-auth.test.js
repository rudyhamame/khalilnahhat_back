const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerGoogleAuth}=require('./google-auth');

async function setup(t,{users=[],profile={},verifyFailure=false,clientId='example.apps.googleusercontent.com',clock={value:1000}}={}){
  const records=users.map(item=>({...item,save:async()=>{}}));let verified=0,created=0;
  const User={
    findOne:async filter=>records.find(user=>user.googleSubject===filter.googleSubject)||null,
    find:filter=>({limit:async count=>records.filter(user=>user.email===filter.email).slice(0,count)}),
    findOneAndUpdate:async(filter,update)=>{const user=records.find(item=>item._id===filter._id&&!item.googleSubject);if(!user)return null;Object.assign(user,update.$set);return user;},
    create:async data=>{created++;const user={...data,_id:'new-id',save:async()=>{}};records.push(user);return user;},
  };
  const app=express();app.set('trust proxy',1);app.use(express.json());
  let nonce;
  registerGoogleAuth(app,{User,clientId,now:()=>clock.value,allowedOrigins:['https://echo.example'],isAdminUser:user=>user.username==='administrator',serializeUser:user=>({id:user._id,username:user.username,email:user.email,isAdmin:user.isAdmin}),verifyToken:async()=>{verified++;if(verifyFailure)throw Error('private provider details');return {sub:'google-subject',email:'client@gmail.com',email_verified:true,nonce,...profile};}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const config=async()=>{const response=await fetch(base+'/api/auth/google/config');const data=await response.json();nonce=data.nonce;return {response,data};};
  const post=async(body,origin='https://echo.example',ip='192.0.2.1')=>{const response=await fetch(base+'/api/auth/google',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Forwarded-For':ip},body:JSON.stringify(body||{credential:'signed-google-token',nonce})});return {status:response.status,data:await response.json()};};
  return {config,post,records,clock,stats:()=>({verified,created})};
}
test('Google sign-in stays disabled without a configured client ID',async t=>{
  const api=await setup(t,{clientId:''});const {response,data}=await api.config();assert.deepEqual(data,{configured:false});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await api.post()).status,503);assert.equal(api.stats().verified,0);
});
test('new Google clients receive a normal non-admin Echo session without a local password',async t=>{
  const api=await setup(t);const {data}=await api.config();assert.equal(data.clientId,'example.apps.googleusercontent.com');assert.equal(data.nonce.length,64);
  const result=await api.post();assert.equal(result.status,200);assert.equal(result.data.token.length,64);assert.equal(result.data.user.id,'new-id');assert.equal(result.data.user.isAdmin,false);assert.equal(api.records[0].googleSubject,'google-subject');assert.equal(api.records[0].emailVerified,true);assert.equal(api.records[0].phoneNumber,'');assert.ok(api.records[0].passwordHash);assert.equal(result.data.user.googleSubject,undefined);assert.equal(result.data.user.passwordHash,undefined);
});
test('returning Google clients keep their account and library identity even if their email changes',async t=>{
  const api=await setup(t,{users:[{_id:'owner',username:'client',googleSubject:'google-subject',email:'old@gmail.com'}]});await api.config();const result=await api.post();assert.equal(result.status,200);assert.equal(result.data.user.id,'owner');assert.equal(api.stats().created,0);
});
test('a single Gmail account matches the existing client without creating a second owner',async t=>{
  const api=await setup(t,{users:[{_id:'existing-owner',username:'client',email:'client@gmail.com',isAdmin:false}]});await api.config();const result=await api.post();assert.equal(result.status,200);assert.equal(result.data.user.id,'existing-owner');assert.equal(api.records[0].googleSubject,'google-subject');assert.equal(api.stats().created,0);
});
for(const [name,options,status] of [
  ['invalid signature',{verifyFailure:true},401],
  ['wrong nonce',{profile:{nonce:'different'}},401],
  ['unverified email',{profile:{email_verified:false}},401],
  ['missing subject',{profile:{sub:''}},401],
  ['ambiguous email',{users:[{_id:'one',email:'client@gmail.com'},{_id:'two',email:'client@gmail.com'}]},409],
  ['email linked to another Google identity',{users:[{_id:'one',email:'client@gmail.com',googleSubject:'someone-else'}]},409],
  ['administrator by flag',{users:[{_id:'admin',email:'client@gmail.com',isAdmin:true}]},409],
  ['administrator by reserved username',{users:[{_id:'admin',email:'client@gmail.com',username:'administrator'}]},409],
  ['returning administrator',{users:[{_id:'admin',googleSubject:'google-subject',isAdmin:true}]},403],
  ['third-party email collision',{profile:{email:'client@example.com'},users:[{_id:'one',email:'client@example.com'}]},409],
])test(`Google login rejects ${name}`,async t=>{const api=await setup(t,options);await api.config();const result=await api.post();assert.equal(result.status,status);assert.equal(result.data.token,undefined);assert.doesNotMatch(JSON.stringify(result.data),/private provider details/);assert.equal(api.stats().created,0);});
test('nonces expire and cannot be replayed',async t=>{
  const api=await setup(t);await api.config();assert.equal((await api.post()).status,200);assert.equal((await api.post()).status,401);await api.config();api.clock.value+=300001;assert.equal((await api.post()).status,401);assert.equal(api.stats().verified,1);
});
test('untrusted origins and missing challenges never reach token verification',async t=>{
  const api=await setup(t);await api.config();assert.equal((await api.post(undefined,'https://attacker.example')).status,403);assert.equal((await api.post({credential:'token'})).status,401);assert.equal(api.stats().verified,0);
});
test('Google-only profiles allow missing phone and surname; password accounts still require them',async()=>{
  const {User}=require('./models');
  const google=new User({googleSubject:'subject',firstName:'Client',lastName:'',username:'client',passwordHash:'unusable',email:'client@gmail.com',phoneNumber:''});assert.equal(google.validateSync(),undefined);
  const password=new User({firstName:'Client',lastName:'',username:'client',passwordHash:'hash',email:'client@gmail.com',phoneNumber:''});const errors=password.validateSync().errors;assert.ok(errors.lastName);assert.ok(errors.phoneNumber);
});

test('rate limits are bounded per client behind the hosting proxy',async t=>{
  const api=await setup(t);
  for(let i=0;i<10;i++)assert.equal((await api.post({credential:'invalid'})).status,401);
  assert.equal((await api.post({credential:'invalid'})).status,429);
  await api.config();assert.equal((await api.post(undefined,'https://echo.example','192.0.2.2')).status,200);
});
