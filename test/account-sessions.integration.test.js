const {test}=require('node:test');const assert=require('node:assert/strict');const mongoose=require('mongoose');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const net=require('node:net');const {spawn}=require('node:child_process');const {createHash}=require('node:crypto');
test('real HTTP administrator browser and Android sessions coexist and revoke independently',{timeout:90000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-session-qa-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});
 let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();mongo.kill('SIGTERM');await new Promise(resolve=>mongo.exitCode!==null?resolve():mongo.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});});
 for(let i=0;i<50;i++){try{await mongoose.connect(`mongodb://127.0.0.1:${port}/isolated_account_sessions`,{serverSelectionTimeoutMS:300});break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 assert.equal(mongoose.connection.readyState,1);
 const {app}=require('../src/server');const {User}=require('../src/models');const {ADMIN_USERNAME}=require('../src/default-data');const {hashPassword}=require('../src/security');
 const user=await User.create({firstName:'Admin',lastName:'QA',username:ADMIN_USERNAME,email:'sessions@example.invalid',phoneNumber:'000',passwordHash:hashPassword('Test-password-328!'),isAdmin:true});
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}/api`;
 const call=async(route,token,body,client)=>{const res=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...(client?{'X-Echo-Client':client}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
 const login=async client=>{const result=await call('/auth/login',null,{email:user.email,password:'Test-password-328!'},client);assert.equal(result.status,200,JSON.stringify(result.data));return result.data.token;};
 const [phone,web]=await Promise.all([login('android'),login()]);
 for(const token of [phone,web]){assert.equal((await call('/auth/me',token)).status,200);assert.equal((await call('/admin/overview',token)).status,200);}
 const web2=await login();assert.equal((await call('/auth/me',web)).status,401);assert.equal((await call('/auth/me',phone)).status,200);
 assert.equal((await call('/auth/logout',web2,{})).status,200);assert.equal((await call('/auth/me',web2)).status,401);assert.equal((await call('/auth/me',phone)).status,200);
 const web3=await login();await call('/auth/logout',phone,{});assert.equal((await call('/auth/me',phone)).status,401);assert.equal((await call('/auth/me',web3)).status,200);
 const phone2=await login('android');const reset='isolated-reset-token-328';await User.updateOne({_id:user._id},{$set:{resetTokenHash:createHash('sha256').update(reset).digest('hex'),resetExpires:new Date(Date.now()+60000)}});
 assert.equal((await call('/auth/reset-password',null,{token:reset,password:'Replacement-password-328!'})).status,200);
 for(const token of [phone2,web3])assert.equal((await call('/auth/me',token)).status,401);
});
