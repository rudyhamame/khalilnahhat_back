import {validFavouriteSongs} from './favouriteSongs.mjs';
import contract from './eventOrderContract.json' with { type: 'json' };
export { contract };
export const fields = contract.sections.flatMap(section => section.fields.map(field => ({ ...field, gate: field.gate ?? section.gate })));
const planningNames={brideName:['Bride','العروس'],groomName:['Groom','العريس'],timeline:['Timeline','الجدول الزمني'],partyEntrances:['Party entrances','دخول المدعوين'],entranceSongs:['Entrance songs','أغاني الدخول'],firstDance:['First dance','الرقصة الأولى'],parentDances:['Parent dances','رقصات الأهل'],dinnerMusic:['Dinner music','موسيقى العشاء'],cakeCutting:['Cake cutting','تقطيع الكعكة'],announcements:['Announcements','الإعلانات'],mustPlay:['Must play','أغانٍ مطلوبة'],doNotPlay:['Do not play','أغانٍ ممنوعة'],specialRequests:['Special requests','طلبات خاصة']};
// The after-confirmation planning worksheet is filled by the client in the dashboard only: the booking conversation (text or voice) can read it but never creates these atoms.
const planningFields=Object.entries(planningNames).map(([key,[short,shortAr]])=>({key:'planning.'+key,label:key,short,shortAr,type:'textarea',manualOnly:true}));
planningFields.push({key:'planning.musicUploads',label:'Planning music references',short:'Music references',shortAr:'مراجع موسيقية',type:'links',manualOnly:true});
// Admin-editable rules (required, max length, allowed values) laid over the contract in place. The contract's own values are remembered, so removing a rule restores them.
const contractRules=new WeakMap();
const baseOf=field=>contractRules.get(field)||contractRules.set(field,{required:field.required,maxLength:field.maxLength,options:field.options}).get(field);
const setOrDrop=(field,name,value)=>{if(value===undefined)delete field[name];else field[name]=value;};
export function applyBookingRules(rules){
  for(const field of fields){
    const base=baseOf(field),rule=rules?.[field.key]||{};
    setOrDrop(field,'required',rule.required??base.required);setOrDrop(field,'requiredOverride',rule.required);setOrDrop(field,'maxLength',rule.maxLength??base.maxLength);setOrDrop(field,'options',rule.options??base.options);
  }
}
// Returns the rules worth keeping (only what differs from the contract) or throws a readable message.
export function cleanBookingRules(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Rules must be an object.');
  const out={};
  for(const [key,rule] of Object.entries(input)){
    const field=fields.find(item=>item.key===key);if(!field)throw new Error(`Unknown atom ${key}.`);
    if(!rule||typeof rule!=='object'||Object.keys(rule).some(name=>!['required','maxLength','options'].includes(name)))throw new Error(`Invalid rule for ${key}.`);
    const base=baseOf(field),clean={};
    if(rule.required!==undefined){if(typeof rule.required!=='boolean')throw new Error(`${key}: required must be true or false.`);if(rule.required!==Boolean(base.required)||key==='event.title')clean.required=rule.required;}
    if(rule.maxLength!==undefined){if(!base.maxLength||!Number.isInteger(rule.maxLength)||rule.maxLength<1||rule.maxLength>3000)throw new Error(`${key}: max length must be a whole number from 1 to 3000.`);if(rule.maxLength!==base.maxLength)clean.maxLength=rule.maxLength;}
    if(rule.options!==undefined){if(!base.options||!Array.isArray(rule.options)||!rule.options.length||rule.options.some(value=>!base.options.includes(value)))throw new Error(`${key}: choose at least one of its existing values.`);const kept=base.options.filter(value=>rule.options.includes(value));if(kept.length!==base.options.length)clean.options=kept;}
    if(Object.keys(clean).length)out[key]=clean;
  }
  return out;
}
export const aiFields = [...fields,...planningFields,{key:'equipment',label:'Equipment and complete sets',short:'Equipment',shortAr:'المعدات',type:'equipment'}];
// The short name people see in summaries, reviews and task lists (the long `label` is the form prompt). One place, both languages.
// The shown name of one option of a field (for example the "phone" contact method), from the same contract.
export const optionName=(key,option,ar=false)=>{const names=aiFields.find(item=>item.key===key)?.optionNames?.[option];return names?names[ar?1:0]:String(option??'');};
export const fieldName=(key,ar=false)=>{const field=aiFields.find(item=>item.key===key);return field?(ar?field.shortAr:field.short)||field.label:'';};
// An equipment list from a model may repeat an item or give a quantity as text ("2"): merge repeats (the last wins) and read whole-number text, so one slip does not reject the whole selection.
function tidyEquipment(list){
 if(!Array.isArray(list))return list;
 const merged=new Map();
 for(const row of list){if(!row||typeof row!=='object'){return list;}const quantity=typeof row.quantity==='string'&&/^\d+$/.test(row.quantity.trim())?Number(row.quantity):row.quantity;merged.set(row.id,{...row,quantity});}
 return [...merged.values()];
}
// A reply is only an acknowledgement; draft mutations require an exact saved patch.
export function claimsDraftChange(reply){
 if(typeof reply!=='string')return false;
 const text=reply.replace(/\b(?:nothing|no (?:draft )?(?:changes?|links?|updates?))\s+(?:was|were|has been|have been)\s+(?:successfully\s+)?(?:added|saved|updated|changed|recorded|included|queued|stored)\b/giu,'').replace(/لم\s+(?:يتم|تتم)\s+(?:حفظ|إضافة|تحديث|تغيير)/gu,'');
 return /\bI(?:['’]ve| have)?\s+(?:added|queued|proposed|prepared|updated|set|selected|saved|changed|included)\b/iu.test(text)||
 /\b(?:has|have|is|are|was|were)\s+(?:(?:now|already|successfully)\s+)*(?:been\s+)?(?:(?:now|already|successfully)\s+)*(?:added|saved|updated|changed|recorded|included|queued|stored)\b/iu.test(text)||
 /\b(?:quantity|qty)\b[^.]{0,40}\b(?:set|updated|changed)\b|\b(?:set|updated|changed) to \d+/iu.test(text)||
 /^\s*(?:added|queued|proposed|updated|selected|saved)\b/iu.test(text)||/(?:أضفت|اقترحت|جهزت|تمت إضافة|تم تحديث|تم حفظ|أُضيف|تمت إضاف)/u.test(text);
}

// Extract metadata only: opening an external URL is never needed to save a reference.
export function referenceLinkRequest(order,message,{context=''}={}){
 const text=String(message||'').replace(/\\([:./?=&_-])/g,'$1');
 const links=[...new Set((text.match(/https?:\/\/[^\s<>]+/giu)||[]).map(value=>value.replace(/[),.;!?]+$/u,'')))];
 const wantsLink=/\b(?:add|attach|include|share|send|paste)\b.{0,50}\b(?:a |an |some |another )?links?\b|(?:أضيف|اضيف|إضافة|اضافة|ارفق|أرفق).{0,30}رابط/iu.test(text);
 if(!links.length)return wantsLink?{kind:'ask',links:[]}:null;
 const safe=links.filter(link=>safeLink(link));
 if(safe.length!==links.length)return {kind:'unsafe',links};
 const inspiration=/\b(?:inspiration|pinterest|reference (?:photo|image|links?)|photo links?)\b|صور.{0,12}(?:ملهم|إلهام)|روابط صور/iu.test(text+' '+context);
 const images=safe.filter(link=>{const host=new URL(link).hostname.toLowerCase();return inspiration||host==='pin.it'||host==='pinterest.com'||host.endsWith('.pinterest.com')||host==='pinterest.ca'||host.endsWith('.pinterest.ca');});
 if(!images.length){
  if(/\b(?:songs?|music|playlist|first dance|entrance|documents?|run[- ]of[- ]show)\b|أغني|أغاني|موسيقى|مستند/iu.test(text+' '+context))return null;
  return {kind:'clarify',links:safe};
 }
 const current=order?.references?.images||[],value=[...new Set([...current,...images])];
 const patch=images.some(link=>!current.includes(link))?[{path:'references.images',value}]:[];
 return {kind:'images',links:images,patch,pending:safe.filter(link=>!images.includes(link))};
}

export function decodePatchValue(field,value){
 if(typeof value==='string'&&(value==='null'||['number','coordinate','boolean','multi','links','songs','tags','pairs','attachments','equipment'].includes(field.type))){try{const parsed=JSON.parse(value);return field.type==='equipment'?tidyEquipment(parsed):parsed;}catch{return undefined;}}
 return field.type==='equipment'?tidyEquipment(value):value;
}
export const getPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function put(object, path, value) {
  const keys=path.split('.'); let target=object;
  for(const key of keys.slice(0,-1))target=target[key] ||= {};
  target[keys.at(-1)]=value;
}
export const isAnswered = value => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
// Account contact prefills and an automatically offered voucher do not mean
// the visitor has started planning an event.
export function hasEventDraftContent(order) {
  return aiFields.some(field=>{
    if(field.key.startsWith('customer.')||['additional.voucherCode','event.venue.country','event.venue.source','event.venue.sourceId','event.venue.sourceAttribution'].includes(field.key)||field.type==='coordinate')return false;
    const value=getPath(order,field.key);
    return typeof value==='string'?value.trim().length>0:isAnswered(value)&&value!==false;
  });
}
export function createEventOrder() {
  const order={schemaVersion:contract.version,source:'manual',accountDetailsImported:false};
  for(const field of fields)put(order,field.key,['multi','links','songs','tags','pairs','attachments'].includes(field.type)?[]:null);
  order.event.timezone=contract.timezone;
  order.equipment=[];
  // This belongs to the confirmed-booking workflow, not the quote questionnaire.
  order.planning={phase:'after_confirmation',brideName:null,groomName:null,timeline:null,partyEntrances:null,entranceSongs:null,firstDance:null,parentDances:null,dinnerMusic:null,cakeCutting:null,announcements:null,mustPlay:null,doNotPlay:null,musicUploads:[],specialRequests:null};
  return order;
}
// The most a client may attach to one booking: 10 inspiration photos and 5 event documents.
const ATTACHMENT_LIMITS={'references.photos':10,'references.files':5};
export function validValue(field, value) {
  if(field.key==='music.favouriteSongs')return validFavouriteSongs(value);
  if(field.type==='equipment')return Array.isArray(value)&&value.length<=100&&new Set(value.map(item=>item?.id)).size===value.length&&value.every(item=>item&&typeof item.id==='string'&&/^[a-z0-9-]+$/.test(item.id)&&item.id.length<=160&&Number.isSafeInteger(item.quantity)&&item.quantity>0&&item.quantity<=10000);
  // Ordered suggested songs: [{phase,song}], e.g. an intro song, then an outro song.
  if(field.type==='songs')return Array.isArray(value)&&value.length<=30&&value.every(item=>item&&typeof item==='object'&&typeof item.song==='string'&&item.song.trim().length>0&&item.song.length<=200&&typeof item.phase==='string'&&item.phase.length<=80&&(item.artist===undefined||(typeof item.artist==='string'&&item.artist.length<=200))&&(item.link===undefined||(typeof item.link==='string'&&item.link.length<=2048&&/^https:\/\/\S+$/i.test(item.link)))&&(!field.phases||item.phase===''||field.phases.includes(item.phase)));
  // Lists chosen from the Work Elements (genres) are free text names; language pairs are {language, dialect}.
  if(field.type==='attachments')return Array.isArray(value)&&value.length<=(ATTACHMENT_LIMITS[field.key]||12)&&value.every(item=>item&&typeof item==='object'&&typeof item.url==='string'&&item.url.length<=2048&&(/^pending:[a-f0-9]{64}$/.test(item.url)||(/^https:\/\//i.test(item.url)&&safeLink(item.url)&&trustedFileUrl(item.url)))&&typeof item.name==='string'&&item.name.length>0&&item.name.length<=160&&(item.comment===undefined||(typeof item.comment==='string'&&item.comment.length<=500))&&(item.sha256===undefined||(typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256))));
  if(field.type==='tags')return Array.isArray(value)&&value.length<=40&&value.every(item=>typeof item==='string'&&item.trim().length>0&&item.length<=80);
  if(field.type==='pairs')return Array.isArray(value)&&value.length<=40&&value.every(item=>item&&typeof item==='object'&&typeof item.language==='string'&&item.language.trim().length>0&&item.language.length<=80&&typeof item.dialect==='string'&&item.dialect.length<=80);
  if(value===null)return !['multi','links','songs','tags','pairs','attachments'].includes(field.type);
  if(field.type==='coordinate')return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=field.max;
  if(field.type==='number')return typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=(field.max||100000);
  if(field.type==='boolean')return typeof value==='boolean';
  if(['multi','links'].includes(field.type))return Array.isArray(value)&&value.length<=30&&value.every(item=>typeof item==='string'&&item.length<=2048&&(field.options?field.options.includes(item):/^https:\/\//i.test(item)&&safeLink(item)));
  if(typeof value!=='string'||value.length>(field.maxLength||(field.type==='textarea'?3000:320)))return false;
  if(field.options&&!field.options.includes(value))return false;
  if(field.type==='date')return /^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
  if(field.type==='time')return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if(field.type==='email')return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return true;
}
// Uploaded references live on Cloudinary or, with MEDIA_STORAGE_PROVIDER=vps, on the media host under /khalil-media/.
function trustedFileUrl(value){const u=new URL(value);return u.hostname==='res.cloudinary.com'||(u.hostname==='vps-ba7fb4cb.vps.ovh.ca'&&u.pathname.startsWith('/khalil-media/'));}
function safeLink(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!!u.hostname;}catch{return false;}}
// Text and voice use additive language edits unless the client explicitly replaces or removes them.
export function preserveMusicLanguages(order,patch,message=''){
 const paths=['music.languagePairs'];
 const names=[...(order.music?.languagePairs||[]).map(row=>row.language),...patch.filter(row=>paths.includes(row.path)).flatMap(row=>{const field=aiFields.find(field=>field.key===row.path),value=field?decodePatchValue(field,row.value):null;return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item.language):[];})].filter(value=>typeof value==='string'&&value.trim());
 const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const terms=['languages?','dialects?',...names.map(escape)].join('|');
 const replace=new RegExp(String.raw`\b(?:replace|reset|clear)\b.{0,40}\b(?:${terms})\b|\b(?:remove|drop|only|instead of|switch to|change to)\s+(?:${terms})\b|\b(?:${terms})\b.{0,25}\b(?:only|instead)\b`,'iu').test(message)||/^\s*(?:clear|remove|reset)\s+(?:it|them|all)\b/iu.test(message)||/فقط|استبدل|احذف|امسح/u.test(message);
 if(replace)return patch;
 return patch.map(change=>{
  if(!paths.includes(change.path))return change;
  const field=aiFields.find(field=>field.key===change.path),incoming=decodePatchValue(field,change.value),previous=getPath(order,change.path)||[];
  if(!Array.isArray(incoming))return change;
  const key=value=>typeof value==='string'?value.trim().toLowerCase():`${value.language?.trim().toLowerCase()}|${value.dialect?.trim().toLowerCase()}`;
  let combined=[...previous,...incoming].filter((value,index,all)=>all.findIndex(item=>key(item)===key(value))===index);
  if(change.path==='music.languagePairs')combined=combined.filter(row=>row.dialect||!combined.some(item=>item.language.toLowerCase()===row.language.toLowerCase()&&item.dialect));
  if(!validValue(field,combined))return change;
  return {...change,value:typeof change.value==='string'?JSON.stringify(combined):combined};
 });
}
// Older saved bookings stored one name. Explicit name parts always take precedence.
export function customerNameParts(customer={}) {
 customer=customer||{};
 const [first='',...rest]=String(customer.fullName||'').trim().split(/\s+/);
 return {firstName:customer.firstName??(first||null),lastName:customer.lastName??(rest.join(' ')||null)};
}
export function normalizeEventOrder(input) {
  input={...input,customer:{...input?.customer,...customerNameParts(input?.customer)}};
  const order=createEventOrder();
  order.accountDetailsImported=input?.accountDetailsImported===true;
  for(const field of fields){const value=getPath(input,field.key);if(value!==undefined&&validValue(field,value))put(order,field.key,Array.isArray(value)?[...new Set(value)]:value);}
  for(const field of planningFields){const value=getPath(input,field.key);if(value!==undefined&&validValue(field,value))put(order,field.key,value);}
  // Special requests is no longer a data atom: what a client already wrote there becomes the Additional notes.
  const oldSpecial=getPath(input,'additional.specialRequests');
  if(typeof oldSpecial==='string'&&oldSpecial.trim()&&!order.additional.notes){const notes=oldSpecial.trim().slice(0,3000),field=fields.find(item=>item.key==='additional.notes');if(field&&validValue(field,notes))order.additional.notes=notes;}
  if(['manual','ai'].includes(input?.source))order.source=input.source;
  if(Array.isArray(input?.equipment))order.equipment=input.equipment.filter(item=>item&&typeof item.id==='string'&&item.id.length<=160&&Number.isInteger(item.quantity)&&item.quantity>0&&item.quantity<=10000).slice(0,100).map(item=>({id:item.id,name:String(item.name||'').slice(0,240),quantity:item.quantity}));
  // The explicit service decision is authoritative. Upgrade older drafts that
  // only stored services, without overriding an explicit No or losing music facts.
  for(const [id,key] of [['dj','djRequested'],['mc','mcRequested']]){
    const decision=order.music[key];
    if(typeof decision==='boolean')order.services=decision?[...new Set([...order.services,id])]:order.services.filter(value=>value!==id);
    else if(order.services.includes(id))order.music[key]=true;
  }
  return order;
}
// Contract fields marked locked:"account" belong to the signed-in account (name, email, phone, company). A booking shows them but never edits them:
// no form input, no AI patch, no stored draft can change them. Only applyAccountProfile writes them.
export const lockedFields=fields.filter(field=>field.locked==='account');
// A guest (not signed in) fills these four in themselves; once they verify their email they become the account's.
let accountLock=true;
export const setAccountLock=value=>{accountLock=Boolean(value);};
export const isLockedField=path=>accountLock&&lockedFields.some(field=>field.key===path);
export function accountProfile(user){
  if(!user)return {};
  return {
    'customer.firstName':user.firstName||null,
    'customer.lastName':user.lastName||null,
    'customer.email':user.email||null,
    'customer.phone':user.phoneNumber||user.phone||null,
    'customer.company':user.company||null,
    // WhatsApp is no longer a contact method of its own: an older "WhatsApp only" account becomes phone + WhatsApp text.
    'customer.contactMethod':user.preferredContact==='whatsapp'?'phone':['any','email','phone'].includes(user.preferredContact)?user.preferredContact:'email',
    // A signed-in client's Personal info is always complete: an account with a phone number but no phone contact choice yet (saved before the choice existed) reads as Phone call until they pick another in the dashboard.
    'customer.phoneContact':['whatsapp-text','whatsapp-call','sms','call'].includes(user.phoneContact)?user.phoneContact:user.preferredContact==='whatsapp'?'whatsapp-text':(user.phoneNumber||user.phone)?'call':null,
  };
}
export function applyAccountProfile(order,user){
  if(!user)return order;
  const next=structuredClone(order);
  if(next.customer)delete next.customer.fullName;
  for(const [path,value] of Object.entries(accountProfile(user)))put(next,path,value);
  return next;
}
// A draft gets account contacts only after its owner explicitly imports them.
export function applyDraftAccountProfile(order,user){
 if(!user)return order;
 if(order.accountDetailsImported===true)return applyAccountProfile(order,user);
 const next=structuredClone(order);next.accountDetailsImported=false;
 for(const field of lockedFields)put(next,field.key,null);
 return next;
}
// Awareness is broader than write access: location provenance is readable, but
// only a real venue selection may write it. Account fields stay account-owned.
export function isAiEditableField(path){
 const field=aiFields.find(item=>item.key===path);
 return Boolean(field&&!field.manualOnly&&!isLockedField(path));
}
export function updateOrderField(order,path,value,{ai=false}={}) {
  if(isLockedField(path)||(ai&&!isAiEditableField(path)))return order;
  const field=(ai?aiFields:fields).find(item=>item.key===path);
  if(!field||!validValue(field,value))return order;
  const next=structuredClone(order);put(next,path,value);
  // Explicit service decisions stay in sync with the canonical booking selections.
  if(path==='music.djRequested'&&typeof value==='boolean')next.services=value?[...new Set([...(next.services||[]),'dj'])]:(next.services||[]).filter(id=>id!=='dj');
  if(path==='services'&&Array.isArray(value)){
    if(value.includes('dj'))next.music.djRequested=true;
    else if(order.services?.includes('dj'))next.music.djRequested=false;
    if(value.includes('mc'))next.music.mcRequested=true;
    else if(order.services?.includes('mc'))next.music.mcRequested=false;
  }
  if(path==='music.mcRequested'&&typeof value==='boolean'){
    next.services=value?[...new Set([...(next.services||[]),'mc'])]:(next.services||[]).filter(id=>id!=='mc');
  }
  if(ai)next.source='ai';return next;
}
// Compare wall-clock values in the contract timezone, independent of the
// browser/server timezone. Overnight ends are not past starts.
export function pastEventScheduleFields(order,now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:contract.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(part=>[part.type,part.value]));
 const today=`${parts.year}-${parts.month}-${parts.day}`,clock=`${parts.hour}:${parts.minute}`,event=order.event||{};
 if(event.date&&event.date<today)return ['event.date'];
 if(event.date===today&&event.startTime&&event.startTime<=clock)return ['event.startTime'];
 return [];
}
// Assess the complete proposed schedule, then reject its date/time edits as a
// unit. A rejected date must never leave behind a newly saved start/end time.
export function futureEventPatch(order,patch,{now=new Date()}={}){
 const paths=['event.date','event.startTime','event.endTime'],schedule=(patch||[]).filter(change=>paths.includes(change?.path));
 if(!schedule.length)return {patch:patch||[],rejectedFields:[]};
 const candidate=structuredClone(order);
 for(const change of schedule){const field=fields.find(field=>field.key===change.path),value=decodePatchValue(field,change.value);if(validValue(field,value))put(candidate,change.path,value);}
 const problems=pastEventScheduleFields(candidate,now);
 return problems.length?{patch:patch.filter(change=>!paths.includes(change?.path)),rejectedFields:[...new Set(schedule.map(change=>change.path))],reason:'past_event_schedule'}:{patch,rejectedFields:[]};
}
export function applyOrderPatch(order,patch,{now=new Date()}={}) {
  if(!Array.isArray(patch))return order;
  return futureEventPatch(order,patch,{now}).patch.slice(0,100).reduce((current,change)=>{
    const field=aiFields.find(item=>item.key===change?.path);if(!field)return current;
    const value=decodePatchValue(field,change.value);
    return updateOrderField(current,field.key,value,{ai:true});
  },order);
}
export function missingOrderFields(order) {
  return fields.filter(field=>(field.requiredOverride===false?false:(field.required||(field.key==='event.title'&&getPath(order,'event.type')==='other')))&&(!field.gate||getPath(order,field.gate)===true)&&(!isAnswered(getPath(order,field.key))||(field.key==='studio.rights.confirmed'&&getPath(order,field.key)!==true)));
}
export function validateEventOrder(input,{submission=false,today=new Date().toLocaleDateString('en-CA',{timeZone:contract.timezone})}={}) {
  const errors=[];
  if(input?.accountDetailsImported!==undefined&&typeof input.accountDetailsImported!=='boolean')errors.push('accountDetailsImported');
  if(input?.schemaVersion!==contract.version)errors.push('schemaVersion');
  for(const field of [...fields,...planningFields]){const value=getPath(input,field.key);if(value!==undefined&&!validValue(field,value))errors.push(field.key);}
  if(input?.event?.timezone!==contract.timezone)errors.push('event.timezone');
  if(!validValue(aiFields.find(field=>field.key==='equipment'),input?.equipment))errors.push('equipment');
  if(submission){
    errors.push(...missingOrderFields(input).map(field=>field.key));
    if(input?.event?.date&&input.event.date<today)errors.push('event.date');
    errors.push(...pastEventScheduleFields(input));
    if(input?.event?.startTime&&input.event.startTime===input.event.endTime)errors.push('event.endTime');
    if(input?.customer?.phone&&input.customer.phone.trim().length<5)errors.push('customer.phone');
    if(input?.customer?.contactMethod==='phone'&&!input?.customer?.phone?.trim())errors.push('customer.contactMethod'); // phone needs a number
    if(input?.studio?.requested&&input.studio.delivery?.requestedDate<today)errors.push('studio.delivery.requestedDate');
  }
  return [...new Set(errors)];
}
export function legacyToOrder(order, draft) {
  let next=order;
  const map={eventType:'event.type',eventDate:'event.date',startTime:'event.startTime',endTime:'event.endTime',guests:'event.guestCount',venueName:'event.venue.name',venueAddress:'event.venue.address',city:'event.venue.city',postalCode:'event.venue.postalCode',notes:'additional.notes',setupRequirements:'event.setup.requirements',phone:'customer.phone',contactMethod:'customer.contactMethod',company:'customer.company',services:'services'};
  for(const [key,path] of Object.entries(map))if(draft?.[key]!==undefined&&draft[key]!==null&&draft[key]!=='')next=updateOrderField(next,path,key==='guests'?Number(draft[key]):draft[key]);
  return next;
}
// The old single music-language choice of the service request, worked out from the chosen languages.
function legacyMusicStyle(pairs){const names=[...new Set((pairs||[]).map(pair=>String(pair.language||'').toLowerCase()))];const arabic=names.includes('arabic'),english=names.includes('english');return arabic&&english?'mixed':arabic&&names.length===1?'arabic':english&&names.length===1?'english':'other';}
export function orderToLegacy(order) {
  const e=order.event,m=order.music,c=order.customer;
  const legacy={eventType:e.type||'other',eventDate:e.date||'',startTime:e.startTime||'',endTime:e.endTime||'',phone:c.phone||'',contactMethod:c.contactMethod||'email',company:c.company||'',venueName:e.venue.name||'',venueAddress:e.venue.address||'',city:e.venue.city||'',postalCode:e.venue.postalCode||'',indoor:e.venue.setting!=='outdoor',guests:e.guestCount??0,services:order.services,musicStyle:legacyMusicStyle(m.languagePairs),notes:order.additional.notes||'',setupRequirements:e.setup.requirements||'',otherMusic:'',entrance:'',customMix:'',announcements:''};// the old free-text booking fields are no longer data atoms: they stay empty
  for(const key of ['setupRequirements','otherMusic','entrance','customMix','announcements'])legacy[key]=legacy[key].slice(0,2000);
  return legacy;
}
// Hydrate validated current context without treating existing read-only facts as
// proposed AI edits. Iterate known paths only; never accept arbitrary paths.
export function orderFromContext(context={}){
 const order=createEventOrder();
 for(const field of aiFields){const value=decodePatchValue(field,context[field.key]);if(value!==undefined&&validValue(field,value))put(order,field.key,value);}
 return order;
}
export function aiOrderContext(order) {
  return Object.fromEntries(aiFields.map(field=>[field.key,getPath(order,field.key)??(['multi','links','attachments','equipment'].includes(field.type)?[]:null)]));
}

// Opening line for a voice call: greet, say what the assistant is for, recap the draft, then offer help with what is still empty.
export function voiceGreetingInstructions(order, ar = false) {
  const text = value => (Array.isArray(value) ? value.join(', ') : String(value)).slice(0, 80);
  const label = field => (ar && field.ar) || field.label;
  const filled = aiFields.filter(field => !field.private&&field.type!=='equipment'&&isAnswered(getPath(order, field.key))).slice(0, 10).map(field => `${label(field)}: ${text(getPath(order, field.key))}`);
  const open = missingOrderFields(order).filter(field => !field.private&&aiFields.includes(field)).slice(0, 4).map(label);
  const draft = filled.length ? filled.join('; ') : (ar ? 'لا توجد تفاصيل بعد' : 'nothing filled in yet');
  const left = open.length ? open.join('; ') : (ar ? 'لا شيء مهم ناقص' : 'nothing important is missing');
  return ar
    ? `ابدأ الكلام فوراً دون انتظار العميل، بالعربية، في ثلاث أو أربع جمل قصيرة جداً وبنبرة دافئة: (١) تحية موجزة. (٢) جملة واحدة تعرّف بدورك: مساعد الحجز الآلي لإيكو الذي يساعد في تعبئة طلب الفعالية. (٣) ملخص مختصر لمسودة الحجز الحالية: ${draft}. (٤) اسأل إن كان يريد مساعدة في الحقول التي لم تُعبأ بعد، وسمِّ أهمها: ${left}. لا تذكر أرقاماً أو بيانات لم تُذكر هنا، ولا تطل. استخدم update_event_draft لتحديث المسودة فقط.`
    : `Start speaking right away without waiting for the customer, in three or four very short sentences with a warm tone: (1) a brief greeting. (2) One sentence on your role: Echo’s AI booking assistant, here to help fill in the event request. (3) A brief summary of the current booking draft: ${draft}. (4) Ask whether they would like help with the fields still empty, naming the most important: ${left}. Do not invent details beyond these, and keep it under about fifteen seconds. Use update_event_draft for draft changes only.`;
}

// Qwen Omni Realtime starts responses only after receiving user audio. Use the
// browser's speech engine for the opening line so a call still starts warmly
// before the live model begins listening.
export function voiceGreetingText(order, ar = false) {
  const text = value => (Array.isArray(value) ? value.join(', ') : String(value)).slice(0, 80);
  const label = field => (ar && field.ar) || field.label;
  const filled = aiFields.filter(field => !field.private&&field.type!=='equipment'&&isAnswered(getPath(order, field.key))).slice(0, 5).map(field => `${label(field)}: ${text(getPath(order, field.key))}`);
  const open = missingOrderFields(order).filter(field => !field.private&&aiFields.includes(field)).slice(0, 3).map(label);
  const draft = filled.length ? filled.join('؛ ') : (ar ? 'لا توجد تفاصيل بعد' : 'nothing filled in yet');
  const left = open.length ? open.join('، ') : (ar ? 'لا شيء مهم ناقص' : 'nothing important is missing');
  return ar
    ? `مرحباً، أنا مساعد الحجز الآلي من إيكو، وسأساعدك في تجهيز طلب الفعالية. هذه هي التفاصيل التي جمعناها حتى الآن: ${draft}. هل تريد أن نكمل معاً؟ يمكننا البدء بـ ${left}.`
    : `Hello, I’m Echo’s AI booking assistant, and I can help prepare your event request. Here’s what we have so far: ${draft}. Would you like to continue together? We can start with ${left}.`;
}
