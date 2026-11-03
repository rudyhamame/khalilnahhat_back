// Expand bundles into physical inventory demand while retaining the bundle's own
// capacity. Prices remain on quote lines; expanding stock never adds charges.
function equipmentDemand(lines,catalog){
 const byId=new Map(catalog.map(row=>[row.slug||row.id,row])),totals=new Map();
 const add=(id,quantity,path=[])=>{
  if(path.includes(id))throw new Error('A set cannot contain itself or another cyclic set.');
  const item=byId.get(id);
  if(!item||item.isActive===false)throw new Error('An equipment item or set member is no longer available. Please review the catalog.');
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)throw new Error('Invalid equipment quantity.');
  totals.set(id,(totals.get(id)||0)+quantity);
  for(const member of item.setItems||[])add(member.equipmentId,quantity*member.quantity,[...path,id]);
 };
 for(const line of lines)if(!line.serviceId.startsWith('svc-'))add(line.serviceId,line.quantity);
 return [...totals].map(([slug,quantity])=>({slug,quantity}));
}
async function validateSetMembers(data,existing,Model){
 if(data.setItems===undefined)return;
 const id=data.slug||existing?.slug;
 if(data.setItems.some(member=>member.equipmentId===id))throw Object.assign(new Error('A set cannot contain itself.'),{status:400});
 const rows=await Model.find({slug:{$in:data.setItems.map(member=>member.equipmentId)}});
 if(rows.length!==data.setItems.length||rows.some(row=>row.isSet||row.setItems?.length||row.modelParts?.length))throw Object.assign(new Error('Choose existing individual equipment for each set member.'),{status:400});
 if((data.isSet??existing?.isSet)&&data.setItems.reduce((sum,row)=>sum+row.quantity,0)<2&&!(data.modelParts||existing?.modelParts||[]).length)throw Object.assign(new Error('A set must contain at least two pieces.'),{status:400});
}
module.exports={equipmentDemand,validateSetMembers};
