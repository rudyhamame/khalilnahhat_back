const mongoose=require('mongoose');
const {randomUUID}=require('node:crypto');
const {tokenPolicy}=require('./token-policy');
const taskSchema=new mongoose.Schema({_id:String,owner:{type:String,required:true,index:true},sessionId:String,requestId:String,command:String,source:String,contextInitialized:Boolean,state:{type:String,index:true},input:[mongoose.Schema.Types.Mixed],actions:[mongoose.Schema.Types.Mixed],audit:[mongoose.Schema.Types.Mixed],result:mongoose.Schema.Types.Mixed,error:String,pending:mongoose.Schema.Types.Mixed,cancelRequested:{type:Boolean,default:false},leaseToken:String,leaseUntil:Date,notification:mongoose.Schema.Types.Mixed,pushPublishedVersion:String},{timestamps:true,versionKey:false});
 taskSchema.index({owner:1,sessionId:1,createdAt:-1});taskSchema.index({owner:1,requestId:1},{unique:true});taskSchema.index({state:1,leaseUntil:1,createdAt:1});
const Task=mongoose.models.EchoAdminTask||mongoose.model('EchoAdminTask',taskSchema);
const Control=mongoose.models.EchoAdminControl||mongoose.model('EchoAdminControl',new mongoose.Schema({_id:String,paused:{type:Boolean,default:false},updatedBy:String,leaseToken:String,leaseUntil:Date},{timestamps:true}));
function createStore(){const auditCounts=new WeakMap();return {
 async init(){await Promise.all([Task.init(),Control.init()]);},
 async create(value){try{return (await Task.create(value)).toObject();}catch(e){if(e.code!==11000)throw e;return Task.findOne({owner:value.owner,requestId:value.requestId}).lean();}},
 get:id=>Task.findById(id).lean(),
 conversation:(owner,sessionId,task)=>Task.find({owner,sessionId,_id:{$ne:task._id},createdAt:{$lte:task.createdAt}}).sort({createdAt:-1,_id:-1}).limit(tokenPolicy().historyRequests).select('_id command state result error actions').lean(),
 async conversations(owner){return Task.aggregate([{$match:{owner}},{$sort:{createdAt:1,_id:1}},{$group:{_id:{$cond:[{$in:['$sessionId',[null,'']]},'dashboard',{$ifNull:['$sessionId','dashboard']}]},title:{$first:'$command'},createdAt:{$first:'$createdAt'},updatedAt:{$max:'$updatedAt'},lastCommand:{$last:'$command'},state:{$last:'$state'},messageCount:{$sum:1}}},{$sort:{updatedAt:-1}},{$limit:100},{$project:{title:{$substrCP:[{$ifNull:['$title','Untitled chat']},0,100]},createdAt:1,updatedAt:1,state:1,messageCount:1}}]);},
 async messages(owner,sessionId,before){
  const query={owner,sessionId:sessionId==='dashboard'?{$in:[sessionId,null,'']}:sessionId};
  if(before){const anchor=await Task.findOne({...query,_id:before}).select('createdAt').lean();if(!anchor)return null;query.$or=[{createdAt:{$lt:anchor.createdAt}},{createdAt:anchor.createdAt,_id:{$lt:anchor._id}}];}
  const rows=await Task.find(query).sort({createdAt:-1,_id:-1}).limit(31).select('sessionId requestId command state result error pending actions.id actions.name actions.state actions.error cancelRequested createdAt updatedAt').lean();
  const hasMore=rows.length>30;return {items:rows.slice(0,30).reverse(),hasMore};
 },
 list:owner=>Task.find({owner}).sort({createdAt:-1}).limit(100).select('owner sessionId requestId command source state error createdAt updatedAt cancelRequested').lean(),
 async lock(token){try{return await Control.findOneAndUpdate({_id:'worker',$or:[{leaseUntil:{$lt:new Date()}},{leaseToken:token},{leaseUntil:{$exists:false}}]},{$set:{leaseToken:token,leaseUntil:new Date(Date.now()+300000)}},{upsert:true,returnDocument:'after'}).lean();}catch(e){if(e.code===11000)return null;throw e;}},
 async unlock(token){await Control.updateOne({_id:'worker',leaseToken:token},{$set:{leaseUntil:new Date(0)}});},
 async claim(){const token=randomUUID();const task=await Task.findOneAndUpdate({cancelRequested:{$ne:true},$or:[{state:'QUEUED'},{state:'RUNNING',leaseUntil:{$lt:new Date()}}]},{$set:{state:'RUNNING',leaseToken:token,leaseUntil:new Date(Date.now()+300000)}},{sort:{createdAt:1},returnDocument:'after'}).lean();if(task)auditCounts.set(task,task.audit.length);return task;},
 async save(task){const {createdAt,updatedAt,cancelRequested,audit,pushPublishedVersion,...value}=task;const newAudit=audit.slice(auditCounts.get(task)??audit.length);const result=await Task.updateOne({_id:task._id,state:'RUNNING',leaseToken:task.leaseToken},{$set:{...value,leaseUntil:new Date(Date.now()+300000)},...(newAudit.length?{$push:{audit:{$each:newAudit}}}:{})});if(result.matchedCount!==1)throw new Error('Task lease lost.');auditCounts.set(task,audit.length);},
 async heartbeat(task){const result=await Task.findOneAndUpdate({_id:task._id,state:'RUNNING',leaseToken:task.leaseToken},{$set:{leaseUntil:new Date(Date.now()+300000)}},{returnDocument:'after'}).lean();if(!result)throw new Error('Task lease lost.');return result;},
 async approve(id,owner,digest){return Task.findOneAndUpdate({_id:id,owner,state:'AWAITING_APPROVAL','pending.digest':digest},{$set:{state:'QUEUED','pending.approved':true},$push:{audit:{at:new Date(),type:'APPROVED',actor:owner,digest}}},{returnDocument:'after'}).lean();},
 async cancel(id,owner){return Task.findOneAndUpdate({_id:id,owner,state:{$in:['QUEUED','RUNNING','AWAITING_APPROVAL']}},[{$set:{cancelRequested:true,state:{$cond:[{$eq:['$state','RUNNING']},'RUNNING','CANCELLED']},audit:{$concatArrays:[{$ifNull:['$audit',[]]},[{at:new Date(),type:'CANCEL_REQUESTED',actor:owner}]]}}}],{returnDocument:'after',updatePipeline:true}).lean();},
 async retry(id,owner){return Task.findOneAndUpdate({_id:id,owner,state:'FAILED','actions.state':{$nin:['UNCERTAIN','WRITING']}},{$set:{state:'QUEUED',error:'',cancelRequested:false},$push:{audit:{at:new Date(),type:'RETRY_REQUESTED',actor:owner}}},{returnDocument:'after'}).lean();},
 async control(){return await Control.findById('global').lean()||{paused:false};},
 async pause(paused,owner){return Control.findOneAndUpdate({_id:'global'},{$set:{paused,updatedBy:owner}},{upsert:true,returnDocument:'after'}).lean();},
 Task,Control,
};}
module.exports={createStore,Task,Control};
