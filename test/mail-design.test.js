const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createMailboxEmailRenderer}=require('../src/mail/design');
const {DEFAULT_EMAIL_DESIGN}=require('../src/notification-email-design');
const {createSender}=require('../src/mail/send');

test('mailbox emails use the latest shared branding and keep manual text literal and safe',async()=>{
 let design={...DEFAULT_EMAIL_DESIGN,brandName:'Our shared brand',photoUrl:'https://example.test/shared.svg'};
 const render=createMailboxEmailRenderer({designs:{get:async()=>design}});
 const text='Hello {{customerName}},\nPlease review <script>unsafe</script> & reply.';
 const html=await render({subject:'Your event <update>',text});
 assert.match(html,/Our shared brand/);assert.match(html,/https:\/\/example.test\/shared.svg/);assert.match(html,/IBM Plex Mono/);assert.match(html,/email-music-header.png/);assert.match(html,/background:transparent/);assert.match(html,/\{\{customerName\}\}/);assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt; &amp; reply/);assert.match(html,/Your event &lt;update&gt;/);assert.match(html,/Reply to this email for assistance/);assert.ok(!html.includes('This is an automated email'));
 design={...design,brandName:'Updated shared branding'};
 assert.match(await render({subject:'Follow-up',text:'Hello'}),/Updated shared branding/);
});
test('a failed design lookup cannot send mail or leave a send marked uncertain',async()=>{
 let row,calls=0;
 const store={claim:async()=>({created:true,item:row={_id:'mail',state:'pending'}}),finish:async(_owner,_id,patch)=>Object.assign(row,patch)};
 const send=createSender({env:{DOMAIN_MAIL_SENDING_ACTIVE:'true',BREVO_API_KEY:'fixture-key'},store,renderEmail:async()=>{throw new Error('Database unavailable');},fetchImpl:async()=>{calls++;throw new Error('Must not send');}});
 await assert.rejects(send('admin',{requestId:randomUUID(),to:['client@example.test'],subject:'Hello',text:'Your event.'}),error=>error.status===503&&error.sendState==='not_sent');
 assert.equal(calls,0);assert.equal(row.state,'failed');
});
