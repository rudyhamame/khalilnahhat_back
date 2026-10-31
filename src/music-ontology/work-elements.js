const mongoose=require('mongoose');
const {randomUUID}=require('crypto');
const {z}=require('zod');
const definitions=require('../../contracts/work-elements.json');
const audioLanguages=require('../../contracts/audio-languages.json');
const {ArchiveItem}=require('../models');
const norm=value=>value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const schema=new mongoose.Schema({key:{type:String,required:true},value:{type:String,required:true},normalizedValue:{type:String,required:true},revision:{type:Number,default:1},languageIds:{type:[String],default:[]},archived:{type:Boolean,default:false}},{timestamps:true});
schema.index({key:1,normalizedValue:1},{unique:true});
const Option=mongoose.models.WorkElementOption||mongoose.model('WorkElementOption',schema);
const State=mongoose.models.WorkElementCatalogState||mongoose.model('WorkElementCatalogState',new mongoose.Schema({_id:String,version:Number}));
const genres=['Pop','Dance pop','Synth-pop','Electropop','Indie pop','Arabic pop','K-pop','J-pop','Latin pop','Afrobeats','Amapiano','Highlife','Afro house','House','Deep house','Tech house','Progressive house','Electro house','Soulful house','Disco house','Organic house','Melodic house','EDM','Techno','Melodic techno','Minimal techno','Trance','Progressive trance','Psytrance','Hardstyle','Drum and bass','Jungle','Dubstep','UK garage','UK bass','Breakbeat','Electronica','Ambient','Downtempo','Trip-hop','Chillout','Lounge','Disco','Nu-disco','Funk','Soul','Neo-soul','R&B','Contemporary R&B','Hip-hop','Rap','Trap','Drill','Boom bap','Arabic hip-hop','Reggaeton','Dembow','Dancehall','Reggae','Dub','Ska','Rock','Classic rock','Alternative rock','Indie rock','Hard rock','Punk rock','Metal','Heavy metal','Blues','Blues rock','Jazz','Smooth jazz','Swing','Bebop','Bossa nova','Samba','Salsa','Bachata','Merengue','Cumbia','Mambo','Tango','Flamenco','Country','Bluegrass','Folk','Acoustic','Singer-songwriter','Classical','Orchestral','Chamber music','Opera','Film score','Soundtrack','Gospel','Christian music','Arabic classical','Tarab','Dabke','Shaabi','Mahraganat','Rai','Khaliji','Mawwal','Levantine folk','Egyptian pop','Lebanese pop','Turkish pop','Turkish folk','Persian pop','Bollywood','Bhangra','Qawwali','Latin jazz','Afro-Cuban jazz','World fusion'];
const presets={bpm:['60','70','80','90','100','110','120','128','130','140','150','160','170','180'],duration:['180','240','300','600'],key:['C','C#','Db','D','D#','Eb','E','F','F#','Gb','G','G#','Ab','A','A#','Bb','B'].flatMap(note=>['major','minor'].map(mode=>`${note} ${mode}`)),mode:['Major','Minor','Dorian','Phrygian','Lydian','Mixolydian','Locrian','Harmonic minor','Melodic minor'],script:['Arabic','Latin','Cyrillic','Greek','Hebrew','Devanagari','Chinese','Japanese','Korean']};
function createWorkElements(service){
 const {Vocabulary}=service.models;
 const definition=key=>{const result=definitions.find(row=>row.id===key);if(!result)fail('Unknown work element.');return result;};
 async function initialize(){
  await service.transaction(async session=>{
   if(await State.findById('starter-v1').session(session))return;
   const vocabulary=[...genres.map(name=>({kind:'genre',name})),...audioLanguages.map(([isoCode,label])=>({kind:'language',name:label.split(' · ')[0],isoCode}))];
   const existing=await Vocabulary.find({kind:{$in:['genre','language']}}).session(session).lean();
   const additions=vocabulary.filter(row=>!existing.some(old=>old.kind===row.kind&&(old.normalizedName===norm(row.name)||row.isoCode&&old.isoCode===row.isoCode)));
   if(additions.length)await Vocabulary.bulkWrite(additions.map(row=>({updateOne:{filter:{kind:row.kind,normalizedName:norm(row.name),parentId:''},update:{$setOnInsert:{...row,normalizedName:norm(row.name),parentId:'',externalId:`${row.kind}-${randomUUID()}`,revision:1}},upsert:true}})),{session});
   const presetWrites=Object.entries(presets).flatMap(([key,values])=>values.map(value=>({updateOne:{filter:{key,normalizedValue:norm(value)},update:{$setOnInsert:{key,value,normalizedValue:norm(value),revision:1}},upsert:true}})));
   if(presetWrites.length)await Option.bulkWrite(presetWrites,{session});
   await State.create([{_id:'starter-v1',version:1}],{session});
  });
 }
 async function list(){
  const [vocabulary,options,types,recordings,works]=await Promise.all([Vocabulary.find({}).sort({name:1}).lean(),Option.find({archived:{$ne:true}}).sort({value:1}).lean(),service.listWorkTypes(),ArchiveItem.find().select('externalId title ontologyRevision').lean(),service.models.Work.find().select('externalId title revision').lean()]);
  return definitions.map(def=>({...def,editable:!['fixed','recording','work'].includes(def.source),options:def.source==='vocabulary'?vocabulary.filter(row=>!row.archived&&row.kind===def.kind).map(row=>({id:row.externalId,value:row.name,revision:row.revision,parentId:row.parentId||'',isoCode:row.isoCode||'',languageIds:row.languageIds||[],languages:(row.languageIds||[]).map(id=>vocabulary.find(language=>language.externalId===id&&language.kind==='language')).filter(Boolean).map(language=>({id:language.externalId,name:language.name})),description:row.description||'',provenance:row.provenance||{source:'',note:''}})):def.source==='workType'?[...(def.id==='workKind'?[{id:'ORIGINAL',value:'Original',locked:true}]:[]),...types.map(row=>({...row,value:row.name,languageIds:row.languageIds||[],languages:(row.languageIds||[]).map(id=>vocabulary.find(language=>language.externalId===id&&language.kind==='language')).filter(Boolean).map(language=>({id:language.externalId,name:language.name}))}))]:def.source==='fixed'?def.values.map(value=>({id:value,value,locked:true})):def.source==='recording'||def.source==='work'?(def.source==='recording'?recordings:works).map(row=>({id:row.externalId,value:row.externalId,label:row.title,locked:true})):options.filter(row=>row.key===def.id).map(row=>({id:String(row._id),value:row.value,revision:row.revision,languageIds:row.languageIds||[],languages:(row.languageIds||[]).map(id=>vocabulary.find(language=>language.externalId===id&&language.kind==='language')).filter(Boolean).map(language=>({id:language.externalId,name:language.name}))}))}));
 }
 function validateValue(key,value){
  if(key==='bpm'&&(!Number.isFinite(Number(value))||Number(value)<=0||Number(value)>1000))fail('Enter BPM between 0 and 1000.');
  if(key==='duration'&&(!Number.isFinite(Number(value))||Number(value)<0||Number(value)>86400))fail('Enter duration in seconds, up to 86400.');
  if(key==='releaseYear'&&(!/^\d{4}$/.test(value)||Number(value)<1000||Number(value)>2100))fail('Enter a release year between 1000 and 2100.');
  if(key==='key'&&!/^[A-G](?:#|b)? (?:major|minor)$/.test(value))fail('Use a musical key such as C major or F# minor.');
  if(key==='releaseDate'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))fail('Enter a valid date as YYYY-MM-DD.');
  if(key==='translationRefs'){try{if(!['http:','https:'].includes(new URL(value).protocol))fail('Enter an HTTP or HTTPS link.');}catch{fail('Enter an HTTP or HTTPS link.');}}
 }
 async function save(key,input,id,actor){
  const def=definition(key);if(['fixed','recording','work'].includes(def.source))fail('Manage these identities in their recording or content editor.');
  const data=z.object({languageIds:z.array(z.string().trim().min(1).max(160)).max(100).refine(values=>new Set(values).size===values.length,'Choose distinct languages.').optional(),value:z.string().trim().min(1).max(240),revision:z.number().int().positive().optional(),parentId:z.string().max(160).optional(),isoCode:z.string().max(20).optional(),amount:z.enum(['INDIVIDUAL','MULTIPLE']).optional()}).strict().parse(input);
  if(def.source==='vocabulary'){
   const old=id?await Vocabulary.findOne({externalId:id}).lean():await Vocabulary.findOne({kind:def.kind,normalizedName:norm(data.value),parentId:data.parentId||'',archived:true}).lean();
   if(id&&(!old||old.kind!==def.kind))fail('Option not found.',404);
   const value={...(data.languageIds!==undefined?{languageIds:data.languageIds}:{}),kind:def.kind,name:data.value,parentId:old?.parentId??data.parentId??'',isoCode:data.isoCode??old?.isoCode??'',description:old?.description||'',provenance:{source:old?.provenance?.source||'',note:old?.provenance?.note||''},...(old?{revision:id?data.revision:old.revision}:{})};
   const row=await service.saveVocabulary(value,old?.externalId||null,actor);
   if(old?.archived)await Vocabulary.updateOne({externalId:old.externalId},{$set:{archived:false}});
   return row;
  }
  if(def.source==='workType'){
   const old=id?(await service.listWorkTypes()).find(row=>row.id===id):null;if(id&&!old)fail('Option not found.',404);
   return service.saveWorkType({languageIds:data.languageIds??old?.languageIds??[],name:data.value,nameArabic:old?.nameArabic||'',amount:old?.amount||data.amount||'INDIVIDUAL',details:old?.details||'',detailsArabic:old?.detailsArabic||'',artworkUrl:old?.artworkUrl||'',...(old?{revision:data.revision}:{})},id);
  }
  validateValue(key,data.value);
  const languageSet=data.languageIds!==undefined?{languageIds:data.languageIds}:{};
  if(languageSet.languageIds?.length&&await Vocabulary.countDocuments({externalId:{$in:languageSet.languageIds},kind:'language'})!==languageSet.languageIds.length)fail('Choose existing language terms.');
  if(id){if(!mongoose.isValidObjectId(id))fail('Option not found.',404);const result=await Option.findOneAndUpdate({_id:id,key,revision:data.revision,archived:{$ne:true}},{$set:{value:data.value,normalizedValue:norm(data.value),...languageSet},$inc:{revision:1}},{new:true,runValidators:true});if(!result)fail('This option changed. Reload before editing.',409);return result;}
  const old=await Option.findOne({key,normalizedValue:norm(data.value)});if(old&&!old.archived)fail('This option already exists.',409);
  return Option.findOneAndUpdate({key,normalizedValue:norm(data.value)},{$set:{value:data.value,archived:false,...languageSet},$inc:{revision:1}},{upsert:true,new:true,runValidators:true});
 }
 async function remove(key,id,revision){
  const def=definition(key);if(['fixed','recording','work'].includes(def.source))fail('Manage these identities in their recording or content editor.');
  if(def.source==='workType'){const row=(await service.listWorkTypes()).find(item=>item.id===id);if(!row||row.revision!==revision)fail('This option changed. Reload before deleting.',409);return service.deleteWorkType(id);}
  if(def.source==='vocabulary'&&await Vocabulary.exists({parentId:id,archived:{$ne:true}}))fail('Remove this option’s child entries first.',409);
  if(def.source!=='vocabulary'&&!mongoose.isValidObjectId(id))fail('Option not found.',404);
  const Model=def.source==='vocabulary'?Vocabulary:Option,query=def.source==='vocabulary'?{externalId:id,kind:def.kind}:{_id:id,key};
  const result=await Model.updateOne({...query,revision,archived:{$ne:true}},{$set:{archived:true},$inc:{revision:1}});if(result.modifiedCount!==1)fail('This option changed. Reload before deleting.',409);
 }
 return {list,initialize,save,remove};
}
module.exports={createWorkElements};
