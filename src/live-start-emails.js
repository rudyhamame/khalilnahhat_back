const mongoose = require('mongoose');
const { sessionKey } = require('./live-interactions');
const { notificationEmails } = require('./notification-emails');
const { sendSimpleEmail } = require('./brevo');
const { User, LiveStreamConfig } = require('./models');
const { defaultLiveStreamConfig } = require('./default-data');
const Campaign = mongoose.models.LiveEmailCampaign || mongoose.model('LiveEmailCampaign', new mongoose.Schema({
 _id:String, title:String, goal:String, actionUrl:String, cutoff:Date, audienceReady:{type:Boolean,default:false},
},{timestamps:true}));
const Delivery = mongoose.models.LiveEmailDelivery || mongoose.model('LiveEmailDelivery',new mongoose.Schema({
 _id:String,campaignId:{type:String,index:true},userId:mongoose.Schema.Types.ObjectId,state:{type:String,default:'pending',index:true},attemptedAt:Date,
},{timestamps:true}));
const goals={broadcast:'Broadcast',event:'DJing in an Event','home-studio':'DJing in Home Studio','chill-mix':'Chilling-out Mix Time',radio:'Echo Radio Music'};
let busy=false;
async function tick(){
 if(busy||mongoose.connection.readyState!==1)return;
 if(!process.env.BREVO_API_KEY?.trim()||!process.env.EMAIL_FROM_ADDRESS?.trim())return;
 busy=true;
 try{
  for(const campaign of await Campaign.find({audienceReady:false}).limit(5).lean()){
   // Unique recipient IDs let enumeration resume safely after a restart.
   const cursor=User.find({emailVerified:true,isBlocked:{$ne:true},createdAt:{$lte:campaign.cutoff}}).select('_id').lean().cursor();
   for await(const user of cursor)await Delivery.updateOne({_id:`${campaign._id}:${user._id}`},{$setOnInsert:{campaignId:campaign._id,userId:user._id,state:'pending'}},{upsert:true});
   await Campaign.updateOne({_id:campaign._id},{$set:{audienceReady:true}});
  }
  const rule=await notificationEmails.get('live-started');
  if(!rule.enabled){await Delivery.updateMany({state:'pending'},{$set:{state:'disabled'}});return;}
  for(let i=0;i<20;i++){
   // A delivery is claimed before sending, so concurrent workers and reconnects cannot duplicate it.
   // Ambiguous provider failures stay failed for review instead of automatically sending twice.
   const delivery=await Delivery.findOneAndUpdate({state:'pending'},{$set:{state:'sending',attemptedAt:new Date()}},{new:true}).lean();
   if(!delivery)break;
   try{
    const [campaign,user]=await Promise.all([Campaign.findById(delivery.campaignId).lean(),User.findOne({_id:delivery.userId,emailVerified:true,isBlocked:{$ne:true}}).lean()]);
    const current=await LiveStreamConfig.findOne({key:defaultLiveStreamConfig.key}).lean();
    if(!campaign||!user||sessionKey(current)!==campaign._id){await Delivery.updateOne({_id:delivery._id},{$set:{state:'skipped'}});continue;}
    const result=await sendSimpleEmail({to:user.email,name:user.firstName||user.username||'Member',tags:['live-started'],subject:'DJ Khalil is live',html:'',notificationContext:{liveTitle:campaign.title,liveGoal:campaign.goal,actionUrl:campaign.actionUrl}});
    await Delivery.updateOne({_id:delivery._id},{$set:{state:result.sent?'sent':result.disabled?'disabled':'failed'}});
   }catch(error){await Delivery.updateOne({_id:delivery._id},{$set:{state:'failed'}});console.error('Live announcement delivery failed:',error.name);}
  }
 }catch(error){console.error('Live announcement queue failed:',error.name);}finally{busy=false;}
}
async function notifyLiveTransition(previous,next){
 const id=sessionKey(next);
 if(!id||sessionKey(previous)===id)return;
 try{
  if(!(await notificationEmails.get('live-started')).enabled)return;
  const actionUrl=(process.env.FRONTEND_URL||process.env.PUBLIC_APP_URL||'https://djkhalilnahhat.ca').replace(/\/+$/,'')+'/';
  await Campaign.updateOne({_id:id},{$setOnInsert:{title:next.title||'Live with DJ Khalil',goal:goals[next.goal]||goals.broadcast,actionUrl,cutoff:new Date(),audienceReady:false}},{upsert:true});
  void tick();
 }catch(error){console.error('Could not queue live announcement:',error.name);}
}
const timer=setInterval(()=>void tick(),15000);timer.unref();
module.exports={notifyLiveTransition};
