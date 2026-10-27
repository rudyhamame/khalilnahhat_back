const {createOpenRouter}=require('./openrouter');
const mongoose=require('mongoose');
const {z}=require('zod');
const crypto=require('node:crypto');
const CHECKED='2026-10-27';
const catalog=[
 {id:'gpt-4o-mini',mode:'chat',label:'GPT-4o Mini',deprecated:true,rates:{textInput:0.15,textCached:0.075,textOutput:0.6}},
 {id:'gpt-4.1-mini',mode:'chat',label:'GPT-4.1 Mini',deprecated:true,rates:{textInput:0.4,textCached:0.1,textOutput:1.6}},
 {id:'gpt-5.6-luna',mode:'chat',label:'GPT-5.6 Luna',rates:{textInput:0.2,textCached:0.02,textOutput:1.2}},
 {id:'gpt-realtime-2.1-mini',mode:'voice',label:'GPT-Realtime-2.1 Mini',rates:{textInput:0.6,textCached:0.06,textOutput:2.4,audioInput:10,audioCached:0.3,audioOutput:20}},
 {id:'gpt-realtime-2.1',mode:'voice',label:'GPT-Realtime-2.1',rates:{textInput:4,textCached:0.4,textOutput:24,audioInput:32,audioCached:0.4,audioOutput:64}},
].map(item=>({...item,provider:'openai',checkedOn:CHECKED,source:`https://developers.openai.com/api/docs/models/${item.id}`}));
const money=z.number().finite().min(0).max(100000);
const rates=z.object({textInput:money,textCached:money,textOutput:money,audioInput:money.optional(),audioCached:money.optional(),audioOutput:money.optional()}).strict();
const modeSchema=kind=>z.object({enabled:z.boolean(),model:z.string().trim().min(1).max(200).refine(id=>kind==='chat'||catalog.some(item=>item.mode===kind&&item.id===id),'Choose a supported model for this mode.'),providerRates:rates,maxOutputTokens:z.number().int().min(256).max(4096),requestsPer10Min:z.number().int().min(1).max(kind==='chat'?200:20)}).strict();
const configSchema=z.object({revision:z.number().int().min(0),chat:modeSchema('chat').extend({provider:z.enum(['openai','openrouter']).default('openai'),freeOnly:z.boolean().default(true)}),voice:modeSchema('voice').extend({maxCallSeconds:z.number().int().min(30).max(900)}),customerPricing:z.object({policy:z.enum(['included','manual_invoice']),currency:z.enum(['CAD','USD']),chatReplyCents:z.number().int().min(0).max(100000),voiceSessionCents:z.number().int().min(0).max(100000)}).strict()}).strict().superRefine((config,ctx)=>{
 for(const mode of ['chat','voice']){
  const r=config[mode].providerRates;
  if(r.textCached>r.textInput)ctx.addIssue({code:'custom',path:[mode,'providerRates','textCached'],message:'Cached input rate cannot exceed input rate.'});
  if(mode==='voice'&&['audioInput','audioCached','audioOutput'].some(key=>r[key]===undefined))ctx.addIssue({code:'custom',path:['voice','providerRates'],message:'All voice audio rates are required.'});
  if(mode==='voice'&&r.audioCached>r.audioInput)ctx.addIssue({code:'custom',path:['voice','providerRates','audioCached'],message:'Cached audio rate cannot exceed input rate.'});
 }
});
function defaults(env=process.env){
 const chatProvider=env.OPENROUTER_API_KEY?'openrouter':'openai';
 const chatModel=chatProvider==='openrouter'?'openrouter/free':env.OPENAI_BOOKING_CHAT_MODEL||'gpt-4o-mini',voiceModel=env.OPENAI_BOOKING_VOICE_MODEL||'gpt-realtime-2.1-mini';
 const entry=(mode,id)=>catalog.find(item=>item.mode===mode&&item.id===id)||catalog.find(item=>item.mode===mode);
 return {revision:0,chat:{provider:chatProvider,freeOnly:true,enabled:true,model:chatModel,providerRates:chatProvider==='openrouter'?{textInput:0,textCached:0,textOutput:0}:{...entry('chat',chatModel).rates},maxOutputTokens:chatProvider==='openrouter'?4096:2400,requestsPer10Min:20},voice:{enabled:true,model:voiceModel,providerRates:{...entry('voice',voiceModel).rates},maxOutputTokens:1200,requestsPer10Min:3,maxCallSeconds:300},customerPricing:{policy:'included',currency:'CAD',chatReplyCents:0,voiceSessionCents:0}};
}
const configModel=mongoose.models.EchoAiConfiguration||mongoose.model('EchoAiConfiguration',new mongoose.Schema({_id:String,value:mongoose.Schema.Types.Mixed,updatedBy:String},{timestamps:true}));
const usageModel=mongoose.models.EchoAiUsage||mongoose.model('EchoAiUsage',new mongoose.Schema({_id:String,owner:{type:String,index:true},mode:String,model:String,revision:Number,state:String,billingStatus:String,customerCents:Number,currency:String,providerUsdEstimate:{type:Number,default:null},metrics:mongoose.Schema.Types.Mixed,invoiceId:String,reference:String,paymentMethod:String,updatedBy:String},{timestamps:true}));
usageModel.schema.index({createdAt:-1});
const mongoStore={
 getConfig:()=>configModel.findById('echo-ai').lean(),
 async saveConfig(value,updatedBy){
  if(!value.revision){try{return await configModel.create({_id:'echo-ai',value:{...value,revision:1},updatedBy});}catch(error){if(error.code===11000)return null;throw error;}}
  return configModel.findOneAndUpdate({_id:'echo-ai','value.revision':value.revision},{$set:{value:{...value,revision:value.revision+1},updatedBy}},{new:true}).lean();
 },
 async reserve(item){
  try{return await usageModel.create(item);}catch(error){if(error.code!==11000)throw error;}
  return usageModel.findOneAndUpdate({_id:item._id,owner:item.owner,state:'failed'},{$set:{...item}},{new:true}).lean();
 },
 complete:(id,value)=>usageModel.findOneAndUpdate({_id:id,state:'pending'},{$set:{...value,state:'completed'}},{new:true}).lean(),
 fail:id=>usageModel.updateOne({_id:id,state:'pending'},{$set:{state:'failed',customerCents:0,billingStatus:'included'}}),
 updateMetrics:(id,metrics)=>usageModel.updateOne({_id:id},{$set:{metrics}}),
 listUsage:()=>usageModel.find().sort({createdAt:-1}).limit(100).lean(),
 async billing(id,owner,action){return usageModel.findOneAndUpdate({_id:id,invoiceId:{$exists:false},state:'completed',billingStatus:{$in:action.status==='paid'?['invoiced']:['unbilled','invoiced']}},{$set:{billingStatus:action.status,reference:action.reference,paymentMethod:action.paymentMethod||'',updatedBy:owner}},{new:true}).lean();},
};
const error=(status,message)=>Object.assign(new Error(message),{status});
function providerEstimate(config,mode,metrics){
 if(mode==='voice'||!Number.isInteger(metrics.inputTokens)||!Number.isInteger(metrics.outputTokens))return null;
 const r=config.chat.providerRates,cached=Math.min(metrics.inputTokens,Math.max(0,metrics.cachedInputTokens||0));
 return Number((((metrics.inputTokens-cached)*r.textInput+cached*r.textCached+metrics.outputTokens*r.textOutput)/1e6).toFixed(8));
}
function createAiConfiguration({store=mongoStore,env=process.env,fetchImpl=fetch}={}){
 const openrouter=createOpenRouter({env,fetchImpl});
 let cached=null,until=0,inflight=null;
 const load=async()=>{if(cached&&Date.now()<until)return structuredClone(cached);if(!inflight)inflight=store.getConfig().then(item=>{const value=item?.value||defaults(env);cached={...value,chat:{provider:'openai',freeOnly:true,...value.chat}};until=Date.now()+5000;return cached;}).finally(()=>{inflight=null;});return structuredClone(await inflight);};
 return {
  load,
  async describe(){let extra=[],catalogError='';try{extra=await openrouter.models();}catch{catalogError='OpenRouter catalog unavailable. Reload to retry.';}return {item:await load(),catalog:[...catalog,...extra],providers:{openai:{configured:Boolean(env.OPENAI_API_KEY)},openrouter:{configured:Boolean(env.OPENROUTER_API_KEY)}},catalogError};},
  async save(body,owner){
   const parsed=configSchema.safeParse(body);if(!parsed.success)throw error(400,parsed.error.issues[0]?.message||'Invalid AI configuration.');
   const old=await load();if(old.revision!==body.revision)throw error(409,'Configuration changed. Reload before saving.');
   if(parsed.data.chat.provider==='openrouter'){
    const model=await openrouter.validate(parsed.data.chat);
    parsed.data.chat.providerRates={...model.rates};
    if(parsed.data.chat.enabled&&!openrouter.configured())throw error(503,'Configure OPENROUTER_API_KEY in Render before enabling OpenRouter.');
   }else if(!catalog.some(item=>item.mode==='chat'&&item.id===parsed.data.chat.model))throw error(400,'Choose a supported OpenAI chat model.');
   for(const mode of ['chat','voice']){
    if(mode==='chat'&&parsed.data.chat.provider==='openrouter')continue;
    const model=catalog.find(item=>item.mode===mode&&item.id===parsed.data[mode].model);
    parsed.data[mode].providerRates={...model.rates};
   }
   for(const mode of ['chat','voice'])if(!(mode==='chat'&&parsed.data.chat.provider==='openrouter')&&parsed.data[mode].enabled&&(old[mode].model!==body[mode].model||(old[mode].provider||'openai')!==(parsed.data[mode].provider||'openai')||!old.revision)){
    if(!env.OPENAI_API_KEY)throw error(503,'Configure the provider API key on the server before enabling a model.');
    const response=await fetchImpl(`https://api.openai.com/v1/models/${encodeURIComponent(body[mode].model)}`,{headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw error(400,`The configured OpenAI account cannot access ${body[mode].model}.`);
   }
   const item=await store.saveConfig(parsed.data,owner);if(!item)throw error(409,'Configuration changed. Reload before saving.');
   cached=item.value;until=Date.now()+5000;return structuredClone(cached);
  },
  async reserve({owner,mode,requestId,config,pricingConsentRevision}){
   const fee=config.customerPricing.policy==='manual_invoice'?config.customerPricing[mode==='chat'?'chatReplyCents':'voiceSessionCents']:0;
   if(fee&&pricingConsentRevision!==config.revision)throw error(402,'Review and accept the current AI price before continuing.');
   if(fee&&!z.uuid().safeParse(requestId).success)throw error(400,'A unique request ID is required for paid AI usage.');
   const id=crypto.createHash('sha256').update(`${owner}:${mode}:${requestId||crypto.randomUUID()}`).digest('hex');
   const item=await store.reserve({_id:id,owner,mode,model:config[mode].model,revision:config.revision,state:'pending',billingStatus:'included',customerCents:0,currency:config.customerPricing.currency});
   if(!item)throw error(409,'This AI request already started. Check your conversation before retrying.');
   return {id,fee,config,mode};
  },
  async complete(ticket,metrics={},billable=true){
   const result=await store.complete(ticket.id,{metrics,providerUsdEstimate:providerEstimate(ticket.config,ticket.mode,metrics),customerCents:billable?ticket.fee:0,billingStatus:billable&&ticket.fee?'unbilled':'included'});
   if(!result)throw error(503,'AI usage could not be recorded. Please retry.');
  },
  fail:ticket=>store.fail(ticket.id),
  updateMetrics:(ticket,metrics)=>store.updateMetrics(ticket.id,metrics),
  async listUsage(){return (await store.listUsage()).map(item=>({id:item._id,owner:item.owner,mode:item.mode,model:item.model,state:item.state,billingStatus:item.billingStatus,customerCents:item.customerCents,currency:item.currency,providerUsdEstimate:item.providerUsdEstimate??null,createdAt:item.createdAt,reference:item.reference||'',metrics:item.metrics||{}}));},
  async billing(id,owner,body){
   const parsed=z.object({status:z.enum(['invoiced','paid','void']),reference:z.string().trim().min(1).max(200),paymentMethod:z.enum(['etransfer','cheque','bank_transfer','other']).optional()}).strict().safeParse(body);
   if(!parsed.success||body.status==='paid'&&!body.paymentMethod)throw error(400,'Enter a reference and a payment method when recording payment.');
   const result=await store.billing(id,owner,parsed.data);if(!result)throw error(409,'This usage entry cannot make that billing transition.');return result;
  },
 };
}
function publicPolicy(config){return {revision:config.revision,chat:{enabled:config.chat.enabled,model:config.chat.model,provider:config.chat.provider||'openai'},voice:{enabled:config.voice.enabled,model:config.voice.model},customerPricing:config.customerPricing};}
function registerAiConfiguration(app,{requireAdmin,service}){
 const guarded=handler=>async(req,res)=>{res.set('Cache-Control','no-store');try{await handler(req,res);}catch(e){res.status([400,402,409,503].includes(e.status)?e.status:503).json({message:e.status?e.message:'AI configuration is temporarily unavailable.'});}};
 app.get('/api/ai-booking/admin/config',requireAdmin,guarded(async(_req,res)=>res.json(await service.describe())));
 app.put('/api/ai-booking/admin/config',requireAdmin,guarded(async(req,res)=>res.json({item:await service.save(req.body,String(req.user?._id||req.authUser?.id||''))})));
 app.get('/api/ai-booking/admin/usage',requireAdmin,guarded(async(_req,res)=>res.json({items:await service.listUsage()})));
 app.patch('/api/ai-booking/admin/usage/:id',requireAdmin,guarded(async(req,res)=>{if(!/^[a-f0-9]{64}$/.test(req.params.id))throw error(400,'Invalid usage entry.');await service.billing(req.params.id,String(req.user?._id||req.authUser?.id||''),req.body);res.json({ok:true});}));
}
module.exports={usageModel,catalog,configSchema,defaults,publicPolicy,providerEstimate,createAiConfiguration,registerAiConfiguration};
