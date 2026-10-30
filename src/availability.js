const {ServiceRequest}=require('./models');
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const minutes=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3)):null;
function registerAvailability(app){
 app.get('/api/availability',async(req,res)=>{
  const year=Number(req.query.year),current=new Date().getUTCFullYear();
  if(!Number.isInteger(year)||year<current-5||year>current+15)return res.status(400).json({message:'Choose a year within the availability calendar range.'});
  const from=`${year-1}-12-31`,to=`${year+1}-01-01`;
  try{
   const rows=await ServiceRequest.find({status:'confirmed',$or:[{'order.event.date':{$gte:from,$lte:to}},{'event.eventDate':{$gte:from,$lte:to}}]}).select('order.event.date order.event.startTime order.event.endTime event.eventDate event.startTime event.endTime -_id').limit(5001).lean();
   if(rows.length>5000)return res.status(503).json({message:'Availability could not be loaded completely.'});
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
   for(const [key,ranges] of Object.entries(days)){
    const merged=[];for(const range of ranges.sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}days[key]=merged;
   }
   res.set('Cache-Control','no-store');res.json({year,timezone:'America/Toronto',source:'confirmed_bookings',days,updatedAt:new Date().toISOString()});
  }catch{res.status(503).json({message:'Availability is temporarily unavailable. Please retry.'});}
 });
}
module.exports={registerAvailability};
