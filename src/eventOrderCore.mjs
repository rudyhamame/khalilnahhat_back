import contract from './eventOrderContract.json' with { type: 'json' };
export { contract };
export const fields = contract.sections.flatMap(section => section.fields.map(field => ({ ...field, gate: section.gate })));
export const aiFields = fields.filter(field => !field.private && !field.manualOnly);
export const getPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function put(object, path, value) {
  const keys=path.split('.'); let target=object;
  for(const key of keys.slice(0,-1))target=target[key] ||= {};
  target[keys.at(-1)]=value;
}
export const isAnswered = value => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
export function createEventOrder() {
  const order={schemaVersion:contract.version,source:'manual'};
  for(const field of fields)put(order,field.key,['multi','links'].includes(field.type)?[]:null);
  order.event.timezone=contract.timezone;
  order.equipment=[];
  // This belongs to the confirmed-booking workflow, not the quote questionnaire.
  order.planning={phase:'after_confirmation',brideName:null,groomName:null,timeline:null,partyEntrances:null,entranceSongs:null,firstDance:null,parentDances:null,dinnerMusic:null,cakeCutting:null,announcements:null,mustPlay:null,doNotPlay:null,musicUploads:[],specialRequests:null};
  return order;
}
export function validValue(field, value) {
  if(value===null)return !['multi','links'].includes(field.type);
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
function safeLink(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!!u.hostname;}catch{return false;}}
export function normalizeEventOrder(input) {
  const order=createEventOrder();
  for(const field of fields){const value=getPath(input,field.key);if(value!==undefined&&validValue(field,value))put(order,field.key,Array.isArray(value)?[...new Set(value)]:value);}
  if(['manual','ai'].includes(input?.source))order.source=input.source;
  if(Array.isArray(input?.equipment))order.equipment=input.equipment.filter(item=>item&&typeof item.id==='string'&&item.id.length<=160&&Number.isInteger(item.quantity)&&item.quantity>0&&item.quantity<=10000).slice(0,100).map(item=>({id:item.id,name:String(item.name||'').slice(0,240),quantity:item.quantity}));
  return order;
}
export function updateOrderField(order,path,value,{ai=false}={}) {
  const field=(ai?aiFields:fields).find(item=>item.key===path);
  if(!field||!validValue(field,value))return order;
  const next=structuredClone(order);put(next,path,value);if(ai)next.source='ai';return next;
}
export function applyOrderPatch(order,patch) {
  if(!Array.isArray(patch))return order;
  return patch.slice(0,40).reduce((current,change)=>{
    const field=aiFields.find(item=>item.key===change?.path);if(!field)return current;
    let value=change.value;
    if(typeof value==='string'&&['number','boolean','multi','links'].includes(field.type)){
      try{value=JSON.parse(value);}catch{return current;}
    }
    return updateOrderField(current,field.key,value,{ai:true});
  },order);
}
export function missingOrderFields(order) {
  return fields.filter(field=>field.required&&(!field.gate||getPath(order,field.gate)===true)&&(!isAnswered(getPath(order,field.key))||(field.key==='studio.rights.confirmed'&&getPath(order,field.key)!==true)));
}
export function validateEventOrder(input,{submission=false,today=new Date().toLocaleDateString('en-CA',{timeZone:contract.timezone})}={}) {
  const errors=[];
  if(input?.schemaVersion!==contract.version)errors.push('schemaVersion');
  for(const field of fields){const value=getPath(input,field.key);if(value!==undefined&&!validValue(field,value))errors.push(field.key);}
  if(input?.event?.timezone!==contract.timezone)errors.push('event.timezone');
  if(!Array.isArray(input?.equipment)||input.equipment.length>100||normalizeEventOrder(input).equipment.length!==input.equipment.length)errors.push('equipment');
  if(submission){
    errors.push(...missingOrderFields(input).map(field=>field.key));
    if(input?.event?.date&&input.event.date<today)errors.push('event.date');
    if(input?.event?.startTime&&input.event.startTime===input.event.endTime)errors.push('event.endTime');
    if(input?.customer?.phone&&input.customer.phone.trim().length<5)errors.push('customer.phone');
    if(input?.studio?.requested&&input.studio.delivery?.requestedDate<today)errors.push('studio.delivery.requestedDate');
  }
  return [...new Set(errors)];
}
export function legacyToOrder(order, draft) {
  let next=order;
  const map={eventType:'event.type',eventDate:'event.date',startTime:'event.startTime',endTime:'event.endTime',guests:'event.guestCount',venueName:'event.venue.name',venueAddress:'event.venue.address',city:'event.venue.city',postalCode:'event.venue.postalCode',notes:'additional.notes',setupRequirements:'event.setup.requirements',otherMusic:'music.otherPreferences',djMc:'music.djMc',entrance:'music.entrance',customMix:'music.customMix',announcements:'music.announcements',phone:'customer.phone',contactMethod:'customer.contactMethod',company:'customer.company',services:'services'};
  for(const [key,path] of Object.entries(map))if(draft?.[key]!==undefined&&draft[key]!==null&&draft[key]!=='')next=updateOrderField(next,path,key==='guests'?Number(draft[key]):draft[key]);
  if(draft?.musicStyle)next=updateOrderField(next,'music.styles',[draft.musicStyle]);
  return next;
}
export function orderToLegacy(order) {
  const e=order.event,m=order.music,c=order.customer;
  const legacy={eventType:e.type||'other',eventDate:e.date||'',startTime:e.startTime||'',endTime:e.endTime||'',phone:c.phone||'',contactMethod:c.contactMethod||'email',company:c.company||'',venueName:e.venue.name||'',venueAddress:e.venue.address||'',city:e.venue.city||'',postalCode:e.venue.postalCode||'',inGta:e.venue.area==='gta',indoor:e.venue.setting!=='outdoor',guests:e.guestCount??0,services:order.services,musicStyle:m.styles.find(value=>['arabic','english','mixed','other'].includes(value))||'other',notes:order.additional.notes||'',setupRequirements:e.setup.requirements||'',otherMusic:m.otherPreferences||'',djMc:m.djMc||'',entrance:m.entrance||'',customMix:m.customMix||'',announcements:m.announcements||''};
  for(const key of ['setupRequirements','otherMusic','djMc','entrance','customMix','announcements'])legacy[key]=legacy[key].slice(0,2000);
  return legacy;
}
export function aiOrderContext(order) {
  return Object.fromEntries(aiFields.map(field=>[field.key,getPath(order,field.key)]).filter(([,value])=>isAnswered(value)));
}

// Opening line for a voice call: greet, say what the assistant is for, recap the draft, then offer help with what is still empty.
export function voiceGreetingInstructions(order, ar = false) {
  const text = value => (Array.isArray(value) ? value.join(', ') : String(value)).slice(0, 80);
  const label = field => (ar && field.ar) || field.label;
  const filled = aiFields.filter(field => isAnswered(getPath(order, field.key))).slice(0, 10).map(field => `${label(field)}: ${text(getPath(order, field.key))}`);
  const open = missingOrderFields(order).filter(field => aiFields.includes(field)).slice(0, 4).map(label);
  const draft = filled.length ? filled.join('; ') : (ar ? 'لا توجد تفاصيل بعد' : 'nothing filled in yet');
  const left = open.length ? open.join('; ') : (ar ? 'لا شيء مهم ناقص' : 'nothing important is missing');
  return ar
    ? `ابدأ الكلام فوراً دون انتظار العميل، بالعربية، في ثلاث أو أربع جمل قصيرة جداً وبنبرة دافئة: (١) تحية موجزة. (٢) جملة واحدة تعرّف بدورك: مساعد الحجز الآلي لإيكو الذي يساعد في تعبئة طلب الفعالية. (٣) ملخص مختصر لمسودة الحجز الحالية: ${draft}. (٤) اسأل إن كان يريد مساعدة في الحقول التي لم تُعبأ بعد، وسمِّ أهمها: ${left}. لا تذكر أرقاماً أو بيانات لم تُذكر هنا، ولا تطل. استخدم update_event_draft لتحديث المسودة فقط.`
    : `Start speaking right away without waiting for the customer, in three or four very short sentences with a warm tone: (1) a brief greeting. (2) One sentence on your role: Echo’s AI booking assistant, here to help fill in the event request. (3) A brief summary of the current booking draft: ${draft}. (4) Ask whether they would like help with the fields still empty, naming the most important: ${left}. Do not invent details beyond these, and keep it under about fifteen seconds. Use update_event_draft for draft changes only.`;
}
