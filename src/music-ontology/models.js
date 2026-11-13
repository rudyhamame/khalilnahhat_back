const mongoose=require('mongoose');
const contract=require('../../contracts/music-ontology.json');
const {Schema}=mongoose;
const model=(name,fields,indexes=[])=>{
 const schema=new Schema({externalId:{type:String,required:true,unique:true},revision:{type:Number,default:1},...fields},{timestamps:true,strict:'throw'});
 indexes.forEach(index=>schema.index(...index));
 return mongoose.models[name]||mongoose.model(name,schema);
};
const credit={_id:false,artistId:{type:String,required:true},role:{type:String,enum:contract.creditRoles,required:true},detail:String};
const state={type:String,enum:contract.metadataStates,default:'MISSING'};
const provenance={_id:false,source:String,note:String,recordedBy:String};
const Melody=model('MusicMelody',{bpm:Number,key:String,rhythmId:String,genreIds:[String],instrumentIds:[String],musicianCredits:[{...credit,role:{type:String,enum:contract.musicianRoles,required:true}}],timeSignature:String,mode:String,description:String,influences:[String],states:{type:Map,of:state},provenance});
const Lyrics=model('MusicLyrics',{languageId:String,languageIds:[String],dialectId:String,regionIds:[String],artistCredits:[credit],releaseYear:Number,script:String,translationRefs:[String],states:{type:Map,of:state},provenance});
const Work=model('MusicalWork',{title:{type:String,required:true},type:{type:String,enum:contract.workTypes,required:true},lyricsId:String,melodyId:{type:String,required:true},credits:[credit],description:String,workKind:{type:String,default:'ORIGINAL'},provenance},[[{type:1,title:1},{}]]);
const Vocabulary=model('MusicVocabulary',{archived:{type:Boolean,default:false},languageIds:{type:[String],default:[]},instrumentIds:{type:[String],default:[]},kind:{type:String,enum:contract.vocabularyKinds,required:true},instrumentId:String,name:{type:String,required:true},normalizedName:{type:String,required:true},parentId:{type:String,default:''},isoCode:String,description:String,provenance},[[{kind:1,normalizedName:1,parentId:1},{unique:true}],[{kind:1,isoCode:1},{unique:true,partialFilterExpression:{isoCode:{$gt:''}}}]]);
const DjWorkType=model('DjWorkType',{languageIds:{type:[String],default:[]},artworkUrl:{type:String,default:''},name:{type:String,required:true},nameArabic:{type:String,default:''},normalizedName:{type:String,required:true},amount:{type:String,enum:contract.recordingAmounts,required:true},details:{type:String,default:''},detailsArabic:{type:String,default:''},sample:{type:{recordingId:{type:String,required:true},startSec:{type:Number,required:true,min:0}},default:null,_id:false},sortOrder:{type:Number,default:0}},[[{normalizedName:1},{unique:true}]]);
const DjWorkTypeSeed=model('DjWorkTypeSeed',{});
const AudioAsset=model('MusicAudioAsset',{url:{type:String,required:true,unique:true},mime:String,durationSeconds:Number,originalName:String,provenance});
const Version=model('MusicRecordingVersion',{recordingId:{type:String,index:true,required:true},number:Number,snapshot:Schema.Types.Mixed,changedBy:String},[[{recordingId:1,number:1},{unique:true}]]);
const itemCredit={_id:false,artistId:{type:String,required:true},detail:String};
const RecordingFields={
 audioMetadata:{type:{_id:false,format:String,sizeBytes:Number,trimmed:Boolean},default:null},
 languages:{type:{_id:false,languageIds:[String],dialectIds:[String]},default:null},
 musical:{type:{_id:false,bpm:Number,bpms:[Number],key:String,rhythmId:String,keys:[String],rhythmIds:[String],genreIds:[String],influences:[String]},default:null},
 recordingCredits:{type:{_id:false,vocalists:[{_id:false,artistId:String,detail:String}],musicians:[{_id:false,artistId:String,instrumentId:String,detail:String}]},default:null},
 stems:{type:{_id:false,channels:[{_id:false,name:String,url:String}],duration:Number,splitAt:String},default:null},
 items:{type:[{_id:false,id:{type:String,required:true},audioRange:{type:{_id:false,startSec:Number,endSec:Number},default:undefined},name:{type:String,required:true},releaseYear:Number,releaseDate:String,hasLyrics:{type:Boolean,required:true},sound:{type:{_id:false,bpm:Number,bpms:{type:[Number],default:undefined},key:String,rhythmId:String,keys:{type:[String],default:undefined},rhythmIds:{type:[String],default:undefined},genreIds:[String],influences:[String]},default:undefined},musicianCredits:[{...itemCredit,instrumentId:String}],lyrics:{type:{_id:false,languageId:String,dialectId:String,languageIds:{type:[String],default:undefined},dialectIds:{type:[String],default:undefined},startSec:Number,endSec:Number,vocalistCredits:[itemCredit]},default:null}}],default:undefined},
 sampleStartSec:{type:Number,default:null},recordingType:{type:String,index:true},workId:{type:String,index:true},recordingAmount:{type:String,enum:contract.recordingAmounts,index:true},componentWorkIds:{type:[String],index:true},audioAssetId:String,
 recordingMetadata:{bpm:Number,key:String,bpms:{type:[Number],default:undefined},keys:{type:[String],default:undefined},genreIds:{type:[String],default:undefined},states:{type:Map,of:state}},credits:[credit],sourceRecordingIds:{type:[String],index:true},sourceWorkIds:{type:[String],index:true},
 publicationStatus:{type:String,enum:contract.publicationStatuses,index:true},archivalStatus:{type:String,enum:contract.archivalStatuses,index:true},
 ontologyRevision:Number,versionLabel:String,productionNotes:String,provenance,ontologyMigrationId:String,
};
module.exports={Melody,Lyrics,Work,Vocabulary,DjWorkType,DjWorkTypeSeed,AudioAsset,Version,RecordingFields};
