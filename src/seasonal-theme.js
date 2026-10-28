const mongoose=require('mongoose');
const {z}=require('zod');
const themeSchema=z.object({revision:z.number().int().min(0),enabled:z.boolean(),lights:z.boolean(),snow:z.boolean()}).strict();
const defaults={revision:0,enabled:false,lights:true,snow:false};
const Model=mongoose.models.SeasonalTheme||mongoose.model('SeasonalTheme',new mongoose.Schema({_id:String,value:mongoose.Schema.Types.Mixed,updatedBy:String},{timestamps:true}));
const store={load:()=>Model.findById('vp1').lean(),async save(value,owner){
 if(value.revision===0){try{return await Model.create({_id:'vp1',value:{...value,revision:1},updatedBy:owner});}catch(e){if(e.code===11000)return null;throw e;}}
 return Model.findOneAndUpdate({_id:'vp1','value.revision':value.revision},{$set:{value:{...value,revision:value.revision+1},updatedBy:owner}},{new:true}).lean();
}};
function registerSeasonalTheme(app,{requireAdmin,repository=store}){
 app.get('/api/seasonal-theme',async(_req,res)=>{try{res.set('Cache-Control','no-store').json({item:(await repository.load())?.value||{...defaults}});}catch{res.status(503).json({message:'Theme settings are temporarily unavailable.'});}});
 app.put('/api/seasonal-theme',requireAdmin,async(req,res)=>{const parsed=themeSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'Invalid seasonal theme settings.'});try{const saved=await repository.save(parsed.data,req.user?.id||req.auth?.id||'admin');if(!saved)return res.status(409).json({message:'Theme changed in another session. Reload before saving.'});res.json({item:saved.value});}catch{res.status(503).json({message:'Could not save seasonal theme settings.'});}});
}
module.exports={registerSeasonalTheme,themeSchema,defaults};
