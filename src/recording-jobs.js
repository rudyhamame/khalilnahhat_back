const {randomUUID}=require('node:crypto');
class LostRecordingLease extends Error { constructor(){super('Recording ownership changed');this.code='RECORDING_LEASE_LOST';} }
// Every durable update is fenced by a renewable owner token, including failure handling.
function recordingJobs(Model,{clock=Date.now,leaseMs=120000,heartbeatMs=30000}={}) {
 async function run(id,work){
  const token=randomUUID(),now=clock();
  const row=await Model.findOneAndUpdate({_id:id,deletedAt:null,$or:[{leaseUntil:{$lte:new Date(now)}},{leaseUntil:null}]},{$set:{leaseToken:token,leaseUntil:new Date(now+leaseMs)}},{new:true});
  if(!row)return {busy:true};
  let lost=false,renewing=false;
  const filter=()=>({_id:id,leaseToken:token,leaseUntil:{$gt:new Date(clock())}});
  const save=async values=>{
   if(lost)throw new LostRecordingLease();
   const result=await Model.updateOne(filter(),{$set:values});
   if(result.matchedCount!==1){lost=true;throw new LostRecordingLease();}
   Object.assign(row,values);return row;
  };
  const renew=async()=>{
   if(renewing||lost)return;renewing=true;
   try{await save({leaseUntil:new Date(clock()+leaseMs)});}catch{lost=true;}finally{renewing=false;}
  };
  const timer=setInterval(()=>void renew(),heartbeatMs);timer.unref?.();
  try{return await work({row,save,assert:async()=>{await save({leaseUntil:new Date(clock()+leaseMs)});}});}
  finally{clearInterval(timer);await Model.updateOne({_id:id,leaseToken:token},{$set:{leaseToken:'',leaseUntil:new Date(0)}}).catch(()=>{});}
 }
 return {run};
}
module.exports={recordingJobs,LostRecordingLease};
