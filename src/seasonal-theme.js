const mongoose=require('mongoose');
const {z}=require('zod');
const {publicSongs}=require('./music-archive');
const {isArchiveAudio}=require('./archive-player');
const audioSchema=z.object({enabled:z.boolean(),archiveIds:z.array(z.string().trim().min(1).max(120)).max(3).refine(ids=>new Set(ids).size===ids.length,'Choose each recording only once.')}).strict().refine(value=>!value.enabled||value.archiveIds.length>0,'Choose a recording before enabling Christmas audio.');
const defaults={revision:0,enabled:false,lights:true,snow:false,audio:{enabled:false,archiveIds:[]}};
const themeSchema=z.object({revision:z.number().int().min(0),enabled:z.boolean(),lights:z.boolean(),snow:z.boolean(),audio:audioSchema.default(defaults.audio)}).strict();
const normalize=value=>({...defaults,...value,audio:{...defaults.audio,...value?.audio}});
const Model=mongoose.models.SeasonalTheme||mongoose.model('SeasonalTheme',new mongoose.Schema({_id:String,value:mongoose.Schema.Types.Mixed,updatedBy:String},{timestamps:true}));
const store={load:()=>Model.findById('vp1').lean(),async save(value,owner){
 if(value.revision===0){try{return await Model.create({_id:'vp1',value:{...value,revision:1},updatedBy:owner});}catch(e){if(e.code===11000)return null;throw e;}}
 return Model.findOneAndUpdate({_id:'vp1','value.revision':value.revision},{$set:{value:{...value,revision:value.revision+1},updatedBy:owner}},{new:true}).lean();
}};
function registerSeasonalTheme(app,{requireAdmin,repository=store,listRecordings=publicSongs}){
 app.get('/api/seasonal-theme',async(_req,res)=>{try{res.set('Cache-Control','no-store').json({item:normalize((await repository.load())?.value)});}catch{res.status(503).json({message:'Theme settings are temporarily unavailable.'});}});
 app.put('/api/seasonal-theme',requireAdmin,async(req,res)=>{const parsed=themeSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:parsed.error.issues[0]?.message||'Invalid seasonal theme settings.'});try{if(parsed.data.audio.archiveIds.length){const rows=await listRecordings();const allowed=new Set(rows.filter(row=>isArchiveAudio(row.audioUrl)).map(row=>row.externalId));if(parsed.data.audio.archiveIds.some(id=>!allowed.has(id)))return res.status(400).json({message:'Choose published audio recordings from the Music Archive. Refresh the list if a recording was removed or unpublished.'});}const saved=await repository.save(parsed.data,req.user?.id||req.auth?.id||'admin');if(!saved)return res.status(409).json({message:'Theme changed in another session. Reload before saving.'});res.json({item:normalize(saved.value)});}catch{res.status(503).json({message:'Could not save seasonal theme settings.'});}});
}
module.exports={registerSeasonalTheme,themeSchema,defaults};
