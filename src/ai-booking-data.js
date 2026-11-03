const {availabilitySnapshot}=require('./availability');
const {stockView}=require('./equipment-stock');

const bookingDataTool={type:'function',name:'read_booking_data',description:'Read current live calendar availability, active events, services, equipment, sets and published prices. Also returns the current client draft from the page. Call before answering availability, catalog or pricing questions; recheck when the event date changes. Read only; no reservation.',parameters:{type:'object',additionalProperties:false,required:['year'],properties:{year:{type:'integer',minimum:2000,maximum:2200,description:'Calendar year to check in Toronto.'}}}};
const bookingDataInstructions=`You have live booking data access. Use read_booking_data before answering calendar availability, service, equipment, set or pricing questions in voice. Chat receives fresh booking data with each request. Do not say you cannot see live availability when a successful snapshot is supplied. Calendar days list busy minute ranges (0–1440 Toronto time), including owner blocks; a missing day in a successfully loaded year has no confirmed busy range. Check the full requested time range, including the next day for overnight events. A free calendar is provisional, never a reservation or guaranteed equipment availability. Catalog stock is not a date-specific inventory promise. Only quote published prices with their units/currency; zero or absent prices require a quote. If a source reports unavailable, state exactly which data could not load and retry; never treat missing data as free. The current signed-in draft is the source of truth. Use update_event_draft before claiming a change, inspect its actual result, and acknowledge only updatedFields. Never claim an edit from your spoken intentions alone.`;
function validYear(value){const current=new Date().getUTCFullYear();return Number.isInteger(value)&&value>=current-5&&value<=current+15;}
function createBookingData({loadAvailability=availabilitySnapshot,loadCatalog=()=>require('./setup-catalog').list(),loadEquipment=()=>require('./equipment').Equipment.find({isActive:true}).lean(),loadPrices=()=>require('./models').ServicePrice.find({isActive:true}).select('serviceId name amountCents currency unit -_id').lean()}={}){
 return async (year,{calendarOnly=false}={})=>{
  if(!validYear(year))throw Object.assign(new Error('Choose a year within the availability calendar range.'),{status:400});
  const read=async load=>{try{return {status:'ready',data:await load()};}catch{return {status:'unavailable',data:null};}};
  if(calendarOnly)return {checkedAt:new Date().toISOString(),year,timezone:'America/Toronto',availability:await read(()=>loadAvailability(year)),reserved:false};
  const [availability,catalog,equipment,prices]=await Promise.all([
   read(()=>loadAvailability(year)),read(loadCatalog),read(async()=>(await loadEquipment()).map(item=>({id:item.slug||item.id,name:item.name,description:item.description,category:item.category,isSet:Boolean(item.isSet||item.setItems?.length||item.modelParts?.length),setItems:item.setItems||[],minQuantity:item.minQuantity,...stockView(item)}))),read(async()=>(await loadPrices()).map(item=>({id:item.serviceId,name:item.name,amountCents:item.amountCents,currency:item.currency,unit:item.unit}))),
  ]);
  return {checkedAt:new Date().toISOString(),year,timezone:'America/Toronto',availability,catalog,equipment,prices,reserved:false};
 };
}
module.exports={bookingDataTool,bookingDataInstructions,createBookingData,validYear};
