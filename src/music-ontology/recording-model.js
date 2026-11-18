// The Recording collection: its own schema (no shared archive fields).
const mongoose=require('mongoose');
const contract=require('../../contracts/music-ontology.json');
const {Schema}=mongoose;
const credit={_id:false,artistId:{type:String,required:true}};
const schema=new Schema({
 externalId:{type:String,required:true,unique:true},
 name:{type:String,required:true,trim:true},
 description:{type:String,default:'',trim:true},
 workType:{type:String,index:true},
 status:{type:String,enum:contract.recordingStatuses,default:'DRAFT',index:true},
 atomCount:{type:Number,default:0},
 releaseDate:{type:String,default:''},
 durationMinutes:Number,
 audioUrl:{type:String,default:''},
 coverImage:{type:String,default:''},
 sampleStartSec:{type:Number,default:null},
 audioMetadata:{type:{_id:false,format:String,sizeBytes:Number},default:null},
 stems:{type:{_id:false,channels:[{_id:false,name:String,url:String}],duration:Number,splitAt:String},default:null},
 atoms:{type:[{_id:false,id:{type:String,required:true},name:{type:String,required:true},releaseYear:Number,
  audioRange:{type:{_id:false,startSec:Number,endSec:Number},default:undefined},
  sound:{type:{_id:false,musicianCredits:[{...credit,instrumentId:String}],bpms:{type:[Number],default:undefined},keys:{type:[String],default:undefined},rhythmIds:{type:[String],default:undefined},genreIds:[String]},default:undefined},
  lyrics:{type:{_id:false,languages:[{_id:false,languageId:{type:String,required:true},dialectIds:[String]}],vocalistCredits:[credit]},default:null}}],default:undefined},
 revision:{type:Number,default:1},
},{timestamps:true,strict:'throw'});
module.exports=mongoose.models.MusicRecording||mongoose.model('MusicRecording',schema,'musicrecordings');
