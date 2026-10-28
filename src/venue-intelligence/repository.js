const mongoose=require('mongoose');
const schema=new mongoose.Schema({_id:String,owner:{type:String,required:true,index:true},key:{type:String,required:true},report:mongoose.Schema.Types.Mixed,manual:{type:mongoose.Schema.Types.Mixed,default:null},history:{type:[mongoose.Schema.Types.Mixed],default:[]},version:{type:Number,default:1}},{timestamps:true});schema.index({owner:1,key:1},{unique:true});
const Model=mongoose.models.VenueIntelligence||mongoose.model('VenueIntelligence',schema);
const mongoRepository={
 find:(owner,key)=>Model.findOne({owner,key}).lean(),
 get:(owner,id)=>Model.findOne({owner,_id:id}).lean(),
 list:owner=>Model.find({owner}).select('_id report.venue report.researchedAt report.measurementStatus report.simulation manual version').sort({updatedAt:-1}).limit(30).lean(),
 async save(owner,key,report){const existing=await Model.findOne({owner,key}).lean();const update={$set:{report},$inc:{version:1},$setOnInsert:{_id:require('node:crypto').randomUUID(),owner,key}};if(existing?.report)update.$push={history:{$each:[existing.report],$slice:-5}};return Model.findOneAndUpdate({owner,key},update,{new:true,upsert:true}).lean();},
 manual:(owner,id,version,manual)=>Model.findOneAndUpdate({owner,_id:id,version},{$set:{manual},$inc:{version:1}},{new:true}).lean(),
};
module.exports={mongoRepository};
