const MINUTE=60000;
const JOIN_EARLY_MINUTES=30,JOIN_LATE_MINUTES=60;
function meetingJoinWindow(meeting){
 const start=new Date(meeting.start).getTime();
 return {opensAt:new Date(start-JOIN_EARLY_MINUTES*MINUTE),closesAt:new Date(start+(Number(meeting.durationMin)||30)*MINUTE+JOIN_LATE_MINUTES*MINUTE)};
}
function missedMeetingFilter(now){
 return {status:'booked',mode:'online',clientJoinedAt:null,attendanceTrackingStartedAt:{$type:'date'},$expr:{$lt:[{$add:['$start',{$multiply:[{$add:[{$ifNull:['$durationMin',30]},JOIN_LATE_MINUTES]},MINUTE]}]},new Date(now)]}};
}
async function pruneMissedMeetings({Model,clock=Date.now,onDeleted=()=>{}}){
 const now=clock();
 // Older appointments have no attendance evidence. Adopt only ones whose join window has not opened.
 await Model.updateMany({status:'booked',mode:'online',clientJoinedAt:null,attendanceTrackingStartedAt:null,start:{$gt:new Date(now+JOIN_EARLY_MINUTES*MINUTE)}},{$set:{attendanceTrackingStartedAt:new Date(now)}});
 const filter=missedMeetingFilter(now);
 const candidates=await Model.find(filter).limit(200).lean();let deleted=0;
 for(const candidate of candidates){
  if(candidate.status!=='booked'||candidate.mode!=='online'||candidate.clientJoinedAt||!candidate.attendanceTrackingStartedAt||meetingJoinWindow(candidate).closesAt.getTime()>=now)continue;
  // Recheck attendance atomically: a client joining during the sweep must keep their meeting.
  const removed=await Model.findOneAndDelete({...filter,_id:candidate._id});
  if(removed){deleted++;onDeleted(String(removed._id));}
 }
 return {deleted};
}
module.exports={JOIN_EARLY_MINUTES,JOIN_LATE_MINUTES,meetingJoinWindow,missedMeetingFilter,pruneMissedMeetings};
