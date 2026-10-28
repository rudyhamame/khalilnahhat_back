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
const Lyrics=model('MusicLyrics',{languageId:String,dialectId:String,regionIds:[String],artistCredits:[credit],primaryConceptId:String,conceptIds:[String],text:String,script:String,translationRefs:[String],notes:String,completeness:{type:String,enum:['INCOMPLETE','COMPLETE'],default:'INCOMPLETE'},states:{type:Map,of:state},provenance});
const Work=model('MusicalWork',{title:{type:String,required:true},type:{type:String,enum:contract.workTypes,required:true},lyricsId:String,melodyId:{type:String,required:true},credits:[credit],description:String,provenance},[[{type:1,title:1},{}]]);
const Vocabulary=model('MusicVocabulary',{kind:{type:String,enum:contract.vocabularyKinds,required:true},name:{type:String,required:true},normalizedName:{type:String,required:true},parentId:{type:String,default:''},isoCode:String,description:String,provenance},[[{kind:1,normalizedName:1,parentId:1},{unique:true}],[{kind:1,isoCode:1},{unique:true,partialFilterExpression:{isoCode:{$gt:''}}}]]);
const AudioAsset=model('MusicAudioAsset',{url:{type:String,required:true,unique:true},mime:String,durationSeconds:Number,originalName:String,provenance});
const Version=model('MusicRecordingVersion',{recordingId:{type:String,index:true,required:true},number:Number,snapshot:Schema.Types.Mixed,changedBy:String},[[{recordingId:1,number:1},{unique:true}]]);
const RecordingFields={
 recordingType:{type:String,enum:contract.recordingTypes,index:true},workId:{type:String,index:true},audioAssetId:String,
 recordingMetadata:{bpm:Number,key:String,states:{type:Map,of:state}},credits:[credit],sourceRecordingIds:{type:[String],index:true},sourceWorkIds:{type:[String],index:true},
 publicationStatus:{type:String,enum:contract.publicationStatuses,index:true},archivalStatus:{type:String,enum:contract.archivalStatuses,index:true},
 ontologyRevision:Number,versionLabel:String,productionNotes:String,provenance,ontologyMigrationId:String,
};
module.exports={Melody,Lyrics,Work,Vocabulary,AudioAsset,Version,RecordingFields};
