const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const {createCloudflareMail,registerMailIngress}=require('../src/cloudflare-mail');
const {BOOKINGS}=require('../src/business-mail-identity');
const secret='ab'.repeat(32),env={MAIL_INGRESS_SECRET:secret,DOMAIN_MAIL_RECEIVING_ACTIVE:'true',DOMAIN_MAIL_SENDING_ACTIVE:'true',BREVO_API_KEY:'private-key'};
const sign=(raw,{to=BOOKINGS,from='customer@example.test',timestamp=Date.now()}={})=>{
 const digest=crypto.createHash('sha256').update(raw).digest('hex');
 return {'x-echo-mail-timestamp':String(timestamp),'x-echo-mail-to':to,'x-echo-mail-from':from,'x-echo-mail-signature':crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(`${timestamp}\n${to}\n${from}\n${digest}`).digest('hex')};
};
const mime=Buffer.from('From: Customer <customer@example.test>\r\nTo: bookings@djkhalilnahhat.ca\r\nReply-To: reply@example.test\r\nSubject: An event\r\nMessage-ID: <original@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello Khalil</p><script>steal()</script><a href="https://example.test">Our plan</a>\r\n--test\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="brief.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nYnJpZWY=\r\n--test--\r\n');
function fixture(){
 const rows=new Map(),receipts=new Map();let counter=1,sends=0,body;
 const newId=()=>String(counter++).padStart(24,'0');
 const store={
  async receive(row){if(receipts.has(row.deliveryKey))return receipts.get(row.deliveryKey);const id=newId();row._id=id;row.attachments.forEach(file=>file._id=newId());rows.set(id,row);const result={id,confirmed:true};receipts.set(row.deliveryKey,result);return result;},
  async list(folder,start){return [...rows.values()].filter(row=>row.folder===folder).slice(start-1,start+49);},
  async get(folder,id){const row=rows.get(id);return row?.folder===folder?row:null;},
  async claim(owner,requestId,hash,row){const old=[...rows.values()].find(item=>item.owner===owner&&item.requestId===requestId);if(old)return {created:false,item:old};const item={...row,_id:newId(),hash,owner,requestId,folder:'4',state:'pending'};rows.set(item._id,item);return {created:true,item};},
  async finish(owner,requestId,value){Object.assign([...rows.values()].find(item=>item.owner===owner&&item.requestId===requestId),value);},
  async move(id,folder){const row=rows.get(id);if(row)row.folder=folder;return row;},
 };
 const fetchImpl=async(_url,options)=>{sends++;body=JSON.parse(options.body);assert.equal(options.headers['api-key'],'private-key');return new Response(JSON.stringify({messageId:'<sent@brevo.test>'}));};
 return {service:createCloudflareMail({env,store,fetchImpl}),store,rows,get sends(){return sends;},get body(){return body;}};
}
test('signed MIME delivery is persisted once; HTML is inert and attachments are exact bytes',async()=>{
 const f=fixture();const result=await f.service.receive(mime,sign(mime));assert.equal(result.confirmed,true);assert.deepEqual(await f.service.receive(mime,sign(mime)),result);assert.equal(f.rows.size,1);
 const item=await f.service.message('1',result.id);assert.match(item.text,/Hello Khalil/);assert.match(item.text,/https:\/\/example.test/);assert.doesNotMatch(item.text,/steal|<script/);assert.equal(item.replyTo,'reply@example.test');
 const file=await f.service.attachment('1',result.id,item.attachments[0].id);assert.equal(file.data.toString(),'brief');assert.equal(file.data.length,5);
 await assert.rejects(()=>f.service.attachment('1',result.id,'f'.repeat(24)),{status:404});
});
test('tampering, wrong recipient, expired timestamp, bad signature and oversized mail are rejected',async()=>{
 const f=fixture();await assert.rejects(()=>f.service.receive(Buffer.concat([mime,Buffer.from('tamper')]),sign(mime)),{status:401});
 await assert.rejects(()=>f.service.receive(mime,sign(mime,{to:'noreply@djkhalilnahhat.ca'})),{status:401});
 await assert.rejects(()=>f.service.receive(mime,sign(mime,{timestamp:Date.now()-600000})),{status:401});
 await assert.rejects(()=>f.service.receive(mime,{}),{status:401});
 await assert.rejects(()=>f.service.receive(Buffer.alloc(5*1024*1024+1),{}),{status:413});assert.equal(f.rows.size,0);
});
test('readers cannot fetch another folder; replies keep headers and send only once',async()=>{
 const f=fixture(),original=await f.service.receive(mime,sign(mime));await assert.rejects(()=>f.service.message('2',original.id),{status:404});
 const value={requestId:crypto.randomUUID(),to:['reply@example.test'],subject:'Re: An event',text:'Yes, we can help.',replyMessageId:original.id};
 const result=await f.service.send('admin',value);assert.equal(result.sent,true);assert.equal(f.sends,1);assert.equal(f.body.sender.email,BOOKINGS);assert.equal(f.body.replyTo.email,BOOKINGS);assert.equal(f.body.headers['In-Reply-To'],'<original@example.test>');
 assert.equal((await f.service.send('admin',value)).messageId,result.messageId);assert.equal(f.sends,1);
 await assert.rejects(()=>f.service.send('admin',{...value,text:'Changed'}),{status:409});
 await assert.rejects(()=>f.service.send('admin',{...value,requestId:crypto.randomUUID(),sender:'bad@example.test'}),{status:400});
});
test('unconfigured services never send or imply that a mailbox is active',async()=>{
 const service=createCloudflareMail({env:{},store:{},fetchImpl:()=>assert.fail('No provider call')});assert.equal(service.status().configured,false);assert.equal(service.status().automation.configured,false);
 await assert.rejects(()=>service.send('admin',{}),{status:503});
});
test('raw ingress requires a signature and only acknowledges a persisted message',async t=>{
 const f=fixture(),app=express();registerMailIngress(app,{service:f.service});app.use((error,_req,res,_next)=>res.status(error.status||500).json({message:error.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/mail/inbound`;
 assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'message/rfc822'},body:mime})).status,401);
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'message/rfc822',...sign(mime)},body:mime});assert.equal(response.status,200);assert.equal((await response.json()).confirmed,true);
});
test('Cloudflare worker signs the actual MIME body and rejects an unconfirmed delivery',async t=>{
 const worker=(await import('../deploy/email-worker/worker.mjs')).default,originalFetch=global.fetch;let rejection='';const f=fixture();
 t.after(()=>{global.fetch=originalFetch;});
 const message=()=>({to:BOOKINGS,from:'customer@example.test',raw:new Blob([mime]).stream(),rawSize:mime.length,setReject:value=>{rejection=value;}});
 global.fetch=async(_url,options)=>new Response(JSON.stringify(await f.service.receive(Buffer.from(options.body),options.headers)));
 await worker.email(message(),{MAIL_INGRESS_SECRET:secret});assert.equal(rejection,'');assert.equal(f.rows.size,1);
 global.fetch=async()=>new Response('{}',{status:503});await worker.email(message(),{MAIL_INGRESS_SECRET:secret});assert.match(rejection,/could not accept/);
});
