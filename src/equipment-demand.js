// Physical inventory demand of a booking's equipment lines. Prices remain on quote lines.
function equipmentDemand(lines,catalog){
 const byId=new Map(catalog.map(row=>[row.slug||row.id,row])),totals=new Map();
 const add=(id,quantity,path=[])=>{
  if(path.includes(id))throw new Error('A set cannot contain itself or another cyclic set.');
  const item=byId.get(id);
  if(!item||item.isActive===false)throw new Error('An equipment item or set member is no longer available. Please review the catalog.');
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)throw new Error('Invalid equipment quantity.');
  totals.set(id,(totals.get(id)||0)+quantity);
 };
 for(const line of lines)if(!line.serviceId.startsWith('svc-'))add(line.serviceId,line.quantity);
 return [...totals].map(([slug,quantity])=>({slug,quantity}));
}
module.exports={equipmentDemand};
