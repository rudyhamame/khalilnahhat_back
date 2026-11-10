const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {createCloudflareMail}=require('../src/mail/service');
const {registerDomainMail}=require('../src/mail/routes');
function fixture(responses=[]){
 const rows=new Map();let requests=0;
 const store={
  async claim(owner,id,hash,value){const key=owner+':'+id;if(rows.has(key))return {created:false,item:rows.get(key)};const item={_id:'012345678901234567890123',owner,requestId:id,hash,state:'pending',...value};rows.set(key,item);return {created:true,item};},
  async finish(owner,id,values){Object.assign(rows.get(owner+':'+id),values);},
  async sendStatus(owner,id){return rows.get(owner+':'+id)||null;},
 };
 const service=createCloudflareMail({env:{DOMAIN_MAIL_SENDING_ACTIVE:'true',BREVO_API_KEY:'fixture-key'},store,fetchImpl:async()=>{requests++;const next=responses.shift();if(next instanceof Error)throw next;return next||Response.json({messageId:'qa-sent'});}});
 return {service,rows,store,requests:()=>requests};
}
const draft=()=>({requestId:crypto.randomUUID(),to:['recipient@example.invalid'],cc:[],subject:'Fixture only',text:'No real email is sent.'});
test('lost browser acknowledgement recovers sent status without sending a second email',async()=>{
 const f=fixture(),value=draft();await f.service.send('owner',value);
 assert.equal((await f.service.sendStatus('owner',value.requestId)).sent,true);
 assert.equal((await f.service.send('owner',value)).sent,true);assert.equal(f.requests(),1);
 assert.deepEqual(await f.service.sendStatus('other',value.requestId),{sent:false,sendState:'not_submitted'});
});
test('definitive provider rejection is not_sent, preserves the message and permits a fresh request',async()=>{
 const f=fixture([Response.json({message:'bad recipient'},{status:400})]),value=draft();
 await assert.rejects(f.service.send('owner',value),{status:400,sendState:'not_sent'});
 assert.equal((await f.service.sendStatus('owner',value.requestId)).sendState,'not_sent');
 await assert.rejects(f.service.send('owner',value),{sendState:'not_sent'});assert.equal(f.requests(),1);
 const fresh={...value,requestId:crypto.randomUUID()};assert.equal((await f.service.send('owner',fresh)).sent,true);assert.equal(f.requests(),2);
});
test('ambiguous network failure stays uncertain and does not silently resend',async()=>{
 const f=fixture([new Error('connection lost')]),value=draft();
 await assert.rejects(f.service.send('owner',value),{sendState:'uncertain'});
 assert.equal((await f.service.sendStatus('owner',value.requestId)).sendState,'uncertain');
 await assert.rejects(f.service.send('owner',value),{status:409});assert.equal(f.requests(),1);
});
test('status endpoint is authenticated, owner-scoped, validates IDs and does not send mail',async t=>{
 const f=fixture(),value=draft();await f.service.send('owner',value);
 const app=express();app.use(express.json());registerDomainMail(app,{service:f.service,requireAdmin:(req,res,next)=>{if(!req.headers.authorization)return res.status(401).json({message:'Sign in'});req.user={_id:req.headers.authorization};next();}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const request=async(owner,id=value.requestId)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/mail/send/${id}`,{headers:owner?{Authorization:owner}:{}});return {status:response.status,body:await response.json()};};
 assert.equal((await request()).status,401);assert.equal((await request('owner')).body.sent,true);assert.equal((await request('other')).body.sendState,'not_submitted');assert.equal((await request('owner','invalid')).status,400);assert.equal(f.requests(),1);
});

test('Brevo IP rejection identifies the server configuration problem without exposing provider details',async()=>{
 const f=fixture([Response.json({code:'unauthorized',message:'We have detected you are using an unrecognised IP address 173.206.122.228. Private provider detail: secret-token'},{status:401})]);
 const value=draft();
 await assert.rejects(f.service.send('owner',value),error=>{
  assert.equal(error.status,503);assert.equal(error.sendState,'not_sent');
  assert.match(error.message,/173\.206\.122\.228/);assert.match(error.message,/Authorized IPs/);
  assert.doesNotMatch(error.message,/secret-token|recipient/);return true;
 });
 assert.equal((await f.service.sendStatus('owner',value.requestId)).sendState,'not_sent');
 assert.equal(f.requests(),1);
});
test('provider authorization errors do not masquerade as an expired admin session',async()=>{
 const f=fixture([Response.json({code:'permission_denied',message:'private key details'},{status:403})]);
 await assert.rejects(f.service.send('owner',draft()),error=>{
  assert.equal(error.status,503);assert.equal(error.sendState,'not_sent');
  assert.match(error.message,/API key permissions/);assert.doesNotMatch(error.message,/private key details/);return true;
 });
});
