const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {catalog,validate,render,createNotificationEmails,registerNotificationEmails}=require('../src/notification-emails');
const {sendBrevoEmail}=require('../src/brevo');
const {sweepMeetings}=require('../src/meetings');
const {sweepQuotes}=require('../src/quote-lifecycle');
function fixture(){
 const rows=new Map();
 const store={list:async()=>[...rows.values()],get:async id=>rows.get(id),save:async(id,value,owner)=>{
  const previous=rows.get(id);if((previous?.revision||0)!==value.revision)return null;
  const row={_id:id,...value,revision:value.revision+1,updatedBy:owner};rows.set(id,row);return row;
 }};
 return {rows,service:createNotificationEmails({store})};
}
const draft=item=>({revision:item.revision,enabled:item.enabled,subject:item.subject,body:item.body,leadHours:item.leadHours});
const payload={to:[{email:'recipient@example.test',name:'Alex'}],subject:'Original subject',htmlContent:'<p>Original rich email</p>',tags:['password-reset'],notificationContext:{actionUrl:'https://example.test/reset?token=private-token'}};

test('all current events have valid defaults and existing rich emails are preserved until saved',async()=>{
 const {service,rows}=fixture();const events=await service.list();assert.equal(events.length,14);
 for(const event of events){assert.equal(event.enabled,true);validate(event.id,draft(event));}
 const actual=await service.apply(payload);assert.equal(actual.htmlContent,payload.htmlContent);assert.equal(actual.subject,payload.subject);assert.equal(actual.notificationContext,undefined);assert.equal(rows.size,0);
});
test('saved content uses the real recipient and action link without exposing template context to Brevo',async()=>{
 const {service}=fixture();const original=await service.get('password-reset');
 await service.save(original.id,{...draft(original),subject:'Hello {{recipientName}}',body:'Choose a password here:\n{{actionUrl}}'},'admin');
 const actual=await service.apply(payload);assert.equal(actual.subject,'Hello Alex');assert.ok(actual.htmlContent.includes(payload.notificationContext.actionUrl));assert.equal(actual.notificationContext,undefined);assert.equal(actual.to[0].email,'recipient@example.test');
});
test('disabled events never call Brevo, and enabled events use the existing sender configuration',async()=>{
 const {service}=fixture();let calls=0;const env={BREVO_API_KEY:'fake-test-key',EMAIL_FROM_ADDRESS:'sender@example.test',EMAIL_FROM_NAME:'Existing sender'};
 const fetchImpl=async(url,options)=>{calls++;const sent=JSON.parse(options.body);assert.equal(url,'https://api.brevo.com/v3/smtp/email');assert.equal(sent.sender.email,env.EMAIL_FROM_ADDRESS);assert.equal(sent.notificationContext,undefined);return {ok:true,json:async()=>({messageId:'test-message'})};};
 const original=await service.get('password-reset');
 const disabled=await service.save(original.id,{...draft(original),enabled:false},'admin');
 assert.equal((await sendBrevoEmail(payload,{notifications:service,env,fetchImpl})).disabled,true);assert.equal(calls,0);
 await service.save(original.id,{...draft(disabled),enabled:true},'admin');
 assert.equal((await sendBrevoEmail(payload,{notifications:service,env,fetchImpl})).sent,true);assert.equal(calls,1);
});
test('preview does not save or send, escapes content and rejects broken account links and unknown variables',async()=>{
 const {service,rows}=fixture();const original=await service.get('password-reset');
 const value={...draft(original),body:'<script>alert(1)</script>\n{{actionUrl}}'};
 const preview=service.preview(original.id,value);assert.ok(preview.html.includes('&lt;script&gt;'));assert.ok(!preview.html.includes('<script>'));assert.equal(rows.size,0);
 assert.throws(()=>service.preview(original.id,{...value,body:'No reset link'}),e=>e.status===400);
 assert.throws(()=>service.preview(original.id,{...value,body:'{{actionUrl}} {{password}}'}),e=>e.status===400);
 assert.throws(()=>service.preview(original.id,{...value,leadHours:2}),e=>e.status===400);
 assert.throws(()=>service.preview(original.id,{...value,to:'attacker@example.test'}),e=>e.status===400);
 const safe=render({subject:'Hello {{recipientName}}',body:'{{recipientName}}'},{recipientName:'<img src=x onerror=alert(1)>\r\nBcc: bad'});
 assert.ok(!safe.html.includes('<img'));assert.ok(!/[\r\n]/.test(safe.subject));
});
test('concurrent edits cannot overwrite a newer rule or modify another event',async()=>{
 const {service}=fixture();const original=await service.get('meeting-reminder');
 const saved=await service.save(original.id,{...draft(original),leadHours:2},'admin-one');assert.equal(saved.revision,1);
 await assert.rejects(service.save(original.id,{...draft(original),leadHours:3},'admin-two'),e=>e.status===409);
 assert.equal((await service.get(original.id)).leadHours,2);assert.equal((await service.get('quote-expiry-reminder')).leadHours,48);
});
test('meeting reminder lead time controls the due window and a delivered reminder is not repeated',async()=>{
 const now=Date.parse('2026-11-01T14:00:00Z'),hour=3600000;
 const rows=[{_id:'near',start:new Date(now+hour),durationMin:30,bookedByEmail:'near@example.test',bookedByName:'Near',mode:'online',reminderSentAt:null},{_id:'later',start:new Date(now+3*hour),durationMin:30,bookedByEmail:'later@example.test',mode:'online',reminderSentAt:null}];
 let enabled=true,leadHours=2;const sent=[];
 const options={clock:()=>now,notifications:{get:async()=>({enabled,leadHours})},Model:{find:async query=>rows.filter(row=>!row.reminderSentAt&&row.start>query.start.$gt&&row.start<=query.start.$lte),updateOne:async(query,update)=>Object.assign(rows.find(row=>row._id===query._id),update)},send:async email=>{sent.push(email);return {sent:true};}};
 await sweepMeetings(options);await sweepMeetings(options);assert.equal(sent.length,1);assert.equal(sent[0].to,'near@example.test');
 enabled=false;leadHours=4;await sweepMeetings(options);assert.equal(sent.length,1);
 enabled=true;await sweepMeetings(options);assert.equal(sent.length,2);
});
test('quote reminders use the saved lead time and disabling mail still expires overdue quotes',async()=>{
 const now=Date.parse('2026-11-01T14:00:00Z');let expirySweeps=0,query,sends=0,enabled=true;
 const options={clock:()=>now,notifications:{get:async()=>({enabled,leadHours:6})},Model:{updateMany:async()=>{expirySweeps++;},find:async q=>{query=q;return [{_id:'quote',expiresAt:new Date(now+3600000)}];},updateOne:async()=>{}},send:async()=>{sends++;return {sent:true};}};
 await sweepQuotes(options);assert.equal(query.expiresAt.$lte.getTime(),now+6*3600000);assert.equal(sends,1);
 enabled=false;await sweepQuotes(options);assert.equal(expirySweeps,2);assert.equal(sends,1);
});
test('the settings and preview endpoints require admin authentication and expose no Brevo key',async t=>{
 const {service}=fixture(),app=express();app.use(express.json());
 const requireAdmin=(req,res,next)=>{if(req.get('authorization')!=='Bearer admin')return res.status(401).json({message:'Admin required'});req.user={_id:'admin'};return next();};
 registerNotificationEmails(app,{requireAdmin,service,env:{BREVO_API_KEY:'never-expose-this',EMAIL_FROM_ADDRESS:'sender@example.test'}});
 app.use((error,req,res,next)=>res.status(error.status||500).json({message:error.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(path,method='GET',body,token)=>fetch(`http://127.0.0.1:${server.address().port}/api/admin/notifications/emails${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
 for(const token of [undefined,'member']){assert.equal((await call('','GET',null,token)).status,401);assert.equal((await call('/password-reset','PUT',{},token)).status,401);assert.equal((await call('/password-reset/preview','POST',{},token)).status,401);}
 const response=await call('','GET',null,'admin');assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes('never-expose-this'));assert.equal(JSON.parse(text).provider.name,'Brevo');
 const value=draft(await service.get('meeting-reminder'));
 assert.equal((await call('/meeting-reminder','PUT',{...value,leadHours:3},'admin')).status,200);
 assert.equal((await call('/meeting-reminder/preview','POST',value,'admin')).status,200);
});
