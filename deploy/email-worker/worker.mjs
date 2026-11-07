const BOOKINGS='bookings@djkhalilnahhat.ca';
const INGRESS='https://echo-khalil-api.onrender.com/api/mail/inbound';
const hex=bytes=>Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
export default {
 async email(message,env){
  if(message.to.toLowerCase()!==BOOKINGS){message.setReject('This address does not accept incoming email.');return;}
  if(message.rawSize>5*1024*1024){message.setReject('Messages must be smaller than 5 MB.');return;}
  if(!/^[a-f0-9]{64}$/i.test(env.MAIL_INGRESS_SECRET||'')){message.setReject('Mailbox setup is incomplete. Please contact the website owner.');return;}
  const raw=await new Response(message.raw).arrayBuffer();
  const timestamp=String(Date.now()),digest=hex(await crypto.subtle.digest('SHA-256',raw));
  const key=await crypto.subtle.importKey('raw',new Uint8Array(env.MAIL_INGRESS_SECRET.match(/../g).map(part=>parseInt(part,16))),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}\n${BOOKINGS}\n${message.from}\n${digest}`)));
  try{
   const response=await fetch(INGRESS,{method:'POST',headers:{'Content-Type':'message/rfc822','x-echo-mail-timestamp':timestamp,'x-echo-mail-to':BOOKINGS,'x-echo-mail-from':message.from,'x-echo-mail-signature':signature},body:raw,signal:AbortSignal.timeout(50000),redirect:'error'});
   const result=await response.json().catch(()=>({}));
   if(!response.ok||result.confirmed!==true)message.setReject('The bookings mailbox could not accept this message. Please resend later.');
  }catch{message.setReject('The bookings mailbox could not accept this message. Please resend later.');}
 },
 async fetch(){return new Response('Echo bookings mail receiver. Email delivery only.',{status:404});},
};
