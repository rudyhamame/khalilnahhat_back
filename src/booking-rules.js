const mongoose=require('mongoose');
const core=require('./eventOrderCore.mjs');
// Admin-edited booking rules (required, max length, allowed values) per data atom, kept in one document and laid over the contract in place.
const Model=mongoose.models.BookingRules||mongoose.model('BookingRules',new mongoose.Schema({_id:String,rules:mongoose.Schema.Types.Mixed,updatedBy:String},{timestamps:true}));
const store={load:()=>Model.findById('rules').lean(),save:(rules,owner)=>Model.findOneAndUpdate({_id:'rules'},{$set:{rules,updatedBy:owner}},{upsert:true,new:true}).lean()};
function registerBookingRules(app,{requireAdmin,repository=store}){
 repository.load().then(row=>core.applyBookingRules(row?.rules||{})).catch(error=>console.error('Booking rules could not be loaded:',error.message));
 app.get('/api/booking-rules',async(_req,res)=>{try{res.set('Cache-Control','no-store').json({rules:(await repository.load())?.rules||{}});}catch{res.status(503).json({message:'Booking rules are temporarily unavailable.'});}});
 app.put('/api/admin/booking-rules',requireAdmin,async(req,res)=>{
  let rules;try{rules=core.cleanBookingRules(req.body?.rules);}catch(error){return res.status(400).json({message:error.message});}
  try{await repository.save(rules,String(req.user?.id||req.user?._id||''));core.applyBookingRules(rules);res.json({rules});}catch{res.status(503).json({message:'Booking rules could not be saved.'});}
 });
}
module.exports={registerBookingRules};
