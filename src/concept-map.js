const mongoose=require('mongoose');
const {z}=require('zod');
// Default toolbar of the Echo AI concept map. Visitors may still pick their own; this is what they see first.
const defaults={layout:'tree',shape:'curved',format:'groups'};
const settingsSchema=z.object({layout:z.enum(['tree','mirror','around','net']),shape:z.enum(['curved','elbow','straight']),format:z.enum(['groups','single','atoms'])}).strict();
const Model=mongoose.models.ConceptMapSettings||mongoose.model('ConceptMapSettings',new mongoose.Schema({_id:String,value:mongoose.Schema.Types.Mixed,updatedBy:String},{timestamps:true}));
const store={load:()=>Model.findById('default').lean(),save:(value,owner)=>Model.findOneAndUpdate({_id:'default'},{$set:{value,updatedBy:owner}},{upsert:true,new:true}).lean()};
const normalize=value=>{const parsed=settingsSchema.safeParse({...defaults,...value});return parsed.success?parsed.data:defaults;};
function registerConceptMap(app,{requireAdmin,repository=store}){
 app.get('/api/concept-map',async(_req,res)=>{try{res.set('Cache-Control','no-store').json({item:normalize((await repository.load())?.value)});}catch{res.json({item:defaults});}});
 app.put('/api/concept-map',requireAdmin,async(req,res)=>{const parsed=settingsSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'Choose a valid layout, line shape and branch format.'});try{const saved=await repository.save(parsed.data,req.user?.id||req.auth?.id||'admin');res.json({item:normalize(saved.value)});}catch{res.status(503).json({message:'Could not save the concept map settings.'});}});
}
module.exports={registerConceptMap,settingsSchema,defaults};
