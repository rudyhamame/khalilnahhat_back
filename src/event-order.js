const { z } = require('zod');
const core = require('./eventOrderCore.mjs');
const {eventSchema,normalizeQuoteItems}=require('./quote-validation');
const orderSchema = z.custom(value => value && core.validateEventOrder(value).length === 0, 'Invalid event order JSON.');
const orderPatchJsonSchema = { type:'array', maxItems:40, items:{type:'object',additionalProperties:false,required:['path','value'],properties:{path:{type:'string',enum:core.aiFields.map(field=>field.key)},value:{type:'string',maxLength:3000,description:'The actual stated answer: for 180 guests return the string 180; for services return a JSON array string such as ["dj"]. Omit unknown answers entirely; do not emit null.'}}} };
function sanitizeOrderPatch(patch){
  if(!Array.isArray(patch))return [];
  return patch.slice(0,40).filter(change=>{
    const field=core.aiFields.find(item=>item.key===change?.path);if(!field)return false;
    let value=change.value;
    if(typeof value==='string'&&['number','boolean','multi','links'].includes(field.type)){try{value=JSON.parse(value);}catch{return false;}}
    return core.validValue(field,value);
  });
}
function prepareSubmittedOrder(value,user,lines,catalog){
  const errors=core.validateEventOrder(value,{submission:true});
  if(errors.length)throw Object.assign(new Error('Complete the required event details before submitting.'),{status:400,fields:errors});
  const order=core.normalizeEventOrder(value);
  order.customer.fullName=`${user.firstName} ${user.lastName}`.trim();order.customer.email=user.email;
  const legacy=eventSchema.safeParse(core.orderToLegacy(order));
  if(!legacy.success)throw Object.assign(new Error('Event details failed validation.'),{status:400});
  const items=normalizeQuoteItems(lines,catalog);
  const equipment=items.filter(item=>!item.serviceId.startsWith('svc-')).map(item=>({id:item.serviceId,name:item.name,quantity:item.quantity}));
  const selectedServices=items.filter(item=>item.serviceId.startsWith('svc-')).map(item=>item.serviceId.slice(4)).filter(id=>id!=='general');
  if(JSON.stringify([...selectedServices].sort())!==JSON.stringify([...order.services].sort())||JSON.stringify(equipment.map(item=>[item.id,item.quantity]).sort())!==JSON.stringify(order.equipment.map(item=>[item.id,item.quantity]).sort()))throw Object.assign(new Error('Order selections changed. Please review your equipment and services again.'),{status:400});
  order.equipment=equipment;
  return {order,event:legacy.data,items};
}
const draftTool={type:'function',name:'update_event_draft',description:'Immediately apply event-order draft fields explicitly provided or corrected by the client. A direct instruction is authorization for this draft edit; do not ask for reconfirmation. Call this before speaking an acknowledgement, then use the returned actual field results. This only updates an unsubmitted local draft. It cannot book, pay, reserve, or confirm anything.',parameters:{type:'object',additionalProperties:false,required:['updates'],properties:{updates:orderPatchJsonSchema}}};
function orderInstructions(){return `You are filling the shared Echo event order. Ask about missing quote details one or two at a time, in short plain everyday words: clients are not music or event experts, so give simple examples and never use jargon. Return orderPatch entries for facts explicitly provided or corrected by the CLIENT, not your suggestions. Never invent unknowns, ranges, dates, equipment availability or permissions. Unknown values remain null in the order: OMIT unknown fields from orderPatch; never output null patch values for answers already supplied. Encode arrays, booleans and numbers as JSON strings in each patch value; normal text stays plain text. Example for a wedding with 180 guests and DJ: [{"path":"event.type","value":"wedding"},{"path":"event.guestCount","value":"180"},{"path":"services","value":"[\"dj\"]"}]. Only the client can confirm rights, and customer contact details / exact addresses belong in the manual review form. Equipment and quantities are chosen by the client in the page's 03 / The Setup section, which the page scrolls to automatically once services are known: never ask for equipment names or counts in chat. Once services are known, tell the client to pick equipment and quantities there, say you will wait, and ask no further questions until they say they are done; then review the equipment in the current order data.  Final timeline/dances/must-play planning belongs after confirmation. Never claim submission or reservation. Draft edits are immediate: a clear statement or correction such as "change it to graduation" authorizes that draft change now. Do not ask "shall I update it?", wait for "yes", or promise "I will update" without applying it. For voice, call update_event_draft FIRST whenever new details are provided or corrected, before any spoken acknowledgement or show_app_section navigation. Use exact field keys and allowed option values from the field guide, translating the client's language to those values (for example حفل تخرج means event.type=graduation). After the tool result, acknowledge only fields in updatedFields. If draftUpdated=false or rejectedFields is nonempty, explain the actual failure or ask one specific clarification; never claim the rejected change was applied. Review is required only to submit a booking request, never to edit its draft. For text chat, include the requested valid changes in orderPatch in this same response. A clear user correction takes precedence over the old value in the current draft. Waiting for equipment selection does not block applying corrections to other fields. Ask a clarification only when the value itself is ambiguous or missing. Never interpret a general request to change an event as permission to reserve or submit it. Field guide: ${JSON.stringify(core.aiFields.map(field=>({path:field.key,label:field.label,type:field.type||'text',options:field.options,gate:field.gate,required:field.required})))}`;}
module.exports={...core,orderSchema,orderPatchJsonSchema,sanitizeOrderPatch,draftTool,orderInstructions,prepareSubmittedOrder};
