const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createDomainMail,registerDomainMail,BOOKINGS,textFromHtml,parseJson}=require('../src/domain-mail');

const env={ZOHO_CLIENT_ID:'private-client',ZOHO_CLIENT_SECRET:'private-secret',ZOHO_REFRESH_TOKEN:'private-refresh'};
function fixture({wrongMailbox=false,mx=true,sendError=false}={}){
 const calls=[],records=new Map();let sends=0;
 const store={async claim(owner,requestId,hash){const key=owner+requestId;if(records.has(key))return {created:false,item:records.get(key)};const item={hash,state:'pending'};records.set(key,item);return {created:true,item};},async finish(owner,requestId,values){Object.assign(records.get(owner+requestId),values);}};
 const json=data=>new Response(JSON.stringify({status:{code:200},data}));
 const fetchImpl=async(url,options={})=>{
  calls.push({url,options});
  if(url.endsWith('/oauth/v2/token'))return new Response(JSON.stringify({access_token:'private-access',expires_in:3600}));
  assert.equal(options.headers.Authorization,'Zoho-oauthtoken private-access');
  if(url.endsWith('/accounts'))return json([{accountId:'9000000000000001234',type:'ZOHO_ACCOUNT',mxStatus:mx,enabled:true,emailAddress:[{mailId:wrongMailbox?'somebody@example.test':BOOKINGS,isConfirmed:true}]}]);
  if(url.endsWith('/folders'))return json([{folderId:'1',folderName:'Inbox',folderType:'Inbox'},{folderId:'2',folderName:'Sent',folderType:'Sent'}]);
  if(url.includes('/messages/view?'))return json([{messageId:'9000000000000005678',folderId:'1',fromAddress:'customer@example.test',subject:'Event enquiry',summary:'<b>Hello</b>',receivedTime:'1794072000000',hasAttachment:'1'}]);
  if(url.endsWith('/content'))return json({content:'<script>steal()</script><p>Hello Khalil</p><img src="https://tracker.example.test/open"><p>Can we book?</p>'});
  if(url.endsWith('/details'))return json({subject:'Event enquiry',fromAddress:'customer@example.test',toAddress:BOOKINGS,replyTo:'customer@example.test'});
  if(url.endsWith('/attachmentinfo'))return json({attachments:[{attachmentId:'111',attachmentName:'brief.txt',attachmentSize:5}]});
  if(url.endsWith('/attachments/111'))return new Response('brief');
  if(options.method==='POST'){sends++;if(sendError)throw new Error('private upstream failure');return json({messageId:'9000000000000009999'});}
  throw new Error('Unexpected API call: '+url);
 };
 const service=createDomainMail({env,fetchImpl,store});return {service,calls,records,get sends(){return sends;}};
}
const draft=()=>({requestId:crypto.randomUUID(),to:['customer@example.test'],subject:'Your booking',text:'Hello, here is your booking information.'});
test('mailbox connection is explicit and credentials are never returned',async()=>{
 const service=createDomainMail({env:{}});assert.equal(service.status().configured,false);await assert.rejects(()=>service.folders(),{status:503});
 const {service:connected}=fixture();const status=JSON.stringify(connected.status());assert.equal(status.includes('private-'),false);assert.equal(connected.status().mailbox,BOOKINGS);
});
test('only the confirmed bookings account with valid MX can be used',async()=>{
 for(const options of [{wrongMailbox:true},{mx:false}])await assert.rejects(()=>fixture(options).service.folders(),{status:503});
});
test('inbox, content and real attachment download preserve long message IDs and strip active HTML',async()=>{
 const {service,calls}=fixture();assert.equal((await service.folders())[0].name,'Inbox');
 const items=await service.messages('1',51);assert.equal(items[0].id,'9000000000000005678');assert.equal(items[0].summary,'Hello');
 assert.ok(calls.some(call=>call.url.includes('start=51')));
 const detail=await service.message('1',items[0].id);assert.match(detail.text,/Hello Khalil/);assert.doesNotMatch(detail.text,/steal|tracker|script/);
 const file=await service.attachment('1',items[0].id,'111');assert.equal(file.data.toString(),'brief');
 await assert.rejects(()=>service.attachment('1',items[0].id,'999'),{status:404});
});
test('email send locks the sender, rejects header injection, and preserves provider reply threading',async()=>{
 const f=fixture(),value={...draft(),replyMessageId:'9000000000000005678'};
 await assert.rejects(()=>f.service.send('admin',{...value,from:'attacker@example.test'}),{status:400});
 await assert.rejects(()=>f.service.send('admin',{...value,subject:'hello\r\nBcc: other@example.test'}),{status:400});
 const result=await f.service.send('admin',value);assert.equal(result.sent,true);assert.equal(result.messageId,'9000000000000009999');
 const call=f.calls.find(call=>call.options.method==='POST'&&call.url.includes('/messages/'));
 const body=JSON.parse(call.options.body);assert.equal(body.fromAddress,BOOKINGS);assert.equal(body.action,'reply');assert.equal(body.mailFormat,'plaintext');
});
test('concurrent duplicate send requests cannot send twice; changed payload conflicts',async()=>{
 const f=fixture(),value=draft();const results=await Promise.allSettled([f.service.send('admin',value),f.service.send('admin',value)]);
 assert.ok(results.some(result=>result.status==='fulfilled'));assert.equal(f.sends,1);
 assert.equal((await f.service.send('admin',value)).sent,true);assert.equal(f.sends,1);
 await assert.rejects(()=>f.service.send('admin',{...value,text:'Different body'}),{status:409});
});
test('uncertain provider send is retained and retries cannot silently send a second copy',async()=>{
 const f=fixture({sendError:true}),value=draft();await assert.rejects(()=>f.service.send('admin',value),{status:502});
 await assert.rejects(()=>f.service.send('admin',value),{status:409});assert.equal(f.sends,1);
});
test('refresh token requests are shared and token is reused across mailbox calls',async()=>{
 const f=fixture();await Promise.all([f.service.folders(),f.service.folders()]);assert.equal(f.calls.filter(call=>call.url.includes('/oauth/v2/token')).length,1);
});
test('lossless JSON parsing keeps numeric provider IDs beyond safe integer precision',()=>{
 assert.equal(parseJson('{"id":9000000000000001234}').id,'9000000000000001234');assert.equal(textFromHtml('<p>A &amp; B</p>'),'A & B');
});
test('controlled activation replaces stale Gmail recipients and forces the noreply automated sender',async()=>{
 const {notificationAddress,senderAddress}=require('../src/business-mail-identity');
 const {sendBrevoEmail}=require('../src/brevo');
 const settings={DOMAIN_EMAIL_ACTIVE:'true',EMAIL_FROM_ADDRESS:'old@example.test',SERVICE_REQUEST_NOTIFICATION_EMAIL:'old@example.test',BREVO_API_KEY:'private-brevo'};
 assert.equal(notificationAddress(settings),BOOKINGS);assert.equal(senderAddress(settings),'noreply@djkhalilnahhat.ca');
 let body;await sendBrevoEmail({to:[{email:'customer@example.test'}],subject:'Booking',htmlContent:'Your booking',sender:{email:'wrong@example.test'}},{env:settings,notifications:{apply:async value=>value},fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({messageId:'confirmed'}));}});
 assert.equal(body.sender.email,'noreply@djkhalilnahhat.ca');
});
test('every mailbox route is admin-only, rejects unsafe paths, and sends no credentials',async t=>{
 const app=express();app.use(express.json());const f=fixture();
 registerDomainMail(app,{service:f.service,requireAdmin:(req,res,next)=>{if(req.get('authorization')!=='Bearer admin')return res.status(401).json({message:'Admin required'});req.user={_id:'admin'};next();}});
 app.use((error,_req,res,_next)=>res.status(error.status||500).json({message:error.message}));
 const server=await new Promise(resolve=>{const running=app.listen(0,'127.0.0.1',()=>resolve(running));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=(path,admin=false,body)=>fetch(`http://127.0.0.1:${server.address().port}/api/admin/mail${path}`,{method:body?'POST':'GET',headers:{...(admin?{Authorization:'Bearer admin'}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 for(const path of ['/status','/folders','/messages?folderId=1','/folders/1/messages/2','/folders/1/messages/2/attachments/111'])assert.equal((await request(path)).status,401);
 assert.equal((await request('/send',false,draft())).status,401);assert.equal(f.calls.length,0);
 assert.equal((await request('/messages?folderId=../accounts',true)).status,400);
 assert.equal((await request('/folders/abc/messages/2',true)).status,400);
 const response=await request('/status',true);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/private-/);
});
