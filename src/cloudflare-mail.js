const crypto=require('node:crypto');
const express=require('express');
const mongoose=require('mongoose');
const {simpleParser}=require('mailparser');
const {z}=require('zod');
const {BOOKINGS,NOREPLY}=require('./business-mail-identity');
const {textFromHtml}=require('./domain-mail');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const MAX_EMAIL_BYTES=5*1024*1024;
const MAX_STORAGE_BYTES=100*1024*1024;
const objectId=value=>/^[a-f0-9]{24}$/.test(value);
const mailboxFields={mailbox:{type:String,required:true,default:BOOKINGS,index:true},folder:{type:String,default:'1'},
 deliveryKey:String,owner:String,requestId:String,hash:String,state:{type:String,default:'received'},providerMessageId:String,
 from:String,sender:String,to:[String],cc:[String],replyTo:String,subject:String,text:String,rfcMessageId:String,references:String,
 time:{type:Date,default:Date.now,index:true},bytes:{type:Number,default:0},
 attachments:[{name:String,data:{type:Buffer,select:false},size:Number}],read:{type:Boolean,default:false}};
const schema=new mongoose.Schema(mailboxFields,{timestamps:true});
schema.index({deliveryKey:1},{unique:true,sparse:true});
schema.index({owner:1,requestId:1},{unique:true,partialFilterExpression:{requestId:{$type:'string'}}});
const Message=mongoose.models.DomainInboxMessage||mongoose.model('DomainInboxMessage',schema);
const Quota=mongoose.models.DomainMailQuota||mongoose.model('DomainMailQuota',new mongoose.Schema({_id:String,bytes:{type:Number,default:0}}));
const noFiles='-attachments.data';
let initialized;
const ensureIndexes=()=>initialized||(initialized=Promise.all([Message.init(),Quota.init()]).catch(error=>{initialized=null;throw error;}));
const mongoStore={
 async receive(row){
  await ensureIndexes();
  const session=await mongoose.startSession();let item;
  try{await session.withTransaction(async()=>{
   item=await Message.findOne({deliveryKey:row.deliveryKey,mailbox:BOOKINGS}).session(session);if(item)return;
   await Quota.updateOne({_id:BOOKINGS},{$setOnInsert:{bytes:0}},{upsert:true,session});
   const reserved=await Quota.findOneAndUpdate({_id:BOOKINGS,bytes:{$lte:MAX_STORAGE_BYTES-row.bytes}},{$inc:{bytes:row.bytes}},{new:true,session});
   if(!reserved)throw fail(507,'The mailbox is full.');
   [item]=await Message.create([row],{session});
  });return {id:String(item._id),confirmed:true};}
  catch(error){if(error.code===11000){const existing=await Message.findOne({mailbox:BOOKINGS,deliveryKey:row.deliveryKey});if(existing)return {id:String(existing._id),confirmed:true};}throw error;}
  finally{await session.endSession();}
 },
 list:async(folder,start)=>Message.find({mailbox:BOOKINGS,folder,...(folder==='2'?{state:'sent'}:{})}).select(noFiles).sort({time:-1,_id:-1}).skip(start-1).limit(50).lean(),
 get:async(folder,id,files=false)=>Message.findOne({_id:id,mailbox:BOOKINGS,folder}).select(files?'+attachments.data':noFiles).lean(),
 async claim(owner,requestId,hash,row){await ensureIndexes();try{return {created:true,item:await Message.create({...row,mailbox:BOOKINGS,owner,requestId,hash,folder:'4',state:'pending'})};}catch(error){if(error.code!==11000)throw error;return {created:false,item:await Message.findOne({owner,requestId,mailbox:BOOKINGS})};}},
 finish:(owner,requestId,values)=>Message.updateOne({owner,requestId,mailbox:BOOKINGS},{$set:values}),
 move:(id,folder)=>Message.findOneAndUpdate({_id:id,mailbox:BOOKINGS},{$set:{folder}},{new:true}),
};
const email=z.string().trim().email().max(254).refine(value=>!/[\r\n]/.test(value));
const draftSchema=z.object({requestId:z.string().uuid(),to:z.array(email).min(1).max(10),cc:z.array(email).max(10).default([]),subject:z.string().trim().min(1).max(250).refine(value=>!/[\r\n]/.test(value)),text:z.string().trim().min(1).max(50000),replyMessageId:z.string().regex(/^[a-f0-9]{24}$/).optional()}).strict();
const cleanHeader=value=>String(value||'').replace(/[\r\n]/g,' ').slice(0,2000);
const summary=row=>({id:String(row._id),folderId:row.folder,subject:row.subject||'(No subject)',from:row.from,to:(row.to||[]).join(', '),sender:row.sender||row.from,summary:String(row.text||'').slice(0,180),time:new Date(row.time).getTime(),attachments:Boolean(row.attachments?.length),state:row.state});
function createCloudflareMail({env=process.env,fetchImpl=fetch,store=mongoStore,clock=Date.now,parser=simpleParser}={}){
 const incoming=()=>env.DOMAIN_MAIL_RECEIVING_ACTIVE==='true'&&/^[a-f0-9]{64}$/i.test(env.MAIL_INGRESS_SECRET||'');
 return {
  status(){return {provider:'Cloudflare + Brevo',mailbox:BOOKINGS,configured:incoming(),setupUrl:'https://dash.cloudflare.com/',sendingConfigured:env.DOMAIN_MAIL_SENDING_ACTIVE==='true'&&Boolean(env.BREVO_API_KEY),active:env.DOMAIN_EMAIL_ACTIVE==='true',automation:{address:NOREPLY,configured:env.DOMAIN_EMAIL_ACTIVE==='true'&&Boolean(env.BREVO_API_KEY)}};},
  async folders(){return [{id:'1',name:'Inbox',type:'Inbox'},{id:'2',name:'Sent',type:'Sent'},{id:'4',name:'Unconfirmed',type:'Unconfirmed'},{id:'3',name:'Trash',type:'Trash'}];},
  async messages(folder,start=1){if(!['1','2','3','4'].includes(folder))throw fail(400,'Invalid mail folder.');return (await store.list(folder,start)).map(summary);},
  async message(folder,id){if(!objectId(id))throw fail(400,'Invalid message.');const row=await store.get(folder,id);if(!row)throw fail(404,'Message not found.');return {...summary(row),replyTo:row.replyTo||row.from,text:row.text||'',attachments:(row.attachments||[]).map(file=>({id:String(file._id),name:file.name,size:file.size}))};},
  async attachment(folder,id,attachmentId){if(!objectId(id)||!objectId(attachmentId))throw fail(400,'Invalid attachment.');const row=await store.get(folder,id,true),file=row?.attachments?.find(item=>String(item._id)===attachmentId);if(!file)throw fail(404,'Attachment not found.');return {name:file.name,data:Buffer.isBuffer(file.data)?file.data:Buffer.from(file.data.value?.()||file.data.buffer||file.data)};},
  async move(id,folder){if(!objectId(id)||!['1','2','3','4'].includes(folder))throw fail(400,'Invalid message or destination.');const row=await store.move(id,folder);if(!row)throw fail(404,'Message not found.');return {confirmed:true};},
  async receive(raw,headers){
   if(!Buffer.isBuffer(raw)||!raw.length||raw.length>MAX_EMAIL_BYTES)throw fail(413,'Message must be smaller than 5 MB.');
   if(!/^[a-f0-9]{64}$/i.test(env.MAIL_INGRESS_SECRET||''))throw fail(503,'Mail receiving is not configured.');
   const timestamp=String(headers['x-echo-mail-timestamp']||''),to=String(headers['x-echo-mail-to']||'').toLowerCase(),from=String(headers['x-echo-mail-from']||'');
   if(!/^\d{13}$/.test(timestamp)||Math.abs(clock()-Number(timestamp))>300000||to!==BOOKINGS||/[\r\n]/.test(from))throw fail(401,'Invalid mail delivery.');
   const digest=crypto.createHash('sha256').update(raw).digest('hex');
   const expected=crypto.createHmac('sha256',Buffer.from(env.MAIL_INGRESS_SECRET,'hex')).update(`${timestamp}\n${to}\n${from}\n${digest}`).digest();
   const signature=String(headers['x-echo-mail-signature']||'');
   if(!/^[a-f0-9]{64}$/i.test(signature)||!crypto.timingSafeEqual(expected,Buffer.from(signature,'hex')))throw fail(401,'Invalid mail delivery.');
   const parsed=await parser(raw,{skipImageLinks:true,skipTextToHtml:true,skipHtmlToText:true});
   const headerFrom=parsed.from?.value?.[0];
   const text=String(parsed.text||textFromHtml(parsed.html)||'').slice(0,1000000);
   const attachments=(parsed.attachments||[]).filter(file=>file.contentDisposition!=='inline').map(file=>({name:cleanHeader(file.filename||'attachment'),data:Buffer.from(file.content),size:file.size||file.content.length}));
   return store.receive({mailbox:BOOKINGS,folder:'1',state:'received',deliveryKey:crypto.createHash('sha256').update(`${BOOKINGS}\n${from}\n${digest}`).digest('hex'),from:headerFrom?.address||from,sender:headerFrom?.name||headerFrom?.address||from,to:(parsed.to?.value||[{address:BOOKINGS}]).map(item=>item.address),cc:(parsed.cc?.value||[]).map(item=>item.address),replyTo:parsed.replyTo?.value?.[0]?.address||headerFrom?.address||from,subject:cleanHeader(parsed.subject).slice(0,250),text,rfcMessageId:cleanHeader(parsed.messageId),references:cleanHeader(Array.isArray(parsed.references)?parsed.references.join(' '):parsed.references),attachments,bytes:raw.length,time:new Date(clock())});
  },
  async send(owner,value){
   if(env.DOMAIN_MAIL_SENDING_ACTIVE!=='true'||!env.BREVO_API_KEY?.trim())throw fail(503,'The bookings sender has not been verified yet. Complete email setup before sending.');
   const result=draftSchema.safeParse(value);if(!result.success)throw fail(400,'Enter valid recipients, a subject, and a message.');
   const {requestId,...draft}=result.data;
   let original;if(draft.replyMessageId){for(const folder of ['1','2','3','4']){original=await store.get(folder,draft.replyMessageId);if(original)break;}if(!original)throw fail(404,'The message being replied to was not found.');}
   const hash=crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
   const claim=await store.claim(owner,requestId,hash,{from:BOOKINGS,sender:'Echo Bookings',to:draft.to,cc:draft.cc,replyTo:BOOKINGS,subject:draft.subject,text:draft.text,time:new Date(clock())});
   if(!claim.created){if(claim.item.hash!==hash)throw fail(409,'This request already belongs to a different message.');if(claim.item.state==='sent')return {sent:true,messageId:String(claim.item._id)};throw fail(409,'This message was already submitted. Check Sent and Unconfirmed before sending another copy.');}
   try{
    const headers={idempotencyKey:requestId,...(original?.rfcMessageId?{'In-Reply-To':original.rfcMessageId,References:cleanHeader(`${original.references||''} ${original.rfcMessageId}`)}:{})};
    const response=await fetchImpl('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':env.BREVO_API_KEY,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({sender:{email:BOOKINGS,name:'Echo Bookings'},to:draft.to.map(email=>({email})),...(draft.cc.length?{cc:draft.cc.map(email=>({email}))}:{}),replyTo:{email:BOOKINGS},subject:draft.subject,textContent:draft.text,htmlContent:`<div style="white-space:pre-wrap">${draft.text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}</div>`,headers,tags:['bookings-mailbox']}),signal:AbortSignal.timeout(20000),redirect:'error'});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||!payload.messageId)throw fail(response.status===429?429:502,'The provider did not confirm sending. Check Sent and Unconfirmed before trying again.');
    await store.finish(owner,requestId,{state:'sent',folder:'2',providerMessageId:payload.messageId,rfcMessageId:cleanHeader(payload.messageId)});return {sent:true,messageId:String(claim.item._id)};
   }catch(error){await store.finish(owner,requestId,{state:'uncertain',folder:'4'}).catch(()=>{});throw fail(error.status||502,error.status?error.message:'Sending was not confirmed. Check Sent and Unconfirmed before trying again.');}
  },
 };
}
function registerMailIngress(app,{service=createCloudflareMail()}={}){
 app.post('/api/mail/inbound',(req,res,next)=>{if(!/^[a-f0-9]{64}$/i.test(req.get('x-echo-mail-signature')||''))return res.status(401).json({message:'Invalid mail delivery.'});next();},express.raw({type:'message/rfc822',limit:MAX_EMAIL_BYTES,inflate:false}),async(req,res)=>res.set('Cache-Control','no-store').json(await service.receive(req.body,req.headers)));
}
module.exports={createCloudflareMail,registerMailIngress,MAX_EMAIL_BYTES,MAX_STORAGE_BYTES};
