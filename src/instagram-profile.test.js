const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createInstagramService,registerInstagramProfile}=require('./instagram-profile');

const TOKEN='IG_VALID_TOKEN_EXAMPLE_1234567890',RENEWED='IG_RENEWED_TOKEN_EXAMPLE_1234567890';
const profile={user_id:'123456',username:'khalil_nahhat',name:'DJ Khalil Nahhat',profile_picture_url:'https://cdn.example.com/photo.jpg',followers_count:12400,follows_count:320,media_count:48};
const body={accessToken:TOKEN,enabled:true,caption:'Toronto celebrations',website:'https://example.com'};
function harness(){
 let row=null,time=Date.UTC(2026,10,15),mode='ok',calls=[];
 const repository={load:async()=>structuredClone(row),save:async(value,revision)=>{assert.equal(revision,row?.revision??null);row={...structuredClone(value),revision:(revision||0)+1};return structuredClone(row);}};
 const options={repository,env:{SESSION_ENCRYPTION_KEY:'ab'.repeat(32)},now:()=>time,fetchImpl:async(url,options)=>{
  calls.push({url:String(url),headers:options.headers});
  if(mode==='network')throw Error(`private upstream detail ${TOKEN}`);
  if(mode==='expired')return {ok:false,json:async()=>({error:{code:190,message:`private ${TOKEN}`}})};
  if(String(url).includes('refresh_access_token'))return {ok:true,json:async()=>({access_token:RENEWED,expires_in:5184000})};
  return {ok:true,json:async()=>({...profile,...(mode==='zero'?{followers_count:0,follows_count:0,media_count:0}:mode==='missing'?{followers_count:undefined}:{})})};
 }};
 return {options,service:createInstagramService(options),row:()=>row,calls:()=>calls,advance:ms=>{time+=ms;},mode:value=>{mode=value;}};
}
test('new connection validates before persistence, encrypts the token, and exposes only public fields',async()=>{
 const h=harness();
 assert.equal((await h.service.publicProfile()).profile,null);
 const result=await h.service.save(body);
 assert.equal(result.connected,true);assert.equal(result.profile.followers,12400);
 assert.ok(h.row().secret);assert.ok(!h.row().secret.includes(TOKEN));
 assert.equal(h.calls()[0].headers.Authorization,`Bearer ${TOKEN}`);
 assert.ok(!h.calls()[0].url.includes(TOKEN));
 const publicView=await h.service.publicProfile();
 assert.equal(publicView.profile.username,'khalil_nahhat');
 for(const value of [result,publicView,await h.service.status()]){
  assert.ok(!JSON.stringify(value).includes(TOKEN));assert.ok(!JSON.stringify(value).includes(h.row().secret));assert.equal(value.secret,undefined);
 }
 assert.equal(publicView.connected,undefined);assert.equal(h.calls().length,1);
});
test('refresh uses a 15 minute cache, coalesces visitors and preserves stale data on upstream failure',async()=>{
 const h=harness();await h.service.save(body);h.advance(16*60000);h.mode('network');
 const results=await Promise.all(Array.from({length:10},()=>h.service.publicProfile()));
 assert.equal(h.calls().length,2);assert.equal(results[0].stale,true);assert.equal(results[0].profile.followers,12400);assert.equal(results[0].error,undefined);
 const status=await h.service.status();assert.match(status.error,/could not be reached/);assert.ok(!JSON.stringify(status).includes(TOKEN));
 await h.service.publicProfile();assert.equal(h.calls().length,2);
 h.advance(61000);h.mode('zero');const refreshed=await h.service.publicProfile();
 assert.equal(refreshed.profile.followers,0);assert.equal(refreshed.profile.posts,0);assert.equal(refreshed.stale,false);
});
test('a rejected replacement preserves the working connection and malformed settings never reach Instagram',async()=>{
 const h=harness();await h.service.save(body);const before=structuredClone(h.row());h.mode('expired');
 await assert.rejects(h.service.save({...body,accessToken:'IG_BAD_REPLACEMENT_TOKEN_123456'}),/expired or was revoked/);
 assert.deepEqual(h.row(),before);
 const calls=h.calls().length;
 for(const patch of [{website:'javascript:alert(1)'},{password:'secret'},{accessToken:'username:password'},{caption:'x'.repeat(301)}]){
  await assert.rejects(h.service.save({...body,...patch}));
 }
 assert.equal(h.calls().length,calls);
 h.mode('missing');await assert.rejects(h.service.save(body),/all three profile counts/);assert.deepEqual(h.row(),before);
});
test('hidden cards do not refresh, disconnect erases credentials and profile, and reconnect works',async()=>{
 const h=harness();await h.service.save(body);
 await h.service.save({enabled:false,caption:'Hidden',website:''});h.advance(3600000);
 const hidden=await h.service.publicProfile();assert.equal(hidden.enabled,false);assert.equal(hidden.profile,null);assert.equal(h.calls().length,1);
 const disconnected=await h.service.disconnect();assert.equal(disconnected.connected,false);assert.equal(h.row().secret,'');assert.equal(h.row().profile,null);
 await h.service.save(body);assert.equal((await h.service.publicProfile()).profile.username,'khalil_nahhat');
});
test('long-lived tokens are renewed with the encrypted replacement persisted',async()=>{
 const h=harness();await h.service.save(body);const original=h.row().secret;h.advance(8*86400000);
 await h.service.publicProfile();
 assert.notEqual(h.row().secret,original);assert.equal(h.calls().length,3);
 assert.match(h.calls()[1].url,/refresh_access_token/);assert.equal(h.calls()[2].headers.Authorization,`Bearer ${RENEWED}`);
 const status=await h.service.status();assert.ok(status.expiresAt);assert.ok(!JSON.stringify(status).includes(RENEWED));
});
test('an encryption key is required before attempting to store a credential',async()=>{
 const h=harness(),service=createInstagramService({...h.options,env:{}});
 assert.equal((await service.status()).encryptionConfigured,false);
 await assert.rejects(service.save(body),/ENCRYPTION_KEY/);assert.equal(h.calls().length,0);assert.equal(h.row(),null);
});
test('HTTP endpoints require admin access and never expose provider errors or tokens publicly',async()=>{
 const h=harness(),app=express();app.use(express.json());
 registerInstagramProfile(app,{...h.options,requireAdmin:(req,res,next)=>req.headers.authorization==='Bearer admin'?next():res.status(401).json({message:'Admin required.'})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/api`;
 const request=(path,method='GET',data,admin=false)=>fetch(url+path,{method,headers:{'Content-Type':'application/json',...(admin?{Authorization:'Bearer admin'}:{})},...(data?{body:JSON.stringify(data)}:{})});
 try{
  for(const [path,method] of [['/admin/instagram','GET'],['/admin/instagram','PUT'],['/admin/instagram','DELETE'],['/admin/instagram/refresh','POST']])assert.equal((await request(path,method,method==='PUT'?body:undefined)).status,401);
  assert.equal((await request('/admin/instagram','PUT',body,true)).status,200);
  h.mode('expired');const response=await request('/admin/instagram/refresh','POST',undefined,true);assert.equal(response.status,422);assert.ok(!(await response.text()).includes(TOKEN));
  const publicResponse=await request('/instagram/profile');assert.equal(publicResponse.headers.get('cache-control'),'no-store');
  const text=await publicResponse.text();assert.ok(!text.includes(TOKEN));assert.ok(!text.includes('secret'));assert.ok(!text.includes('expired'));
  assert.equal((await request('/admin/instagram','DELETE',undefined,true)).status,200);
  assert.equal((await (await request('/instagram/profile')).json()).item.profile,null);
 }finally{await new Promise(r=>server.close(r));}
});
