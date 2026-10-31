const mongoose = require('mongoose');
const { z } = require('zod');

const BRAND = 'Echo Event Entertainment';
const sample = { recipientName:'Alex', customerName:'Alex Morgan', customerEmail:'alex@example.com', requestId:'ECHO-1042', eventDate:'November 21, 2026', venue:'Toronto', depositAmount:'$250.00', total:'$1,000.00', details:'DJ performance × 1 — $1,000.00', adminNote:'We look forward to your event.', expiresAt:'November 14, 2026 at 5:00 p.m. Eastern', meetingTime:'November 7, 2026 at 2:00 p.m. Eastern', duration:'30 minutes', meetingLocation:'Online meeting', topic:'Event planning', actionUrl:'https://example.com/your-link', brand:BRAND };
const catalog = [
  { id:'verify-email',label:'Email verification',group:'Account',when:'When an account is created or verification is requested',recipient:'Account holder',subject:'Verify your email — {{brand}}',body:'Hello {{recipientName}},\n\nWelcome to {{brand}}. Verify your email address using this link:\n{{actionUrl}}',variables:['recipientName','actionUrl','brand'],required:['actionUrl'] },
  { id:'password-reset',label:'Password reset',group:'Account',when:'When the account holder requests a password reset',recipient:'Account holder',subject:'Reset your password — {{brand}}',body:'Hello {{recipientName}},\n\nUse this link within one hour to choose a new password:\n{{actionUrl}}\n\nIf you did not request this, ignore this email.',variables:['recipientName','actionUrl','brand'],required:['actionUrl'] },
  { id:'service-request',label:'New service request',group:'Bookings',when:'When a customer submits a service request',recipient:'Existing admin notification address',subject:'New service request from {{customerName}}',body:'New service request {{requestId}}\n\nCustomer: {{customerName}}\nEmail: {{customerEmail}}\n\n{{details}}\n\nReview the request:\n{{actionUrl}}',variables:['customerName','customerEmail','requestId','details','actionUrl','brand'],required:['requestId','details'] },
  { id:'service-quote',label:'Quote ready',group:'Bookings',when:'When the admin sends a quote',recipient:'Customer',subject:'Your {{brand}} quote is ready',body:'Hello {{customerName}},\n\nYour quote {{requestId}} is ready.\n\n{{details}}\n\nTotal: {{total}}\n{{adminNote}}\n\nReview your quote:\n{{actionUrl}}',variables:['customerName','requestId','details','total','adminNote','actionUrl','brand'],required:['requestId','details','total'] },
  { id:'quote-expiry-reminder',label:'Quote expiry reminder',group:'Bookings',when:'Before an unanswered quote expires',recipient:'Customer',leadHours:48,subject:'Your quote {{requestId}} expires soon',body:'Hello {{customerName}},\n\nQuote {{requestId}} expires on {{expiresAt}}. Sign in to review and accept it before then.\n\nA quotation does not guarantee a booking. Your date is confirmed after you accept the quote and pay the deposit.\n\n{{brand}}',variables:['customerName','requestId','expiresAt','actionUrl','brand'],required:['requestId','expiresAt'] },
  ...['booking-confirmation','booking-admin'].map(id=>({id,label:id==='booking-admin'?'Booking confirmed · admin':'Booking confirmed · customer',group:'Bookings',when:'When the deposit confirms a booking',recipient:id==='booking-admin'?'Existing admin notification address':'Customer',subject:id==='booking-admin'?'New confirmed booking {{requestId}}':'Booking confirmed {{requestId}}',body:'Hello {{recipientName}},\n\nBooking {{requestId}} is confirmed for {{eventDate}} at {{venue}}.\nCustomer: {{customerName}}\nDeposit received: {{depositAmount}}. The remaining balance is shown in the dashboard.\n\n{{brand}}',variables:['recipientName','customerName','requestId','eventDate','venue','depositAmount','brand'],required:['requestId','eventDate','depositAmount']})),
  ...['confirmed','cancelled','rescheduled'].flatMap(state=>['customer','admin'].map(audience=>({id:`meeting-${state}${audience==='admin'?'-admin':''}`,label:`Meeting ${state} · ${audience}`,group:'Meetings',when:`When a meeting is ${state}`,recipient:audience==='admin'?'Existing admin notification address':'Meeting attendee',subject:`Meeting ${state} — {{meetingTime}}`,body:`Hello {{recipientName}},\n\nThe meeting for {{customerName}} has been ${state}.\n\n{{meetingTime}}\nDuration: {{duration}}\n{{meetingLocation}}\nTopic: {{topic}}\n\n{{brand}}`,variables:['recipientName','customerName','meetingTime','duration','meetingLocation','topic','brand'],required:['meetingTime']}))),
  {id:'meeting-reminder',label:'Meeting reminder',group:'Meetings',when:'Before a booked meeting starts',recipient:'Meeting attendee',leadHours:24,subject:'Meeting reminder — {{meetingTime}}',body:'Hello {{recipientName}},\n\nYour meeting is {{meetingTime}}.\nDuration: {{duration}}\n{{meetingLocation}}\n\n{{brand}}',variables:['recipientName','meetingTime','duration','meetingLocation','brand'],required:['meetingTime']},
];
const EmailRule = mongoose.models.NotificationEmailRule || mongoose.model('NotificationEmailRule',new mongoose.Schema({ _id:String,revision:{type:Number,default:1},enabled:Boolean,subject:String,body:String,leadHours:{type:Number,default:null},updatedBy:String },{timestamps:true}));
const mongoStore = {
  list:()=>EmailRule.find().lean(),
  get:id=>EmailRule.findById(id).lean(),
  async save(id,value,updatedBy) {
    if(value.revision===0){try{return await EmailRule.create({_id:id,...value,revision:1,updatedBy});}catch(error){if(error.code===11000)return null;throw error;}}
    return EmailRule.findOneAndUpdate({_id:id,revision:value.revision},{$set:{...value,revision:value.revision+1,updatedBy}},{new:true}).lean();
  },
};
const escapeHtml = value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const interpolate=(template,context)=>template.replace(/\{\{\s*(\w+)\s*\}\}/g,(_,key)=>String(context[key]??''));
const fail=(status,message)=>Object.assign(new Error(message),{status});
function definition(id){const item=catalog.find(item=>item.id===id);if(!item)throw fail(404,'Email notification not found.');return item;}
function validate(id,value){
 const event=definition(id);
 const parsed=z.object({revision:z.number().int().min(0),enabled:z.boolean(),subject:z.string().trim().min(1).max(200).refine(v=>!/[\r\n]/.test(v),'Use a single-line subject.'),body:z.string().trim().min(1).max(12000),leadHours:z.number().finite().min(.25).max(720).nullable()}).strict().safeParse(value);
 if(!parsed.success)throw fail(400,parsed.error.issues[0]?.message||'Check the email settings.');
 const rule=parsed.data;
 if((event.leadHours==null)!==(rule.leadHours==null))throw fail(400,'Only reminder emails have a lead time.');
 const tokens=[...`${rule.subject}\n${rule.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(match=>match[1]);
 const unknown=tokens.find(key=>!event.variables.includes(key));if(unknown)throw fail(400,`Unknown variable: {{${unknown}}}.`);
 if(/\{\{|\}\}/.test(`${rule.subject}\n${rule.body}`.replace(/\{\{\s*\w+\s*\}\}/g,'')))throw fail(400,'Use variables in the form {{variableName}}.');
 for(const key of event.required)if(!new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`).test(rule.body))throw fail(400,`Keep {{${key}}} in the message so the email includes its essential details.`);
 return rule;
}
function render(rule,context={}){
 const values={brand:BRAND,...context};
 const subject=interpolate(rule.subject,values).replace(/[\r\n]+/g,' ').slice(0,300);
 const text=interpolate(rule.body,values);
 return {subject,text,html:`<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:Arial,sans-serif;color:#202124"><div style="max-width:640px;margin:auto;padding:32px 24px"><p style="font-size:12px;color:#68716e">${BRAND}</p><div style="white-space:pre-wrap;line-height:1.7">${escapeHtml(text).replace(/https?:\/\/[^\s<>]+/g,url=>`<a href="${url}">${url}</a>`)}</div></div></body></html>`};
}
function createNotificationEmails({store=mongoStore}={}){
 const merged=(event,saved)=>({...event,enabled:true,revision:0,leadHours:event.leadHours??null,...(saved?{enabled:saved.enabled,revision:saved.revision,subject:saved.subject,body:saved.body,leadHours:saved.leadHours??null}:{}),customized:Boolean(saved),sample});
 return {
  async list(){const rows=await store.list();return catalog.map(event=>merged(event,rows.find(row=>String(row._id)===event.id)));},
  async get(id){return merged(definition(id),await store.get(id));},
  async save(id,value,owner){const rule=validate(id,value);const saved=await store.save(id,rule,owner);if(!saved)throw fail(409,'This email was changed elsewhere. Reload before saving.');return merged(definition(id),saved);},
  preview(id,value){return render(validate(id,value),sample);},
  async apply(payload){
   const {notificationContext,...email}=payload;
   const event=catalog.find(event=>email.tags?.includes(event.id));if(!event)return email;
   const saved=await store.get(event.id);if(!saved)return email;
   if(!saved.enabled)return null;
   const message=render(saved,{recipientName:email.to?.[0]?.name||'there',...notificationContext});
   return {...email,subject:message.subject,htmlContent:message.html,textContent:message.text};
  },
 };
}
const notificationEmails=createNotificationEmails();
function registerNotificationEmails(app,{requireAdmin,service=notificationEmails,env=process.env}){
 app.get('/api/admin/notifications/emails',requireAdmin,async(_req,res)=>res.set('Cache-Control','no-store').json({items:await service.list(),provider:{name:'Brevo',configured:Boolean(env.BREVO_API_KEY?.trim()&&env.EMAIL_FROM_ADDRESS?.trim()),senderEmail:env.EMAIL_FROM_ADDRESS||'',senderName:env.EMAIL_FROM_NAME||'Khalil Nahhat Website'}}));
 app.put('/api/admin/notifications/emails/:id',requireAdmin,async(req,res)=>res.json({item:await service.save(req.params.id,req.body,String(req.user._id))}));
 app.post('/api/admin/notifications/emails/:id/preview',requireAdmin,(req,res)=>res.json(service.preview(req.params.id,req.body)));
}
module.exports={catalog,validate,render,createNotificationEmails,notificationEmails,registerNotificationEmails};
