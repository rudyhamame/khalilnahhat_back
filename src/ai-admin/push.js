const mongoose = require('mongoose');
const {createHash, randomUUID} = require('node:crypto');
const {GoogleAuth} = require('google-auth-library');
const {z} = require('zod');
const {failure} = require('./route-adapter');
const hash = value => createHash('sha256').update(value).digest('hex');
const Device = mongoose.models.EchoAdminDevice || mongoose.model('EchoAdminDevice',new mongoose.Schema({
 _id:String,owner:{type:String,index:true},sessionBinding:String,token:{type:String,select:false},tokenHash:{type:String,unique:true},active:Boolean,
},{timestamps:true}));
const Event = mongoose.models.EchoAdminPushEvent || mongoose.model('EchoAdminPushEvent',new mongoose.Schema({
 _id:String,owner:{type:String,index:true},taskId:String,state:String,version:String,
},{timestamps:true}));
const Delivery = mongoose.models.EchoAdminPushDelivery || mongoose.model('EchoAdminPushDelivery',new mongoose.Schema({
 _id:String,eventId:String,deviceId:String,state:String,attempts:{type:Number,default:0},nextAttemptAt:Date,leaseUntil:Date,leaseToken:String,
},{timestamps:true}));
Delivery.schema.index({state:1,nextAttemptAt:1});
const deviceInput=z.object({installationId:z.uuid(),token:z.string().min(20).max(4096),platform:z.literal('android')}).strict();
const states=['AWAITING_APPROVAL','COMPLETED','FAILED','CANCELLED'];
const versionFor=task=>`${task.state}:${task.pending?.digest||''}:${task.audit?.length||0}`;
const versionExpr={$concat:['$state',':',{$ifNull:['$pending.digest','']},':',{$toString:{$size:{$ifNull:['$audit',[]]}}}]};
function createPush({store,authorize,env=process.env,fetchImpl=fetch,accessToken}) {
 let auth;
 const credentials=()=>env.FCM_SERVICE_ACCOUNT_JSON?JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON):undefined;
 const project=()=>env.FCM_PROJECT_ID||credentials()?.project_id;
 const configured=()=>{try{return !!project()&&!!(env.FCM_SERVICE_ACCOUNT_JSON||env.GOOGLE_APPLICATION_CREDENTIALS);}catch{return false;}};
 const seedDelivery=async(event,device)=>Delivery.updateOne({_id:hash(event._id+':'+device._id)},{$setOnInsert:{eventId:event._id,deviceId:device._id,state:'PENDING',nextAttemptAt:new Date()}},{upsert:true});
 return {
  Device,Event,Delivery,configured,
  async init(){await Promise.all([Device.init(),Event.init(),Delivery.init()]);},
  async register(owner,actor,body){const data=deviceInput.parse(body);const current=await authorize(owner);if(!current||current.sessionToken!==actor?.sessionToken)throw failure(403,'Administrator authorization required.');if(!actor?.sessionToken)throw failure(403,'An active administrator session is required.');const old=await Device.findById(data.installationId).lean();if(old&&old.owner!==owner)throw failure(409,'This installation belongs to another account. Revoke its registration first.');try{await Device.findOneAndUpdate({_id:data.installationId},{$set:{owner,sessionBinding:hash(actor.sessionToken),token:data.token,tokenHash:hash(data.token),active:true}},{upsert:true,returnDocument:'after'});}catch(e){if(e.code===11000)throw failure(409,'This push token is already registered to another installation.');throw e;}const device=await Device.findById(data.installationId).lean();const events=await Event.find({owner,createdAt:{$gte:new Date(Date.now()-86400000)}}).limit(100).lean();for(const event of events)await seedDelivery(event,device);return {installationId:data.installationId,enabled:true,providerConfigured:configured()};},
  async revoke(owner,id){if(!z.uuid().safeParse(id).success)throw failure(400,'Invalid installation.');await Device.updateOne({_id:id,owner},{$set:{active:false},$unset:{token:1}});return {enabled:false};},
  async publish(){const tasks=await store.Task.find({state:{$in:states},$expr:{$ne:[{$ifNull:['$pushPublishedVersion','']},versionExpr]}}).sort({updatedAt:1}).limit(50).lean();for(const task of tasks){const version=versionFor(task),eventId=hash(task._id+':'+version);await Event.updateOne({_id:eventId},{$setOnInsert:{owner:task.owner,taskId:task._id,state:task.state,version}},{upsert:true});const event=await Event.findById(eventId).lean();for(const device of await Device.find({owner:task.owner,active:true}).lean())await seedDelivery(event,device);await store.Task.updateOne({_id:task._id,state:task.state,$expr:{$eq:[{$size:{$ifNull:['$audit',[]]}},task.audit?.length||0]}},{$set:{pushPublishedVersion:version}},{timestamps:false});}},
  async tick(){await this.publish();if(!configured())return;for(let i=0;i<25;i++){const leaseToken=randomUUID();const delivery=await Delivery.findOneAndUpdate({$or:[{state:{$in:['PENDING','RETRY']},nextAttemptAt:{$lte:new Date()}},{state:'SENDING',leaseUntil:{$lt:new Date()}}]},{$set:{state:'SENDING',leaseToken,leaseUntil:new Date(Date.now()+60000)},$inc:{attempts:1}},{sort:{createdAt:1},returnDocument:'after'}).lean();if(!delivery)break;
   try{const event=await Event.findById(delivery.eventId).lean(),device=await Device.findById(delivery.deviceId).select('+token').lean();const actor=device?.active&&event?.owner===device.owner?await authorize(device.owner):null;if(!event||!device?.token||!actor||hash(actor.sessionToken)!==device.sessionBinding){await Delivery.updateOne({_id:delivery._id,leaseToken},{$set:{state:'SKIPPED'}});continue;}
    // Approval notifications are only useful while that exact approval remains pending.
    const task=await store.get(event.taskId);if(!task||task.owner!==event.owner||(event.state==='AWAITING_APPROVAL'&&versionFor(task)!==event.version)){await Delivery.updateOne({_id:delivery._id,leaseToken},{$set:{state:'SKIPPED'}});continue;}
    if(!auth)auth=new GoogleAuth({credentials:credentials(),scopes:['https://www.googleapis.com/auth/firebase.messaging']});const token=accessToken?await accessToken():await auth.getAccessToken();
    const response=await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project())}/messages:send`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({message:{token:device.token,data:{type:'echo_admin_task',taskId:event.taskId,state:event.state,eventId:event._id,sessionBinding:device.sessionBinding},android:{priority:'HIGH',ttl:'86400s',restricted_package_name:'ca.echo.dj'}}}),signal:AbortSignal.timeout(20000)});
    const result=await response.json().catch(()=>({}));if(!response.ok){if(result.error?.details?.some(item=>item.errorCode==='UNREGISTERED')){await Device.updateOne({_id:device._id,tokenHash:device.tokenHash},{$set:{active:false},$unset:{token:1}});await Delivery.updateOne({_id:delivery._id,leaseToken},{$set:{state:'SKIPPED'}});continue;}throw Error('Push delivery failed');}
    await Delivery.updateOne({_id:delivery._id,leaseToken},{$set:{state:'SENT'}});
   }catch{await Delivery.updateOne({_id:delivery._id,leaseToken},{$set:{state:'RETRY',nextAttemptAt:new Date(Date.now()+Math.min(3600000,5000*2**Math.min(delivery.attempts,9)))}});}
  }},
 };
}
module.exports={createPush,hash,deviceInput,versionFor};
