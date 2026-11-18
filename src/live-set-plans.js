const {randomUUID}=require('node:crypto');
const journey=require('./booking-journey');
const failure=message=>Object.assign(new Error(message),{status:409});
function entriesOf(plan){
 return (plan?.segments||[]).flatMap(segment=>{
  const manual=new Map((segment.manualTracks||[]).map(track=>[track.id,track]));
  const entries=segment.entries?.length?segment.entries:[...(segment.recordingIds||[]).map(id=>({type:'recording',id})),...(segment.manualTracks||[]).map(track=>({type:'manual',id:track.id}))];
  return entries.map(entry=>entry.type==='manual'?{...entry,track:manual.get(entry.id)}:entry);
 });
}
function createLiveSetPlans({getLiveStreamConfig,BookingModel,ArchiveModel,LiveSession}){
 async function planFor(id){
  if(id==='livestream')return (await getLiveStreamConfig()).djSetPlan;
  if(typeof id==='string'&&id.startsWith('booking:')&&id.length<=200){
   const booking=await BookingModel.findOne({externalId:id.slice(8),status:{$in:journey.statusesWhere('isBooked')}});
   return booking?.planning?.djSet;
  }
  throw failure('Choose a saved DJ Builder set list or No set list.');
 }
 async function list(){
  const stream=await getLiveStreamConfig();
  const bookings=await BookingModel.find({status:{$in:journey.statusesWhere('isBooked')},'planning.djSet.segments.0':{$exists:true}}).select('externalId requestNumber customerName planning.djSet').lean();
  return [{id:'livestream',title:'DJ Builder — Live stream',plan:stream.djSetPlan},...bookings.map(row=>({id:'booking:'+row.externalId,title:[row.requestNumber||row.externalId,row.customerName].filter(Boolean).join(' · '),plan:row.planning?.djSet}))]
   .map(({id,title,plan})=>({id,title,trackCount:entriesOf(plan).length})).filter(row=>row.trackCount>0);
 }
 async function prepare(id='none'){
  if(id==='none')return {id,install:async()=>{}};
  const entries=entriesOf(await planFor(id));
  if(!entries.length)throw failure('This set list is empty or no longer available. Refresh the set lists.');
  if(entries.length>1000)throw failure('This set list has too many tracks for one live session. Choose a shorter set.');
  const ids=[...new Set(entries.filter(row=>row.type==='recording').map(row=>row.id))];
  const recordings=ids.length?[...await ArchiveModel.find({externalId:{$in:ids},published:true,status:{$ne:'ARCHIVED'}}).lean(),...await require('./music-archive').recordingSongs(ArchiveModel,ids)]:[];
  const byId=new Map(recordings.map(row=>[row.externalId,row]));
  const rows=entries.map((entry,index)=>{
   const track=entry.type==='manual'?entry.track:byId.get(entry.id);
   if(!track?.title)throw failure('A track in this set list is no longer available. Update it in DJ Builder.');
   // Reuse an archive URL, never its ownership/deletion IDs or its playback state.
   return {track:track.title,artist:track.artist||'',duration:track.duration||'',genre:track.genre||'',audioUrl:entry.type==='recording'?track.audioUrl||'':'',sourcePlatform:entry.type==='recording'?'archive':'manual',sortOrder:(index+1)*100,playState:'queued'};
  });
  return {id,async install(session){
   try{await LiveSession.insertMany(rows.map(row=>({...row,externalId:'live-session-'+randomUUID(),broadcastSessionId:session})));}
   catch(error){await LiveSession.deleteMany({broadcastSessionId:session});throw error;}
  }};
 }
 return {list,prepare};
}
function registerLiveSetPlans(app,{requireAdmin,plans}){
 app.get('/api/admin/dj-service-builder/set-lists',requireAdmin,async(_req,res)=>{
  try{return res.set('Cache-Control','no-store').json({items:await plans.list()});}
  catch{return res.status(503).json({message:'Could not load DJ Builder set lists. Try again, or choose No set list.'});}
 });
}
module.exports={createLiveSetPlans,registerLiveSetPlans,entriesOf};
