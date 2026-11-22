const LEGACY_LYRIC_FIELDS=['text','notes','completeness','conceptLabel','conceptSummary','primaryConceptId','conceptIds','concept','sentenceConcept','timedLyrics','lyricistCredits'];
const {recordingName,recordingNames}=require('./recording-name');
// Stored lyric data stays in the database but is never returned.
const withoutLyricFields=l=>{const copy={...l};for(const key of LEGACY_LYRIC_FIELDS)delete copy[key];return copy;};
const mongoose=require('mongoose');
const {z}=require('zod');
const {randomUUID}=require('crypto');
const M=require('./models');
const V=require('./validation');
const {withoutGenreLanguages}=require('./genre-data');
const {ArchiveItem}=require('../models');
const MusicRecording=require('./recording-model');
const {MediaItem}=require('../content');
const contract=require('../../contracts/music-ontology.json');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const makeId=kind=>`${kind}-${randomUUID()}`;
const plain=row=>withoutGenreLanguages(row?.toObject?row.toObject({flattenMaps:true}):row);
const norm=name=>name.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');
function inferredRecordingMetadata(contents){
 const bpms=[...new Set(contents.map(w=>w.melody?.bpm).filter(v=>v!=null))],keys=[...new Set(contents.flatMap(w=>w.melody?.keys??(w.melody?.key?[w.melody.key]:[])))];
 const genres=[...new Map(contents.flatMap(w=>w.melody?.genres||[]).map(g=>[g.id,g])).values()];
 const genreIds=[...new Set(contents.flatMap(w=>w.melody?.genreIds||w.melody?.genres?.map(g=>g.id)||[]))];
 return {bpms,keys,genres,genreIds,bpm:bpms[0]??null,key:keys[0]??null,states:{bpm:bpms.length?'SPECIFIED':'MISSING',key:keys.length?'SPECIFIED':'MISSING',genreIds:genreIds.length?'SPECIFIED':'MISSING'}};
}
const creditNames=(credits,vocabulary)=>credits.map(c=>({...c,artist:vocabulary.get(c.artistId)||null}));
function assertAcyclic(id,sources,rows){
 const graph=new Map(rows.map(row=>[row.externalId,row.sourceRecordingIds||[]]));graph.set(id,sources);
 const state=new Map([[id,1]]),stack=[{node:id,index:0}];
 while(stack.length){const frame=stack[stack.length-1],children=graph.get(frame.node)||[];if(frame.index>=children.length){state.set(frame.node,2);stack.pop();continue;}const child=children[frame.index++];if(state.get(child)===1)fail('Recording sources cannot form a cycle.');if(state.get(child)!==2){state.set(child,1);stack.push({node:child,index:0});}}
}
function matchesWork(r,f={}){
 const w=r.work,l=w?.type==='SONG'?w.lyrics:null,m=w?.melody;
 const has=(items,id)=>!id||items?.some(v=>(typeof v==='string'?v:v.id||v.artistId)===id);
 if(f.workType&&r.workType!==f.workType||f.contentType&&w?.type!==f.contentType)return false;
 if(f.status&&r.status!==f.status)return false;
 if(f.language&&l?.language?.id!==f.language&&!l?.languages?.some(item=>item.id===f.language)||f.dialect&&l?.dialect?.id!==f.dialect&&!l?.dialects?.some(item=>item.id===f.dialect))return false;
 if(!has(l?.regions,f.region)||(!has(m?.genres,f.genre)&&!has(r.recordingMetadata?.genreIds,f.genre)))return false;
 if(!has(m?.instruments,f.instrument)||!has(m?.musicianCredits,f.musician))return false;
 if(f.artist&&!has(l?.vocalistCredits??[...(m?.musicianCredits||[]),...(l?.artistCredits||[])],f.artist))return false;
 if(f.rhythm&&m?.rhythm?.id!==f.rhythm&&!m?.rhythmIds?.includes(f.rhythm))return false;
 const scoped=f.bpmScope==='recording'?r.recordingMetadata:m;
 const bpms=scoped?.bpms??(scoped?.bpm==null?[]:[scoped.bpm]),keys=scoped?.keys??(scoped?.key?[scoped.key]:[]);
 if((f.bpmMin!==undefined||f.bpmMax!==undefined)&&!bpms.some(bpm=>(f.bpmMin===undefined||bpm>=Number(f.bpmMin))&&(f.bpmMax===undefined||bpm<=Number(f.bpmMax))))return false;
 if(f.key&&!keys.includes(f.key))return false;
 if(f.q){const q=norm(f.q);const hay=[r.name,w?.title,r.artist,...(m?.musicianCredits||[]).map(c=>c.artist?.name),...(m?.instruments||[]).map(i=>i.name),...(l?.artistCredits||[]).map(c=>c.artist?.name),...(m?.genres||[]).map(g=>g.name),...(r.recordingMetadata?.genres||[]).map(g=>g.name)].filter(Boolean).join(' ');if(!norm(hay).includes(q))return false;}
 return true;
}
function matches(r,f={}){
 const components=r.atoms?.length?r.atoms.map(item=>({title:item.name,type:item.lyrics?'SONG':'MUSIC',lyrics:item.lyrics?{language:{id:item.lyrics.languages?.[0]?.languageId},dialect:{id:item.lyrics.languages?.[0]?.dialectIds?.[0]},languages:(item.lyrics.languages??[]).map(row=>({id:row.languageId})),dialects:(item.lyrics.languages??[]).flatMap(row=>row.dialectIds).map(id=>({id})),vocalistCredits:item.lyrics.vocalistCredits,artistCredits:[...item.lyrics.vocalistCredits]}:null,melody:{...item.sound,rhythm:item.sound?.rhythmId?{id:item.sound.rhythmId}:null,genres:(item.sound?.genreIds||[]).map(id=>({id})),instruments:(item.sound?.musicianCredits||[]).filter(credit=>credit.instrumentId).map(credit=>({id:credit.instrumentId})),musicianCredits:(item.sound?.musicianCredits||[])}})):(r.work?[r.work]:[]);
 return (components.length?components:[null]).some(work=>matchesWork({...r,work},f));
}
function createService({ArchiveModel=MusicRecording,models=M,deliveryUrl=value=>value,lightUrl=()=>'',previewUrl=value=>value,ownedAsset=()=>false}={}){
 const {Work,Lyrics,Melody,Vocabulary,DjWorkType,DjWorkTypeSeed,Version}=models;
 async function transaction(fn){
  const session=await mongoose.startSession();
  try{return await session.withTransaction(()=>fn(session));}catch(e){if(/Transaction numbers are only allowed|replica set/.test(e.message))fail('Music ontology writes require MongoDB configured as a replica set (transactions).',503);throw e;}finally{await session.endSession();}
 }
 async function references(ids,kind,session){
  if(!ids.length)return;
  const rows=await Vocabulary.find({externalId:{$in:ids},kind:{$in:[].concat(kind)}}).session(session).lean();
  if(new Set(rows.map(r=>r.externalId)).size!==new Set(ids).size)fail(`Choose existing ${kind} references.`);
 }
 async function creditsCheck(credits,session,kind=['artist']){await references(credits.map(c=>c.artistId),kind,session);}
 const provenance=(p,actor)=>({...p,recordedBy:actor||'admin'});
 const defaultWorkTypes=[
  {id:'MIX',name:'Mix',nameArabic:'ميكس',details:'A curated sequence of tracks blended into one continuous listening experience.',detailsArabic:'مجموعة مقطوعات مختارة ومنسّقة في تجربة استماع متصلة.'},
  {id:'REMIX',name:'Remix',nameArabic:'ريميكس',details:'An existing recording reshaped with a new beat, arrangement or sound textures.',detailsArabic:'إعادة تشكيل تسجيل موجود بإيقاع أو توزيع أو ملامح صوتية جديدة.'},
  {id:'MASHUP',name:'Mashup',nameArabic:'ماش أب',details:'Parts from separate recordings combined into one new musical arrangement.',detailsArabic:'جمع مقاطع من تسجيلات مختلفة في توزيع موسيقي جديد.'},
  {id:'MEDLEY',name:'Medley',nameArabic:'ميدلي',details:'Selected passages from several works arranged into one connected performance.',detailsArabic:'مقاطع مختارة من عدة أعمال مرتّبة في أداء واحد متصل.'},
  {id:'COVER',name:'Cover',nameArabic:'إعادة أداء',details:'A fresh interpretation of an existing work, with a different arrangement, sound or performance.',detailsArabic:'قراءة جديدة لعمل موجود، بتوزيع أو صوت أو إحساس أدائي مختلف.'},
  {id:'LIVE',name:'Live',nameArabic:'أداء مباشر',details:'A real-time performance shaped by the room, the audience and the moment.',detailsArabic:'أداء في الوقت الفعلي يتفاعل مع المكان والجمهور واللحظة.'},
 ];
 async function ensureWorkTypes(){
  const seed=await DjWorkTypeSeed.findOneAndUpdate({externalId:'defaults-v1'},{$setOnInsert:{externalId:'defaults-v1'}},{upsert:true,new:false}).lean();
  if(seed)return;
  await DjWorkType.bulkWrite(defaultWorkTypes.map(({id,...row},sortOrder)=>({updateOne:{filter:{externalId:id},update:{$setOnInsert:{...row,sortOrder,externalId:id,normalizedName:norm(row.name),revision:1}},upsert:true}})),{ordered:false});
 }
 async function listWorkTypes(){
  await ensureWorkTypes();
  return (await DjWorkType.find().sort({sortOrder:1,name:1}).lean()).map(row=>({id:row.externalId,name:row.name,nameArabic:row.nameArabic||'',details:row.details||'',detailsArabic:row.detailsArabic||'',languageIds:row.languageIds||[],artworkUrl:row.artworkUrl||'',revision:row.revision||1}));
 }
 async function saveWorkType(input,id=null){
  const schema=z.object({languageIds:z.array(z.string().trim().min(1).max(160)).max(100).refine(values=>new Set(values).size===values.length,'Choose distinct languages.').optional(),artworkUrl:z.string().trim().max(2048).optional(),name:z.string().trim().min(1).max(120),nameArabic:z.string().trim().max(120).default(''),details:z.string().trim().max(2000).default(''),detailsArabic:z.string().trim().max(2000).default(''),revision:z.number().int().positive().optional()}).strict();
  const value=schema.parse(input), code=(id||value.name).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,120);
  if(!code)fail('Enter a work type name.');
  if(code==='ORIGINAL')fail('Original is reserved for work without a DJ treatment.');
  const old=id?await DjWorkType.findOne({externalId:id}):null;
  if(id&&!old)fail('DJ work type not found.',404);
  if(value.languageIds?.length&&await Vocabulary.countDocuments({externalId:{$in:value.languageIds},kind:'language'})!==value.languageIds.length)fail('Choose existing language terms.');
  if(value.artworkUrl&&value.artworkUrl!==old?.artworkUrl&&!await MediaItem.exists({kind:'photo',mediaUrl:value.artworkUrl}))fail('Choose artwork from Gallery.');
  if(old&&value.revision!==old.revision)fail('This DJ work type changed. Reload before editing.',409);
  const conflict=await DjWorkType.findOne({normalizedName:norm(value.name),externalId:{$ne:code}}).lean();
  if(conflict)fail('A DJ work type with this name already exists.',409);
  const sortOrder=old?.sortOrder??((await DjWorkType.findOne().sort({sortOrder:-1}).select('sortOrder').lean())?.sortOrder??-1)+1;
  const data={languageIds:value.languageIds??old?.languageIds??[],artworkUrl:value.artworkUrl??old?.artworkUrl??'',name:value.name,nameArabic:value.nameArabic,normalizedName:norm(value.name),details:value.details,detailsArabic:value.detailsArabic,sortOrder,revision:(old?.revision||0)+1};
  if(old){old.set(data);await old.save();return {id:old.externalId,...data};}
  try{const row=await DjWorkType.create({externalId:code,...data});return {id:row.externalId,name:row.name,nameArabic:row.nameArabic,details:row.details,detailsArabic:row.detailsArabic,languageIds:row.languageIds||[],artworkUrl:row.artworkUrl||'',revision:row.revision};}
  catch(error){if(error.code===11000)fail('A DJ work type with this name already exists.',409);throw error;}
 }
 async function deleteWorkType(id){
  const type=await DjWorkType.findOne({externalId:id});if(!type)fail('DJ work type not found.',404);
  if(await Work.exists({workKind:id})||await MusicRecording.exists({workType:id}))fail('This DJ work type is assigned to catalog content and cannot be deleted yet.',409);
  const deleted=await require('../permanent-deletion').remove(DjWorkType,{_id:type._id,revision:type.revision});if(!deleted)fail('This DJ work type changed. Reload before deleting.',409);
  return true;
 }
 async function saveVocabulary(input,id,actor){
  const value=withoutGenreLanguages(V.vocabulary.parse(input));
  return transaction(async session=>{
   if(value.parentId){if(!['dialect','genre'].includes(value.kind))fail('Only dialects and genres have parents.');await references([value.parentId],value.kind==='dialect'?'language':'genre',session);if(value.parentId===id)fail('An entity cannot be its own parent.');
    let next=value.parentId;const seen=new Set([id]);while(next){if(seen.has(next))fail('Vocabulary hierarchy cannot contain cycles.');seen.add(next);next=(await Vocabulary.findOne({externalId:next}).session(session).lean())?.parentId;}}
   const old=id?await Vocabulary.findOne({externalId:id}).session(session):null;
   if(id&&!old)fail('Metadata entity not found.',404);
   if(value.kind==='rhythm'&&value.beatMap===undefined&&!old?.beatMap){const map=require('./rhythm-beat-map').beatMapFor(value.name);if(map)value.beatMap=map;}
   if(old&&value.kind!==old.kind)fail('Entity kind cannot be changed; create a separate entity.');
   if(old&&value.kind!=='genre'&&value.parentId!==old.parentId)fail('Parent identity cannot be changed for this entity; create a separate entity.');
   if(old&&value.revision!==old.revision)fail('This entity changed. Reload before editing.',409);
   if(value.languageIds?.length)await references(value.languageIds,'language',session);
   const dialectIds=value.dialectIds??old?.dialectIds??[];
   if(dialectIds.length){
    if(value.kind!=='artist')fail('Only vocalists have dialect dependencies.');
    const languageIds=value.languageIds??old?.languageIds??[];
    const dialects=await Vocabulary.find({externalId:{$in:dialectIds},kind:'dialect',archived:{$ne:true}}).session(session).lean();
    if(dialects.length!==dialectIds.length)fail('Choose existing dialect terms.');
    if(!languageIds.length||dialects.some(dialect=>![...(dialect.languageIds||[]),dialect.parentId].filter(Boolean).some(languageId=>languageIds.includes(languageId))))fail('Choose dialects belonging to the vocalist’s selected languages.');
   }

   if(value.instrumentIds?.length){if(value.kind!=='musician')fail('Only musicians have instruments.');if(await Vocabulary.countDocuments({externalId:{$in:value.instrumentIds},kind:'instrument',archived:{$ne:true}}).session(session)!==new Set(value.instrumentIds).size)fail('Choose existing instruments for this musician.');}
   if(value.instrumentId){if(value.kind!=='musician')fail('Only musicians have an instrument dependency.');const instrument=await Vocabulary.findOne({externalId:value.instrumentId,kind:'instrument',archived:{$ne:true}}).session(session);if(!instrument)fail('Choose an existing instrument for this musician.');}
   const data={...value,...(value.kind==='musician'?{instrumentIds:value.instrumentIds!==undefined?[...new Set(value.instrumentIds)]:old?.instrumentIds||[],instrumentId:value.instrumentIds!==undefined?(value.instrumentIds[0]||null):value.instrumentId!==undefined?value.instrumentId:old?.instrumentId}:{}),...(value.kind==='genre'?{}:{languageIds:value.languageIds??old?.languageIds??[]}),dialectIds,externalId:id||makeId(value.kind),normalizedName:norm(value.name),provenance:provenance(value.provenance,actor),revision:(old?.revision||0)+1};
   if(old){old.set(data);await old.save({session});return plain(old);}
   return plain((await Vocabulary.create([data],{session}))[0]);
  });
 }
 async function saveWork(input,id,actor){
  const value=V.work.parse(input);
  return transaction(async session=>{
   if(value.workKind!=='ORIGINAL'&&!await DjWorkType.exists({externalId:value.workKind}).session(session))fail('Choose an existing DJ work type.');
   const old=id?await Work.findOne({externalId:id}).session(session):null;
   if(id&&!old)fail('Musical work not found.',404);
   if(old&&value.revision!==old.revision)fail('This work changed. Reload before editing.',409);
   if(old&&old.type!==value.type)fail('Create a separate work to change Vocal/Instrumental Music classification; existing work identity is preserved.');
   await creditsCheck(value.credits,session);
   let melodyId=value.melodyId,lyricsId=value.type==='SONG'?value.lyricsId:null;
   if(melodyId&&value.melody)fail('Choose either an existing melody or new melody metadata.');
   if(melodyId&&!await Melody.exists({externalId:melodyId}).session(session))fail('Melody not found.');
   if(!melodyId){const m=V.melody.parse(value.melody||{});if(old){const previous=await Melody.findOne({externalId:old.melodyId}).session(session).lean();for(const field of ['instrumentIds','musicianCredits'])if(!Object.hasOwn(input.melody||{},field)){m[field]=previous?.[field]||[];if(previous?.states?.[field])m.states[field]=previous.states[field];}}await references(m.genreIds,'genre',session);await references(m.instrumentIds,'instrument',session);await creditsCheck(m.musicianCredits,session,['musician','artist']);if(m.rhythmId)await references([m.rhythmId],'rhythm',session);m.states=V.metadataStates(m,m.states);melodyId=makeId('melody');await Melody.create([{...m,externalId:melodyId,provenance:provenance(m.provenance,actor)}],{session});}
   if(value.type==='SONG'){
    if(lyricsId&&value.lyrics)fail('Choose either existing vocal metadata or new vocal metadata.');
    if(lyricsId&&!await Lyrics.exists({externalId:lyricsId}).session(session))fail('Vocal metadata not found.');
    if(!lyricsId){const l=V.lyrics.parse(value.lyrics||{});
     if(l.audioLanguageCodes!==undefined){
      const definitions=new Map(require('../../contracts/audio-languages.json'));
      l.languageIds=[];
      for(const code of [...new Set(l.audioLanguageCodes)]){
       const name=definitions.get(code)?.split(' · ')[0];
       let ref=await Vocabulary.findOne({kind:'language',$or:[{isoCode:code},...(name?[{normalizedName:norm(name)}]:[])]}).session(session);
       if(!ref&&!name)fail('Add this language and its ISO code in Work Elements first.');
       if(!ref)ref=(await Vocabulary.create([{externalId:makeId('language'),kind:'language',name,normalizedName:norm(name),isoCode:code,parentId:'',revision:1}],{session}))[0];
       else if(!ref.isoCode){ref.isoCode=code;await ref.save({session});}
       l.languageIds.push(ref.externalId);
      }
      l.languageId=l.languageIds[0]||null;
      l.states={...l.states,languageId:l.languageId?'SPECIFIED':'MISSING',languageIds:l.languageIds.length?'SPECIFIED':'MISSING'};
     }
     delete l.audioLanguageCodes;
     l.languageIds=[...new Set([l.languageId,...(l.languageIds||[])].filter(Boolean))];
     if(l.languageIds.length)await references(l.languageIds,'language',session);if(l.dialectId){await references([l.dialectId],'dialect',session);const d=await Vocabulary.findOne({externalId:l.dialectId}).session(session);if(d.parentId&&!l.languageIds.includes(d.parentId))fail('Dialect must belong to the selected language.');}
     await references(l.regionIds,'region',session);await creditsCheck(l.artistCredits,session);l.states=V.metadataStates(l,l.states);lyricsId=makeId('lyrics');await Lyrics.create([{...l,externalId:lyricsId,provenance:provenance(l.provenance,actor)}],{session});}
   }
   // Work revisions use new component identities, preserving reused components and provenance.
   const data={title:value.title,type:value.type,workKind:value.workKind,description:value.description,credits:value.credits,melodyId,lyricsId,provenance:provenance(value.provenance,actor),revision:(old?.revision||0)+1};
   if(old){old.set(data);await old.save({session});return old.externalId;}
   const row=(await Work.create([{...data,externalId:makeId('work')}],{session}))[0];return row.externalId;
  });
 }
 async function checkRecordingItems(items,audioUrl,durationSeconds,session=null){
  for(const item of items||[]){
   const l=item.lyrics;
   if(durationSeconds!=null&&item.audioRange?.endSec>durationSeconds+.01)fail('Atom audio ranges must stay inside the recording duration.');
   const rhythmIds=item.sound?.rhythmIds??[];
   if(rhythmIds.length)await references(rhythmIds,'rhythm',session);
   if(item.sound?.genreIds?.length)await references(item.sound.genreIds,'genre',session);
   for(const credit of [...(item.sound?.musicianCredits||[]),...(l?.vocalistCredits||[])]){
    const person=await Vocabulary.findOne({externalId:credit.artistId,kind:{$in:['artist','musician']},archived:{$ne:true}}).session(session);
    if(!person)fail('Choose an existing person for each item credit.');
   }
   for(const credit of item.sound?.musicianCredits||[]){
    if(!credit.instrumentId)continue;
    const instrument=await Vocabulary.findOne({externalId:credit.instrumentId,kind:'instrument',archived:{$ne:true}}).session(session);
    if(!instrument)fail('Choose an existing instrument for each musician credit.');
   }
   const languages=l?.languages??[],languageIds=languages.map(row=>row.languageId);
   if(languageIds.length)await references(languageIds,'language',session);
   for(const row of languages)for(const id of row.dialectIds){const dialect=await Vocabulary.findOne({externalId:id,kind:'dialect',archived:{$ne:true}}).session(session);if(!dialect||dialect.parentId&&dialect.parentId!==row.languageId)fail('Choose dialects of the item language they belong to.');}
  }
 }
 async function saveRecording(input,id,actor){
  const v=V.recording.parse(input);
  return transaction(async session=>{
   const type=await DjWorkType.findOne({externalId:v.workType}).session(session);
   if(!type)fail('Choose an existing DJ work type.');
   const old=id?await ArchiveModel.findOne({externalId:id}).session(session):null;
   if(id&&!old)fail('Recording not found.',404);
   if(old&&v.revision!==(old.revision||0))fail('This recording changed. Reload before editing.',409);
   const atoms=v.atoms===undefined?plain(old)?.atoms:v.atoms;
   await checkRecordingItems(atoms,v.audioUrl,v.durationSeconds,session);
   if(v.audioUrl&&!ownedAsset(v.audioUrl)||v.coverImage&&!ownedAsset(v.coverImage)||v.stems?.channels?.some(c=>!ownedAsset(c.url)))fail('Choose media uploaded to this website.');
   if(v.audioUrl&&!require('../music-archive-files').localAssetPattern.test(v.audioUrl)&&!/\/video\/(upload|authenticated)\//.test(v.audioUrl))fail('Choose an uploaded audio asset.');
   if(v.status==='PUBLISHED'&&!v.audioUrl)fail('Published recordings require audio.');
   const recordId=id||makeId('recording');
   const data={audioMetadata:v.audioMetadata!==undefined?v.audioMetadata:(old?.audioUrl===v.audioUrl?plain(old)?.audioMetadata:null),stems:v.stems!==undefined?v.stems:(old?.audioUrl===v.audioUrl?plain(old)?.stems||null:null),...(atoms!==undefined?{atoms}:{}),workType:v.workType,atomCount:atoms!==undefined?atoms.length:(old?.atomCount??0),status:v.status,revision:(old?.revision||0)+1,description:v.description,releaseDate:v.releaseDate,audioUrl:v.audioUrl,coverImage:v.coverImage,durationMinutes:v.durationMinutes};
   let row;
   if(old){old.set(data);row=await old.save({session});}else row=(await ArchiveModel.create([{...data,externalId:recordId}],{session}))[0];
   await Version.create([{externalId:makeId('version'),recordingId:recordId,number:data.revision,snapshot:plain(row),changedBy:actor||'admin'}],{session});
   return recordId;
  });
 }
 async function workMap(ids){
  const works=await Work.find({externalId:{$in:ids}}).lean();
  const [melodies,lyrics,vocabulary,workTypes]=await Promise.all([Melody.find({externalId:{$in:works.map(w=>w.melodyId)}}).lean(),Lyrics.find({externalId:{$in:works.map(w=>w.lyricsId).filter(Boolean)}}).lean(),Vocabulary.find({}).lean(),listWorkTypes()]);
  const workTypeMap=new Map(workTypes.map(type=>[type.id,type]));
  const vs=new Map(vocabulary.map(v=>[v.externalId,{...withoutGenreLanguages(v),id:v.externalId,_id:undefined}]));
  const entity=(kind,id)=>vs.get(id)?.kind===kind?vs.get(id):null;
  const mm=new Map(melodies.map(m=>[m.externalId,m])),lm=new Map(lyrics.map(l=>[l.externalId,l]));
  const mapped=works.map(w=>{
   const m=mm.get(w.melodyId),l=lm.get(w.lyricsId);
   const languageRows=[...new Set([l?.languageId,...(l?.languageIds||[])].filter(Boolean))].map(id=>entity('language',id)).filter(Boolean);
   const audioCodes=languageRows.map(row=>row.isoCode||require('../../contracts/audio-languages.json').find(([,name])=>norm(name.split(' · ')[0])===norm(row.name))?.[0]);
   return [w.externalId,{...w,id:w.externalId,_id:undefined,workKindDefinition:workTypeMap.get(w.workKind)||null,credits:creditNames(w.credits||[],vs),melody:m?{...m,id:m.externalId,_id:undefined,rhythm:entity('rhythm',m.rhythmId),genres:(m.genreIds||[]).map(id=>entity('genre',id)).filter(Boolean),instruments:(m.instrumentIds||[]).map(id=>entity('instrument',id)).filter(Boolean),musicianCredits:creditNames(m.musicianCredits||[],vs)}:null,lyrics:w.type==='SONG'&&l?{...withoutLyricFields(l),id:l.externalId,_id:undefined,language:entity('language',l.languageId),languages:languageRows,audioLanguageCodes:audioCodes.every(Boolean)?audioCodes:undefined,dialect:entity('dialect',l.dialectId),regions:(l.regionIds||[]).map(id=>entity('region',id)).filter(Boolean),artistCredits:creditNames((l.artistCredits||[]).filter(credit=>credit.role!=='LYRICIST'),vs)}:null}];
  });return {works:new Map(mapped),vocabulary:vs,workTypes:workTypeMap};
 }
 async function hydrate(rows,{admin=false}={}){
  rows=rows.map(plain);const {vocabulary,workTypes}=await workMap([]);
  return rows.map(r=>{
   const deliver=url=>admin?previewUrl(deliveryUrl(url)):deliveryUrl(url);
   const atoms=r.atoms||[];
   const atomWorks=atoms.map(item=>({melody:{...item.sound,genres:(item.sound?.genreIds||[]).map(id=>vocabulary.get(id)).filter(Boolean)}}));
   const artist=[...new Set(atoms.flatMap(item=>[...(item.sound?.musicianCredits||[]),...(item.lyrics?.vocalistCredits||[])]).map(c=>vocabulary.get(c.artistId)?.name).filter(Boolean))].join(', ');
   const type=workTypes.get(r.workType)||null;
   const minutes=r.durationMinutes??null;
   return {id:r.externalId,name:recordingName(r),names:recordingNames(r),description:r.description||'',workType:type?r.workType:null,workTypeDefinition:type,status:r.status||'DRAFT',atomCount:atoms.length,atoms:atoms.map(item=>({...item,lyrics:item.lyrics?withoutLyricFields(item.lyrics):null})),
    stems:r.stems?{channels:(r.stems.channels||[]).filter(c=>c&&c.url).map(c=>({name:c.name,url:deliver(c.url),storedUrl:c.url,...(admin?{}:{previewUrl:lightUrl(c.url)||undefined})})),duration:r.stems.duration??null,splitAt:r.stems.splitAt||''}:null,
    audio:{metadata:r.audioMetadata||null,url:deliver(r.audioUrl||''),durationSeconds:minutes!=null?Math.round(minutes*60):null},audioUrl:deliver(r.audioUrl||''),coverImage:deliver(r.coverImage||''),
    durationMinutes:minutes,releaseDate:r.releaseDate||'',artist,recordingMetadata:inferredRecordingMetadata(atomWorks),revision:r.revision||0,createdAt:r.createdAt,updatedAt:r.updatedAt,
    ...(admin?{storedAudioUrl:r.audioUrl||'',storedCoverImage:r.coverImage||''}:{})};
  });
 }
 async function list(admin=false,filters={}){
  const rows=await ArchiveModel.find(admin?{}:{status:'PUBLISHED',audioUrl:{$ne:''}}).sort({createdAt:-1});
  return (await hydrate(rows,{admin})).filter(r=>matches(r,filters));
 }
 async function preflightRecording(input){
  const v=V.recording.parse(input);
  await ensureWorkTypes();
  const type=await DjWorkType.findOne({externalId:v.workType}).lean();if(!type)fail('Choose an existing DJ work type.');
  await checkRecordingItems(v.atoms,v.audioUrl,v.durationSeconds);
  if(v.audioUrl&&!ownedAsset(v.audioUrl)||v.coverImage&&!ownedAsset(v.coverImage)||v.stems?.channels?.some(c=>!ownedAsset(c.url)))fail('Choose media uploaded to this website.');
  if(v.audioUrl&&!require('../music-archive-files').localAssetPattern.test(v.audioUrl)&&!/\/video\/(upload|authenticated)\//.test(v.audioUrl))fail('Choose an uploaded audio asset.');
  if(v.status==='PUBLISHED'&&!v.audioUrl)fail('Published recordings require audio.');
  return v;
 }
 // Deletes an older archive song (not a recording) and its media.
 async function deleteLegacy(id){
  const deletion=require('../permanent-deletion');let keys=[];
  const removed=await transaction(async session=>{
   const row=await ArchiveItem.findOne({externalId:id}).session(session);if(!row)return null;
   keys=await deletion.prepare(row,{session});
   await require('../music-archive').Collection.updateMany({recordingIds:id},{$pull:{recordingIds:id}},{session});
   return ArchiveItem.findOneAndDelete({externalId:id}).session(session);
  });
  if(removed)removed.cloudinaryCleanupPending=(await deletion.finish(keys)).pending;return removed;
 }

 return {transaction,saveVocabulary,saveWork,saveWorkType,deleteWorkType,listWorkTypes,saveRecording,hydrate,list,workMap,models,contract,deleteLegacy,preflightRecording};
}
module.exports={createService,assertAcyclic,matches,norm,fail};
