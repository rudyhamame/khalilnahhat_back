const crypto = require('node:crypto');
const mongoose = require('mongoose');
const cheerio = require('cheerio');
const {z} = require('zod');

const BOOKINGS = 'bookings@djkhalilnahhat.ca';
const NOREPLY = 'noreply@djkhalilnahhat.ca';
const REGIONS = {
  us:['https://accounts.zoho.com','https://mail.zoho.com'],
  eu:['https://accounts.zoho.eu','https://mail.zoho.eu'],
  in:['https://accounts.zoho.in','https://mail.zoho.in'],
  ca:['https://accounts.zohocloud.ca','https://mail.zohocloud.ca'],
};
const failure = (status,message) => Object.assign(new Error(message),{status});
const id = value => z.string().regex(/^\d{1,30}$/).parse(value);
const email = z.string().trim().email().max(254).refine(value=>!/[\r\n]/.test(value));
const sendSchema = z.object({
  requestId:z.string().uuid(), to:z.array(email).min(1).max(10), cc:z.array(email).max(10).default([]),
  subject:z.string().trim().min(1).max(250).refine(value=>!/[\r\n]/.test(value)),
  text:z.string().trim().min(1).max(50000), replyMessageId:z.string().regex(/^\d{1,30}$/).optional(),
}).strict();
const Send = mongoose.models.DomainMailSend || mongoose.model('DomainMailSend', new mongoose.Schema({
  owner:{type:String,required:true}, requestId:{type:String,required:true}, hash:String,
  state:{type:String,enum:['pending','sent','failed','uncertain'],default:'pending'}, messageId:String,
},{timestamps:true}).index({owner:1,requestId:1},{unique:true}));
const sendStore = {
  async claim(owner,requestId,hash){
    try{return {created:true,item:await Send.create({owner,requestId,hash})};}
    catch(error){if(error.code!==11000)throw error;return {created:false,item:await Send.findOne({owner,requestId})};}
  },
  finish:(owner,requestId,values)=>Send.updateOne({owner,requestId},{$set:values}),
};
function textFromHtml(value){
  const $=cheerio.load(String(value||''));
  $('script,style,iframe,object,svg,head').remove();
  $('a[href]').each((_index,element)=>{const link=$(element),href=link.attr('href')||'';if(/^(https?:|mailto:)/i.test(href)&&link.text().trim()!==href)link.append(` (${href})`);});
  $('br').replaceWith('\n');$('p,div,li,tr,blockquote').append('\n');
  return $.root().text().replace(/\n[\t ]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function parseJson(text){
  return JSON.parse(text,(_key,value,context)=>typeof value==='number'&&!Number.isSafeInteger(value)&&/^\d+$/.test(context?.source||'')?context.source:value);
}
function createDomainMail({env=process.env,fetchImpl=fetch,store=sendStore,clock=Date.now}={}){
  let token=null,refresh=null,account=null,accountUntil=0;
  const configured=()=>Boolean(env.ZOHO_CLIENT_ID?.trim()&&env.ZOHO_CLIENT_SECRET?.trim()&&env.ZOHO_REFRESH_TOKEN?.trim());
  function region(){const value=REGIONS[env.ZOHO_REGION||'us'];if(!value)throw failure(503,'The mailbox region is not configured correctly.');return value;}
  async function accessToken(){
    if(!configured())throw failure(503,'The bookings mailbox is not connected yet. Complete email setup before receiving or sending messages.');
    if(token?.until>clock())return token.value;
    if(!refresh)refresh=(async()=>{
      const response=await fetchImpl(`${region()[0]}/oauth/v2/token`,{method:'POST',body:new URLSearchParams({
        grant_type:'refresh_token',client_id:env.ZOHO_CLIENT_ID,client_secret:env.ZOHO_CLIENT_SECRET,refresh_token:env.ZOHO_REFRESH_TOKEN,
      }),signal:AbortSignal.timeout(15000),redirect:'error'});
      const data=await response.json();
      if(!response.ok||!data.access_token)throw failure(503,'The mailbox connection expired or was rejected. Reconnect Zoho Mail.');
      token={value:data.access_token,until:clock()+Math.max(1,Number(data.expires_in)||3600)*1000-60000};return token.value;
    })().finally(()=>{refresh=null;});
    return refresh;
  }
  async function api(path,{method='GET',body,binary=false}={}){
    const bearer=await accessToken();let response;
    try{response=await fetchImpl(`${region()[1]}/api${path}`,{method,headers:{Authorization:`Zoho-oauthtoken ${bearer}`,Accept:binary?'application/octet-stream':'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});}
    catch(error){throw failure(502,method==='POST'?'The email provider did not confirm sending. Check Sent before trying again.':'The mailbox could not be reached. Please try again.');}
    if(response.status===401){token=null;account=null;}
    if(!response.ok)throw failure(response.status===429?429:502,response.status===429?'Mailbox provider limit reached. Wait before trying again.':'The mail provider rejected the request. Check the mailbox connection and permissions.');
    if(binary){
      const limit=25*1024*1024;if(Number(response.headers.get('content-length'))>limit)throw failure(413,'This attachment is larger than 25 MB. Open it in Zoho Mail.');
      const parts=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw failure(413,'This attachment is larger than 25 MB. Open it in Zoho Mail.');parts.push(chunk);}
      return Buffer.concat(parts);
    }
    let data;try{data=parseJson(await response.text());}catch{throw failure(502,'The mail provider returned an unreadable response.');}
    if(data.status?.code>=400)throw failure(502,'The mail provider could not complete this request.');
    return data.data;
  }
  async function mailbox(){
    if(account&&accountUntil>clock())return account;
    const rows=await api('/accounts');
    const found=Array.isArray(rows)&&rows.find(row=>row.type==='ZOHO_ACCOUNT'&&row.emailAddress?.some(address=>String(address.mailId).toLowerCase()===BOOKINGS&&address.isConfirmed!==false));
    if(!found||found.incomingBlocked||found.outgoingBlocked||found.enabled===false||!found.mxStatus)throw failure(503,'Verify the bookings mailbox and its MX records in Zoho Mail before using Email.');
    account={id:id(String(found.accountId))};accountUntil=clock()+60000;return account;
  }
  const folderPath=async folderId=>`/accounts/${(await mailbox()).id}/folders/${id(folderId)}`;
  return {
    status(){return {mailbox:BOOKINGS,provider:'Zoho Mail',configured:configured(),automation:{address:NOREPLY,configured:Boolean(env.DOMAIN_EMAIL_ACTIVE==='true'&&env.BREVO_API_KEY?.trim())},active:env.DOMAIN_EMAIL_ACTIVE==='true',webmail:region()[1]};},
    async folders(){const rows=await api(`/accounts/${(await mailbox()).id}/folders`);if(!Array.isArray(rows))throw failure(502,'Mailbox folders could not be read.');return rows.map(row=>({id:id(String(row.folderId)),name:String(row.folderName||''),type:String(row.folderType||'')}));},
    async messages(folderId,start=1){const {id:accountId}=await mailbox();const rows=await api(`/accounts/${accountId}/messages/view?${new URLSearchParams({folderId:id(folderId),start:String(start),limit:'50',includeto:'true',sortorder:'false'})}`);if(!Array.isArray(rows))throw failure(502,'Mailbox messages could not be read.');return rows.map(row=>({id:id(String(row.messageId)),folderId:id(String(row.folderId)),subject:String(row.subject||'(No subject)'),from:String(row.fromAddress||''),to:String(row.toAddress||''),sender:String(row.sender||''),summary:textFromHtml(row.summary),time:Number(row.receivedTime||row.sentDateInGMT)||0,attachments:String(row.hasAttachment)==='1'}));},
    async message(folderId,messageId){const base=`${await folderPath(folderId)}/messages/${id(messageId)}`;const [content,details,files]=await Promise.all([api(`${base}/content`),api(`${base}/details`),api(`${base}/attachmentinfo`)]);return {id:messageId,folderId,subject:String(details?.subject||'(No subject)'),from:String(details?.fromAddress||''),to:String(details?.toAddress||''),replyTo:String(details?.replyTo||details?.fromAddress||''),text:textFromHtml(content?.content),attachments:(files?.attachments||[]).map(file=>({id:id(String(file.attachmentId)),name:String(file.attachmentName||'attachment'),size:Number(file.attachmentSize)||0}))};},
    async attachment(folderId,messageId,attachmentId){const base=`${await folderPath(folderId)}/messages/${id(messageId)}`;const files=await api(`${base}/attachmentinfo`);const file=files?.attachments?.find(item=>String(item.attachmentId)===id(attachmentId));if(!file)throw failure(404,'Attachment not found.');return {name:String(file.attachmentName||'attachment').replace(/[\r\n]/g,''),data:await api(`${base}/attachments/${id(attachmentId)}`,{binary:true})};},
    async send(owner,value){
      const parsed=sendSchema.safeParse(value);if(!parsed.success)throw failure(400,'Enter valid recipients, a subject, and a message.');
      const {requestId,...draft}=parsed.data;const {id:accountId}=await mailbox();
      const hash=crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
      const claim=await store.claim(owner,requestId,hash);
      if(!claim.created){if(claim.item.hash!==hash)throw failure(409,'This send request already belongs to a different message.');if(claim.item.state==='sent')return {sent:true,messageId:claim.item.messageId};throw failure(409,'This message was already submitted. Check Sent before creating another send request.');}
      try{
        const response=await api(`/accounts/${accountId}/messages${draft.replyMessageId?`/${draft.replyMessageId}`:''}`,{method:'POST',body:{fromAddress:BOOKINGS,toAddress:draft.to.join(','),...(draft.cc.length?{ccAddress:draft.cc.join(',')}:{}),subject:draft.subject,content:draft.text,mailFormat:'plaintext',encoding:'UTF-8',...(draft.replyMessageId?{action:'reply'}:{})}});
        if(!response?.messageId)throw failure(502,'Sending was not confirmed. Check Sent before trying again.');
        const messageId=id(String(response.messageId));await store.finish(owner,requestId,{state:'sent',messageId});return {sent:true,messageId};
      }catch(error){await store.finish(owner,requestId,{state:'uncertain'}).catch(()=>{});throw error;}
    },
  };
}
function registerDomainMail(app,{requireAdmin,service=createDomainMail()}={}){
  app.use('/api/admin/mail',requireAdmin,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/api/admin/mail/status',(_req,res)=>res.json(service.status()));
  app.get('/api/admin/mail/folders',async(_req,res)=>res.json({items:await service.folders()}));
  app.get('/api/admin/mail/messages',async(req,res)=>{const parsed=z.object({folderId:z.string().regex(/^\d{1,30}$/),start:z.coerce.number().int().min(1).max(100000).default(1)}).safeParse(req.query);if(!parsed.success)throw failure(400,'Choose a valid mail folder and page.');res.json({items:await service.messages(parsed.data.folderId,parsed.data.start)});});
  app.get('/api/admin/mail/folders/:folderId/messages/:messageId',async(req,res)=>{if(!/^\d{1,30}$/.test(req.params.folderId)||!/^\d{1,30}$/.test(req.params.messageId))throw failure(400,'Invalid message.');res.json({item:await service.message(req.params.folderId,req.params.messageId)});});
  app.get('/api/admin/mail/folders/:folderId/messages/:messageId/attachments/:attachmentId',async(req,res)=>{if(!Object.values(req.params).every(value=>/^\d{1,30}$/.test(value)))throw failure(400,'Invalid attachment.');const file=await service.attachment(req.params.folderId,req.params.messageId,req.params.attachmentId);res.set({'Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name)}`}).send(file.data);});
  app.post('/api/admin/mail/send',async(req,res)=>res.json(await service.send(String(req.user._id),req.body)));
}
module.exports={BOOKINGS,NOREPLY,createDomainMail,registerDomainMail,textFromHtml,parseJson};
