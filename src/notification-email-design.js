const mongoose=require('mongoose');
const {z}=require('zod');
const {BOOKINGS}=require('./business-mail-identity');
const DEFAULT_EMAIL_DESIGN=Object.freeze({revision:0,brandName:'Echo Event Entertainment',tagline:'DJ Khalil Nahhat',photoUrl:'https://vps-ba7fb4cb.vps.ovh.ca/khalil-media/public/f222460731344bce85014b6ce0641269beff4c0f1fbcd01660cf2e37b96f95d1.png',photoAlt:'DJ Khalil Nahhat'});
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=(status,message)=>Object.assign(new Error(message),{status});
const photo=z.string().trim().min(1).max(2048).refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}},'Choose a valid HTTPS photo from the gallery.');
const designSchema=z.object({revision:z.number().int().min(0),brandName:z.string().trim().min(1).max(80),tagline:z.string().trim().max(120),photoUrl:photo,photoAlt:z.string().trim().min(1).max(160)}).strict();
function validateEmailDesign(value){const parsed=designSchema.safeParse(value);if(!parsed.success)throw fail(400,parsed.error.issues[0]?.message||'Check the email design.');return parsed.data;}
const Design=mongoose.models.NotificationEmailDesign||mongoose.model('NotificationEmailDesign',new mongoose.Schema({_id:String,revision:Number,brandName:String,tagline:String,photoUrl:String,photoAlt:String,updatedBy:String},{timestamps:true}));
const mongoStore={
 get:()=>Design.findById('primary').lean(),
 async save(value,updatedBy){
  if(value.revision===0){try{return await Design.create({_id:'primary',...value,revision:1,updatedBy});}catch(error){if(error.code===11000)return null;throw error;}}
  return Design.findOneAndUpdate({_id:'primary',revision:value.revision},{$set:{...value,revision:value.revision+1,updatedBy}},{new:true}).lean();
 },
};
const view=value=>Object.fromEntries(Object.keys(DEFAULT_EMAIL_DESIGN).map(key=>[key,value[key]??DEFAULT_EMAIL_DESIGN[key]]));
function createEmailDesign({store=mongoStore}={}){
 return {
  async get(){return view(await store.get()||DEFAULT_EMAIL_DESIGN);},
  async save(value,owner){const saved=await store.save(validateEmailDesign(value),owner);if(!saved)throw fail(409,'The shared design was changed elsewhere. Load the latest saved version before saving.');return view(saved);},
 };
}
// HTML email uses presentation tables and inline styles so the same layout works
// in Outlook, Gmail and mobile clients without scripts, web fonts or CSS images.
function renderEmailLayout({subject,contentHtml,text='',imageUrl=''},design=DEFAULT_EMAIL_DESIGN){
 const safe=validateEmailDesign(view(design));
 const legacyBody=String(contentHtml||'').match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]||contentHtml||'';
 const html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title><style>@media only screen and (max-width:480px){.email-outer{padding:16px 8px!important}.email-header{padding:22px 18px!important}.email-brand{font-size:21px!important}.email-photo-cell{width:80px!important}.email-photo{width:80px!important}.email-content{padding:26px 18px!important}.email-title{font-size:21px!important}}</style></head><body style="margin:0;padding:0;background:#f2f1ed;color:#29322e;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f1ed"><tr><td align="center" class="email-outer" style="padding:32px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e1e3dc;border-radius:12px;overflow:hidden">
<tr><td class="email-header" style="background:#192a25;border-bottom:4px solid #9ab8a2;padding:28px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="padding-right:16px"><p style="margin:0 0 14px;color:#b8cbbd;font-size:10px;line-height:1.6;letter-spacing:2px;text-transform:uppercase">Music &amp; events</p><p class="email-brand" style="margin:0;color:#ffffff;font-size:25px;font-weight:bold;line-height:1.3">${esc(safe.brandName)}</p>${safe.tagline?`<p style="margin:12px 0 0;color:#d3ddd5;font-size:13px;line-height:1.6">${esc(safe.tagline)}</p>`:''}</td><td class="email-photo-cell" width="104" valign="middle"><img class="email-photo" src="${esc(safe.photoUrl)}" alt="${esc(safe.photoAlt)}" width="104" border="0" style="display:block;width:104px;max-width:100%;height:auto;border-radius:8px;background:#243e34"></td></tr></table></td></tr>
<tr><td class="email-content" style="padding:32px 24px 36px"><h1 class="email-title" style="margin:0 0 24px;color:#23372d;font-size:23px;font-weight:bold;line-height:1.4;overflow-wrap:anywhere">${esc(subject)}</h1><div style="font-size:15px;line-height:1.8;color:#37423c;overflow-wrap:anywhere">${legacyBody}</div>${imageUrl?`<p style="margin:24px 0 0"><img src="${esc(imageUrl)}" alt="" width="240" style="display:block;width:100%;max-width:240px;height:auto;border-radius:8px"></p>`:''}</td></tr>
<tr><td style="padding:22px 24px;background:#f8f9f5;border-top:1px solid #e7e9e2"><p style="margin:0 0 7px;color:#526357;font-size:12px;font-weight:bold;line-height:1.6">${esc(safe.brandName)}</p><p style="margin:0;color:#627068;font-size:12px;line-height:1.8">Need a hand? <a href="mailto:${BOOKINGS}" style="color:#345b46;text-decoration:underline">Contact our team</a> &nbsp;·&nbsp; <a href="https://djkhalilnahhat.ca" style="color:#345b46;text-decoration:underline">Visit website</a></p><p style="margin:10px 0 0;color:#7b857d;font-size:11px;line-height:1.7">This is an automated email. Please use the contact link above for help.</p></td></tr>
</table></td></tr></table></body></html>`;
 return {subject,text,imageUrl: safe.photoUrl,html};
}
module.exports={DEFAULT_EMAIL_DESIGN,createEmailDesign,validateEmailDesign,renderEmailLayout};
