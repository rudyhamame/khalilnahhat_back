const mongoose=require('mongoose');
const contract=require('../contracts/booking-atoms.json');
const BOOKING_ATOMS=Object.freeze(contract.sections.flatMap(([section,keys])=>keys.map((atomId,index)=>({atomId,code:`${section}.${String(index+1).padStart(2,'0')}`,step:Number(section.slice(0,2)),section}))));
const schema=new mongoose.Schema({atomId:{type:String,required:true,unique:true,immutable:true},eidosId:{type:String,required:true,unique:true,immutable:true}},{strict:'throw',versionKey:false});
const BookingAtomEidos=mongoose.models.BookingAtomEidos||mongoose.model('BookingAtomEidos',schema);
const publicView=row=>({atomId:row.atomId,eidosId:row.eidosId});
async function listBookingAtomEidos({Eidos}){
 const links=await BookingAtomEidos.find().sort({atomId:1}).lean();
 const seeds=await Eidos.find({externalId:{$in:links.map(row=>row.eidosId)}}).select('externalId').lean();
 const present=new Set(seeds.map(row=>row.externalId));
 return links.filter(row=>present.has(row.eidosId)).map(publicView);
}
async function seedBookingAtomEidos({Eidos}){
 await Promise.all([Eidos.init(),BookingAtomEidos.init()]);
 await Promise.all([Eidos,BookingAtomEidos].map(Model=>Model.createCollection().catch(error=>{if(error.code!==48)throw error;})));
 // Explicit seeding only; reads never manufacture or resurrect an atom seed.
 for(let attempt=0;attempt<3;attempt++){
  const session=await mongoose.startSession();let created=0;
  try{
   await session.withTransaction(async()=>{
    const links=await BookingAtomEidos.find({atomId:{$in:BOOKING_ATOMS.map(row=>row.atomId)}}).session(session).lean();
    const existing=await Eidos.find({externalId:{$in:links.map(row=>row.eidosId)}}).select('externalId').session(session).lean();
    const ids=new Set(existing.map(row=>row.externalId)),linked=new Set(links.filter(row=>ids.has(row.eidosId)).map(row=>row.atomId));
    const missing=BOOKING_ATOMS.filter(atom=>!linked.has(atom.atomId));created=missing.length;
    if(!missing.length)return;
    // Repair dangling links only during an explicit seeding request.
    await BookingAtomEidos.deleteMany({atomId:{$in:missing.map(row=>row.atomId)}}).session(session);
    const seeds=await Eidos.insertMany(missing.map(()=>({})),{session});
    await BookingAtomEidos.insertMany(missing.map((atom,index)=>({atomId:atom.atomId,eidosId:seeds[index].externalId})),{session});
   });
   return {created,bookingAtoms:await listBookingAtomEidos({Eidos})};
  }catch(error){if(error.code!==11000||attempt===2)throw error;}
  finally{await session.endSession();}
 }
}
module.exports={BOOKING_ATOMS,BookingAtomEidos,listBookingAtomEidos,seedBookingAtomEidos};
