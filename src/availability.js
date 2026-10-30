const mongoose=require('mongoose');
const {ServiceRequest}=require('./models');
// Days the owner marks unavailable by hand (travel, rest, another commitment). One document per calendar day.
const Block=mongoose.models.AvailabilityBlock||mongoose.model('AvailabilityBlock',new mongoose.Schema({date:{type:String,required:true,unique:true},note:{type:String,default:'',maxlength:200}},{timestamps:true}));
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const minutes=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3)):null;
function mergeRanges(days){
 for(const [key,ranges] of Object.entries(days)){
  const merged=[];for(const range of ranges.sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}days[key]=merged;
 }
 return days;
}
// Confirmed bookings as busy ranges per day of `year`.
async function bookingDays(year){
 const from=`${year-1}-12-31`,to=`${year+1}-01-01`;
 const rows=await ServiceRequest.find({status:'confirmed',$or:[{'order.event.date':{$gte:from,$lte:to}},{'event.eventDate':{$gte:from,$lte:to}}]}).select('order.event.date order.event.startTime order.event.endTime event.eventDate event.startTime event.endTime -_id').limit(5001).lean();
 if(rows.length>5000)throw Object.assign(new Error('incomplete'),{incomplete:true});
 const days={};
 const add=(key,start,end)=>{if(key>=`${year}-01-01`&&key<=`${year}-12-31`&&end>start)(days[key]||=[]).push({start,end});};
 for(const row of rows){
  const event=row.order?.event||{},legacy=row.event||{},key=event.date||legacy.eventDate;
  if(!date(key))continue;
  const start=minutes(event.startTime||legacy.startTime),end=minutes(event.endTime||legacy.endTime);
  // Confirmed legacy bookings without usable hours conservatively occupy the whole day.
  if(start===null||end===null||start===end){add(key,0,1440);continue;}
  if(end>start)add(key,start,end);
  else{add(key,start,1440);const next=new Date(key+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);add(next.toISOString().slice(0,10),0,end);}
 }
 return mergeRanges(days);
}
const yearOf=req=>{const year=Number(req.query.year),current=new Date().getUTCFullYear();return Number.isInteger(year)&&year>=current-5&&year<=current+15?year:null;};
const blockedIn=async year=>(await Block.find({date:{$gte:`${year}-01-01`,$lte:`${year}-12-31`}}).select('date note -_id').sort({date:1}).lean());
function registerAvailability(app,{requireAdmin}={}){
 app.get('/api/availability',async(req,res)=>{
  const year=yearOf(req);
  if(year===null)return res.status(400).json({message:'Choose a year within the availability calendar range.'});
  try{
   const days=await bookingDays(year);
   // Days the owner blocked by hand look fully booked to the public calendar.
   for(const row of await blockedIn(year))days[row.date]=[{start:0,end:1440}];
   res.set('Cache-Control','no-store');res.json({year,timezone:'America/Toronto',source:'confirmed_bookings',days,updatedAt:new Date().toISOString()});
  }catch{res.status(503).json({message:'Availability is temporarily unavailable. Please retry.'});}
 });
 if(!requireAdmin)return;
 // Admin: bookings and hand-blocked days for one year.
 app.get('/api/admin/availability',requireAdmin,async(req,res)=>{
  const year=yearOf(req);
  if(year===null)return res.status(400).json({message:'Choose a year within the availability calendar range.'});
  try{res.set('Cache-Control','no-store').json({year,timezone:'America/Toronto',bookings:await bookingDays(year),blocked:await blockedIn(year)});}
  catch{res.status(503).json({message:'Availability is temporarily unavailable. Please retry.'});}
 });
 // Admin: mark dates unavailable (blocked:true) or available again (blocked:false).
 app.put('/api/admin/availability/blocked',requireAdmin,async(req,res)=>{
  const {dates,blocked,note}=req.body||{};
  if(!Array.isArray(dates)||!dates.length||dates.length>400||!dates.every(date)||typeof blocked!=='boolean'||(note!==undefined&&(typeof note!=='string'||note.length>200)))return res.status(400).json({message:'Choose up to 400 valid dates.'});
  const unique=[...new Set(dates)];
  try{
   if(blocked)await Block.bulkWrite(unique.map(key=>({updateOne:{filter:{date:key},update:{$set:{date:key,note:(note||'').trim()}},upsert:true}})));
   else await Block.deleteMany({date:{$in:unique}});
   res.json({changed:unique.length,blocked});
  }catch{res.status(503).json({message:'Could not save availability. Please retry.'});}
 });
}
module.exports={registerAvailability,bookingDays};
