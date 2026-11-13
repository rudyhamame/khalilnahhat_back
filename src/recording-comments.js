function normalizeTimeline(input){
 if(input===undefined)return undefined;
 if(!Array.isArray(input)||input.length>10000)throw Object.assign(Error('Invalid recording timeline.'),{status:400});
 let end=0,offset=0;
 return input.map(range=>{
  const {startMs,endMs,offsetSec}=range||{};
  if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||startMs<end||endMs<startMs||!Number.isFinite(offsetSec)||Math.abs(offsetSec-offset)>.05)throw Object.assign(Error('Invalid recording timeline.'),{status:400});
  end=endMs;offset=offsetSec+(endMs-startMs)/1000;
  return {startMs,endMs,offsetSec};
 });
}
function timedComments(comments,{timeline=[],startedAt,offsetSec=0,durationSec=Infinity}){
 const at=value=>{
  const ms=new Date(value).getTime();if(!Number.isFinite(ms))return null;
  if(!timeline.length)return (ms-new Date(startedAt).getTime())/1000;
  const range=timeline.find(r=>ms>=r.startMs&&ms<r.endMs);
  return range?range.offsetSec+(ms-range.startMs)/1000:null;
 };
 return comments.filter(item=>!item.hidden).flatMap(item=>{
  const time=at(item.createdAt);if(time===null||!Number.isFinite(time)||time<offsetSec||time>=offsetSec+durationSec)return [];
  const replyTime=item.reply?.text?at(item.reply.at):null;
  return [{id:String(item._id),name:item.name,text:item.text,atSec:time-offsetSec,...(replyTime!==null&&replyTime>=time&&replyTime<offsetSec+durationSec?{reply:{text:item.reply.text,atSec:replyTime-offsetSec}}:{})}];
 }).sort((a,b)=>a.atSec-b.atSec||a.id.localeCompare(b.id));
}
module.exports={normalizeTimeline,timedComments};
const mongoose=require('mongoose');
const snapshotSchema=new mongoose.Schema({recordingId:{type:mongoose.Schema.Types.ObjectId,required:true},commentId:{type:String,required:true},name:String,text:String,atSec:Number,reply:{text:String,atSec:Number}},{timestamps:true});
snapshotSchema.index({recordingId:1,commentId:1},{unique:true});snapshotSchema.index({recordingId:1,atSec:1});
const RecordingComment=mongoose.models.RecordingComment||mongoose.model('RecordingComment',snapshotSchema);
async function archiveComments(row,timeline){
 const originals=await require('./live-comments').LiveComment.find({session:row.roomName,hidden:{$ne:true}}).sort({createdAt:1,_id:1}).lean();
 const items=timedComments(originals,{timeline:timeline||[],startedAt:row.createdAt});
 if(items.length)await RecordingComment.bulkWrite(items.map(({id,...item})=>({updateOne:{filter:{recordingId:row._id,commentId:id},update:{$set:{...item,recordingId:row._id,commentId:id}},upsert:true}})));
 await RecordingComment.deleteMany({recordingId:row._id,commentId:{$nin:items.map(item=>item.id)}});
}
module.exports.RecordingComment=RecordingComment;module.exports.archiveComments=archiveComments;
