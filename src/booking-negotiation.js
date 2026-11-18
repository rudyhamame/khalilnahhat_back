const {z}=require('zod');
const {ServiceRequest,ServicePrice}=require('./models');
const {Equipment}=require('./equipment');
const journey=require('./booking-journey');
const {equipmentDemand}=require('./equipment-demand');

const proposalSchema=z.object({
  quoteRevision:z.number().int().min(0),
  negotiationRevision:z.number().int().min(0),
  message:z.string().trim().max(2000).default(''),
  items:z.array(z.object({serviceId:z.string().trim().min(1).max(160),quantity:z.number().int().min(1).max(100000),unitPrice:z.number().finite().min(0).max(1000000).multipleOf(.01)})).min(1).max(200),
});
async function loadNegotiationCatalog(){
 const [services,equipment,prices]=await Promise.all([require('./setup-catalog').list(),Equipment.find({isActive:true}).lean(),ServicePrice.find({isActive:true}).lean()]);
 const priceMap=new Map(prices.map(row=>[row.serviceId,row]));
 const items=services.filter(row=>row.kind==='service').map(row=>({serviceId:`svc-${row.id}`,name:row.name,category:'service',minQuantity:1,unitPrice:priceMap.has(row.priceId)?Number(priceMap.get(row.priceId).amountCents)/100:null}));
 items.push(...equipment.map(row=>({serviceId:row.slug,name:row.name,category:row.category,minQuantity:row.minQuantity||1,unitPrice:priceMap.has(row.slug)?Number(priceMap.get(row.slug).amountCents)/100:Number.isFinite(row.priceCents)?row.priceCents/100:null})));
 return {items,equipment};
}
function normalizeOffer(lines,catalog,currentItems=[]){
 const seen=new Set();
 const items=lines.map(line=>{
  if(seen.has(line.serviceId))throw new Error('Each service or equipment item can appear only once.');
  seen.add(line.serviceId);
  const active=catalog.items.find(row=>row.serviceId===line.serviceId);
  // Existing, retired lines can be kept or removed; retired additions are never accepted.
  const row=active||currentItems.find(item=>item.serviceId===line.serviceId);
  if(!row)throw new Error('An item is no longer available. Refresh the catalog.');
  if(row.category==='service'&&line.quantity!==1)throw new Error('Service quantity must be one.');
  if(line.quantity<(active?.minQuantity||1))throw new Error(`${row.name} requires a minimum quantity of ${active.minQuantity}.`);
  return {serviceId:line.serviceId,name:row.name,category:row.category,quantity:line.quantity,unitPrice:line.unitPrice};
 });
 equipmentDemand(items,catalog.equipment);
 return items;
}
function registerBookingNegotiation(app,{requireAuth,Model=ServiceRequest,serialize,loadCatalog=loadNegotiationCatalog}){
 app.get('/api/service-requests/negotiation-catalog',requireAuth,async(_req,res)=>res.set('Cache-Control','no-store').json({items:(await loadCatalog()).items}));
 app.post('/api/service-requests/:id/negotiation',requireAuth,async(req,res)=>{
  const parsed=proposalSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:'Enter valid quantities and offered prices for at least one service or equipment item.'});
  const sr=await Model.findOne({externalId:req.params.id,userId:req.authUser._id});
  if(!sr||String(sr.userId)!==String(req.authUser._id))return res.status(404).json({message:'Booking not found.'});
  if(!journey.rule(sr.status).canNegotiate)return res.status(409).json({message:'Changes close after the quote is accepted or the request is closed.'});
  if(journey.rule(sr.status).expires&&sr.expiresAt<=new Date())return res.status(409).json({message:'This quote expired. Ask the team to reactivate it.'});
  if(parsed.data.quoteRevision!==(sr.quoteRevision||0)||parsed.data.negotiationRevision!==(sr.negotiationRevision||0))return res.status(409).json({message:'The quote or offer changed. Refresh this booking before sending your offer.'});
  let items;
  try{items=normalizeOffer(parsed.data.items,await loadCatalog(),sr.items);}catch(error){return res.status(400).json({message:error.message});}
  sr.negotiationRevision=(sr.negotiationRevision||0)+1;
  const proposal={revision:sr.negotiationRevision,quoteRevision:sr.quoteRevision||0,message:parsed.data.message,items,quotedItems:sr.items.map(item=>({serviceId:item.serviceId,name:item.name,category:item.category,quantity:item.quantity,unitPrice:item.unitPrice})),submittedAt:new Date(),resolvedAt:null};
  sr.negotiation=proposal;
  sr.negotiationHistory=[...(sr.negotiationHistory||[]),proposal];
  sr.changeRequest=proposal.message||'Client proposed item prices and selections.';
  if(sr.quotedAt)sr.status=journey.STATUS.CHANGES_REQUESTED;
  try{await sr.save();}catch(error){if(error.name==='VersionError')return res.status(409).json({message:'The booking changed. Refresh before sending your offer.'});throw error;}
  return res.json({item:serialize(sr,false)});
 });
}
// An admin may adopt the proposed selection and adjust its prices before publishing a new quote.
function quoteSelection(sr,{proposalRevision}){
 if(proposalRevision===undefined)return sr.items;
 if(!sr.negotiation||sr.negotiation.resolvedAt||sr.negotiation.revision!==proposalRevision)throw new Error('This offer changed or has already been reviewed. Reload the booking.');
 return sr.negotiation.items;
}
function syncOrderSelection(sr){
 if(!sr.order)return;
 const order=structuredClone(sr.order);
 order.services=sr.items.filter(item=>item.serviceId.startsWith('svc-')).map(item=>item.serviceId.slice(4)).filter(id=>id!=='general');
 order.equipment=sr.items.filter(item=>!item.serviceId.startsWith('svc-')).map(item=>({id:item.serviceId,name:item.name,quantity:item.quantity}));
 order.music={...order.music,djRequested:order.services.includes('dj'),mcRequested:order.services.includes('mc')};
 sr.order=order;
 if(sr.event)sr.event={...sr.event,services:order.services};
}
module.exports={registerBookingNegotiation,loadNegotiationCatalog,normalizeOffer,proposalSchema,quoteSelection,syncOrderSelection};
