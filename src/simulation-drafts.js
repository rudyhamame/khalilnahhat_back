const mongoose = require('mongoose');
const { z } = require('zod');
const { Equipment } = require('./equipment');
const point = z.tuple([z.number().min(-200).max(200), z.number().min(-200).max(200)]);
const ring = z.array(point).min(3).max(2000);
const layoutSchema = z.object({
  name: z.string().trim().min(1).max(160).default('Venue layout'),
  widthM: z.number().min(3).max(200).default(10),
  depthM: z.number().min(3).max(200).default(8),
  guestCount: z.number().int().min(0).max(100000).default(0),
  lights: z.boolean().default(true), party: z.boolean().default(false), grid: z.boolean().default(false),
  equipment: z.array(z.object({id:z.string().min(1).max(160),quantity:z.number().int().min(1).max(10000)}).strict()).max(100).default([]),
  positions: z.record(z.string().min(1).max(200), z.object({x:z.number().min(-200).max(200),z:z.number().min(-200).max(200),rotation:z.number().min(-1000).max(1000)}).strict()).refine(value=>Object.keys(value).length<=200,'Too many equipment positions.').default({}),
  boundary: ring.nullable().default(null), holes: z.array(ring).max(30).default([]),
  sourceNote: z.string().trim().max(1000).default('Concept layout; not a venue survey.'),
}).strict();
const Model = mongoose.models.SimulationDraft || mongoose.model('SimulationDraft',new mongoose.Schema({_id:String,version:Number,layout:mongoose.Schema.Types.Mixed},{timestamps:true}));
const view = row => row ? {version:row.version,layout:row.layout,updatedAt:row.updatedAt} : null;
function registerSimulationDrafts(app,{requireAuth}) {
  const base='/api/ai-booking/simulation-draft';
  const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res,String(req.authUser._id));}catch(error){res.status(error instanceof z.ZodError?400:503).json({message:error instanceof z.ZodError?error.issues[0].message:'Simulation draft could not be saved or loaded.'});}};
  app.get(base,requireAuth,wrap(async(_req,res,owner)=>res.json({item:view(await Model.findById(owner).lean())})));
  app.put(base,requireAuth,wrap(async(req,res,owner)=>{
    const body=z.object({version:z.number().int().nonnegative(),layout:layoutSchema}).strict().parse(req.body);
    const ids=[...new Set(body.layout.equipment.map(item=>item.id))];
    if(ids.length!==body.layout.equipment.length||await Equipment.countDocuments({slug:{$in:ids}})!==ids.length)return res.status(400).json({message:'Choose distinct existing equipment items.'});
    let saved;
    if(body.version===0){try{saved=await Model.create({_id:owner,version:1,layout:body.layout});}catch(error){if(error.code!==11000)throw error;}}
    else saved=await Model.findOneAndUpdate({_id:owner,version:body.version},{$set:{layout:body.layout},$inc:{version:1}},{returnDocument:'after'}).lean();
    if(!saved)return res.status(409).json({message:'Simulation changed in another session. Load it before saving.'});
    res.json({item:view(saved)});
  }));
}
module.exports={registerSimulationDrafts,layoutSchema,Model};
