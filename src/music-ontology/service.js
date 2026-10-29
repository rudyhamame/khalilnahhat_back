const mongoose=require('mongoose');
const {randomUUID,createHash}=require('crypto');
const M=require('./models');
const V=require('./validation');
const {ArchiveItem}=require('../models');
const contract=require('../../contracts/music-ontology.json');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const makeId=kind=>`${kind}-${randomUUID()}`;
const plain=row=>row?.toObject?row.toObject({flattenMaps:true}):row;
const norm=name=>name.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');
function inferredRecordingMetadata(contents){
 const bpms=[...new Set(contents.map(w=>w.melody?.bpm).filter(v=>v!=null))],keys=[...new Set(contents.map(w=>w.melody?.key).filter(Boolean))];
 const genres=[...new Map(contents.flatMap(w=>w.melody?.genres||[]).map(g=>[g.id,g])).values()];
 const genreIds=[...new Set(contents.flatMap(w=>w.melody?.genreIds||w.melody?.genres?.map(g=>g.id)||[]))];
 return {bpms,keys,genres,genreIds,bpm:bpms[0]??null,key:keys[0]??null,states:{bpm:bpms.length?'SPECIFIED':'MISSING',key:keys.length?'SPECIFIED':'MISSING',genreIds:genreIds.length?'SPECIFIED':'MISSING'}};
}
const inferredRecordingCredits=contents=>[...new Map(contents.flatMap(w=>w.credits||[]).map(c=>[JSON.stringify([c.artistId,c.role,c.detail||'']),c])).values()];
const creditNames=(credits,vocabulary)=>credits.map(c=>({...c,artist:vocabulary.get(c.artistId)||null}));
function assertAcyclic(id,sources,rows){
 const graph=new Map(rows.map(row=>[row.externalId,row.sourceRecordingIds||[]]));graph.set(id,sources);
 const state=new Map([[id,1]]),stack=[{node:id,index:0}];
 while(stack.length){const frame=stack[stack.length-1],children=graph.get(frame.node)||[];if(frame.index>=children.length){state.set(frame.node,2);stack.pop();continue;}const child=children[frame.index++];if(state.get(child)===1)fail('Recording sources cannot form a cycle.');if(state.get(child)!==2){state.set(child,1);stack.push({node:child,index:0});}}
}
function matchesWork(r,f={}){
 const w=r.work,l=w?.type==='SONG'?w.lyrics:null,m=w?.melody;
 const has=(items,id)=>!id||items?.some(v=>(typeof v==='string'?v:v.id||v.artistId)===id);
 if(f.recordingType&&r.recordingType!==f.recordingType||f.workType&&w?.type!==f.workType)return false;
 if(f.publicationStatus&&r.publicationStatus!==f.publicationStatus||f.archivalStatus&&r.archivalStatus!==f.archivalStatus)return false;
 if(f.language&&l?.language?.id!==f.language||f.dialect&&l?.dialect?.id!==f.dialect)return false;
 if(!has(l?.regions,f.region)||(!has(l?.concepts,f.concept)&&l?.primaryConcept?.id!==f.concept)||(!has(m?.genres,f.genre)&&!has(r.recordingMetadata?.genreIds,f.genre)))return false;
 if(f.lyricArtist&&!has(l?.artistCredits,f.lyricArtist))return false;
 if(!has(m?.instruments,f.instrument)||!has(m?.musicianCredits,f.musician))return false;
 if(f.artist&&!has([...(r.credits||[]),...(w?.credits||[]),...(m?.musicianCredits||[]),...(l?.artistCredits||[])],f.artist))return false;
 if(f.rhythm&&m?.rhythm?.id!==f.rhythm)return false;
 const scoped=f.bpmScope==='recording'?r.recordingMetadata:m;
 const bpms=scoped?.bpms??(scoped?.bpm==null?[]:[scoped.bpm]),keys=scoped?.keys??(scoped?.key?[scoped.key]:[]);
 if((f.bpmMin!==undefined||f.bpmMax!==undefined)&&!bpms.some(bpm=>(f.bpmMin===undefined||bpm>=Number(f.bpmMin))&&(f.bpmMax===undefined||bpm<=Number(f.bpmMax))))return false;
 if(f.key&&!keys.includes(f.key))return false;
 if(f.q){const q=norm(f.q);const hay=[r.title,w?.title,r.artist,...(r.credits||[]).map(c=>c.artist?.name),...(w?.credits||[]).map(c=>c.artist?.name),...(m?.musicianCredits||[]).map(c=>c.artist?.name),...(m?.instruments||[]).map(i=>i.name),...(l?.artistCredits||[]).map(c=>c.artist?.name),...(m?.genres||[]).map(g=>g.name),...(r.recordingMetadata?.genres||[]).map(g=>g.name)].filter(Boolean).join(' ');if(!norm(hay).includes(q))return false;}
 return true;
}
const amountFor=type=>Object.keys(contract.recordingTypeGroups).find(key=>contract.recordingTypeGroups[key].includes(type))||null;
function matches(r,f={}){
 if(f.recordingAmount&&(r.recordingAmount||amountFor(r.recordingType))!==f.recordingAmount)return false;
 const components=r.componentWorks?.length?r.componentWorks:[r.work];
 return components.some(work=>matchesWork({...r,work},f));
}
function createService({ArchiveModel=ArchiveItem,models=M,deliveryUrl=value=>value,previewUrl=value=>value,ownedAsset=()=>false}={}){
 const {Work,Lyrics,Melody,Vocabulary,AudioAsset,Version}=models;
 async function transaction(fn){
  const session=await mongoose.startSession();
  try{return await session.withTransaction(()=>fn(session));}catch(e){if(/Transaction numbers are only allowed|replica set/.test(e.message))fail('Music ontology writes require MongoDB configured as a replica set (transactions).',503);throw e;}finally{await session.endSession();}
 }
 async function references(ids,kind,session){
  if(!ids.length)return;
  const rows=await Vocabulary.find({externalId:{$in:ids},kind}).session(session).lean();
  if(new Set(rows.map(r=>r.externalId)).size!==new Set(ids).size)fail(`Choose existing ${kind} references.`);
 }
 async function creditsCheck(credits,session){await references(credits.map(c=>c.artistId),'artist',session);}
 const provenance=(p,actor)=>({...p,recordedBy:actor||'admin'});
 async function saveVocabulary(input,id,actor){
  const value=V.vocabulary.parse(input);
  return transaction(async session=>{
   if(value.kind==='dialect'&&!value.parentId)fail('A dialect must reference its parent language.');
   if(value.parentId){if(!['dialect','genre'].includes(value.kind))fail('Only dialects and genres have parents.');await references([value.parentId],value.kind==='dialect'?'language':'genre',session);if(value.parentId===id)fail('An entity cannot be its own parent.');
    let next=value.parentId;const seen=new Set([id]);while(next){if(seen.has(next))fail('Vocabulary hierarchy cannot contain cycles.');seen.add(next);next=(await Vocabulary.findOne({externalId:next}).session(session).lean())?.parentId;}}
   const old=id?await Vocabulary.findOne({externalId:id}).session(session):null;
   if(id&&!old)fail('Metadata entity not found.',404);
   if(old&&(value.kind!==old.kind||value.parentId!==old.parentId))fail('Entity kind and parent identity cannot be changed; create a separate entity.');
   if(old&&value.revision!==old.revision)fail('This entity changed. Reload before editing.',409);
   const data={...value,externalId:id||makeId(value.kind),normalizedName:norm(value.name),provenance:provenance(value.provenance,actor),revision:(old?.revision||0)+1};
   if(old){old.set(data);await old.save({session});return plain(old);}
   return plain((await Vocabulary.create([data],{session}))[0]);
  });
 }
 async function saveWork(input,id,actor){
  const value=V.work.parse(input);
  return transaction(async session=>{
   const old=id?await Work.findOne({externalId:id}).session(session):null;
   if(id&&!old)fail('Musical work not found.',404);
   if(old&&value.revision!==old.revision)fail('This work changed. Reload before editing.',409);
   if(old&&old.type!==value.type)fail('Create a separate work to change Lyrical/Instrumental Music classification; existing work identity is preserved.');
   await creditsCheck(value.credits,session);
   let melodyId=value.melodyId,lyricsId=value.type==='SONG'?value.lyricsId:null;
   if(melodyId&&value.melody)fail('Choose either an existing melody or new melody metadata.');
   if(melodyId&&!await Melody.exists({externalId:melodyId}).session(session))fail('Melody not found.');
   if(!melodyId){const m=V.melody.parse(value.melody||{});if(old){const previous=await Melody.findOne({externalId:old.melodyId}).session(session).lean();for(const field of ['instrumentIds','musicianCredits'])if(!Object.hasOwn(input.melody||{},field)){m[field]=previous?.[field]||[];if(previous?.states?.[field])m.states[field]=previous.states[field];}}await references(m.genreIds,'genre',session);await references(m.instrumentIds,'instrument',session);await creditsCheck(m.musicianCredits,session);if(m.rhythmId)await references([m.rhythmId],'rhythm',session);m.states=V.metadataStates(m,m.states);melodyId=makeId('melody');await Melody.create([{...m,externalId:melodyId,provenance:provenance(m.provenance,actor)}],{session});}
   if(value.type==='SONG'){
    if(lyricsId&&value.lyrics)fail('Choose either existing lyrics or new lyrics metadata.');
    if(lyricsId&&!await Lyrics.exists({externalId:lyricsId}).session(session))fail('Lyrics not found.');
    if(!lyricsId){const l=V.lyrics.parse(value.lyrics||{});if(l.languageId)await references([l.languageId],'language',session);if(l.dialectId){await references([l.dialectId],'dialect',session);const d=await Vocabulary.findOne({externalId:l.dialectId}).session(session);if(!l.languageId||d.parentId!==l.languageId)fail('Dialect must belong to the selected lyrics language.');}
     await references(l.regionIds,'region',session);await references(l.conceptIds,'concept',session);if(l.primaryConceptId)await references([l.primaryConceptId],'concept',session);await creditsCheck(l.artistCredits,session);if(l.completeness==='COMPLETE'&&(!l.text||!l.languageId))fail('Complete lyrics require text and a language.');l.states=V.metadataStates(l,l.states);lyricsId=makeId('lyrics');await Lyrics.create([{...l,externalId:lyricsId,provenance:provenance(l.provenance,actor)}],{session});}
   }
   // Work revisions use new component identities, preserving reused components and provenance.
   const data={title:value.title,type:value.type,workKind:value.workKind,description:value.description,credits:value.credits,melodyId,lyricsId,provenance:provenance(value.provenance,actor),revision:(old?.revision||0)+1};
   if(old){old.set(data);await old.save({session});return old.externalId;}
   const row=(await Work.create([{...data,externalId:makeId('work')}],{session}))[0];return row.externalId;
  });
 }
 async function saveRecording(input,id,actor,migration=null){
  const v=V.recording.parse(input);
  return transaction(async session=>{
   const old=id?await ArchiveModel.findOne({externalId:id}).session(session):null;
   if(id&&!old)fail('Recording not found.',404);
   if(old&&v.revision!==(old.ontologyRevision||0))fail('This recording changed. Reload before editing.',409);
   const work=await Work.findOne({externalId:v.workId}).session(session);
   if(!work)fail('Choose an existing musical work.');
   const componentWorkIds=[...new Set([v.workId,...(v.componentWorkIds??old?.componentWorkIds??[])])];
   if(componentWorkIds.length>100)fail('Choose at most 100 component works.');
   if(await Work.countDocuments({externalId:{$in:componentWorkIds}}).session(session)!==componentWorkIds.length)fail('Choose existing recording component works.');
   if(v.audioUrl&&!ownedAsset(v.audioUrl)||v.coverImage&&!ownedAsset(v.coverImage))fail('Choose media uploaded to this website.');
   if(v.audioUrl&&!require('../music-archive-files').localAssetPattern.test(v.audioUrl)&&!/\/video\/(upload|authenticated)\//.test(v.audioUrl))fail('Choose an uploaded audio asset.');
   if(v.publicationStatus==='PUBLISHED'&&(!v.audioUrl||v.archivalStatus!=='ACTIVE'))fail('Published recordings require audio and active archival status.');
   const sources=await ArchiveModel.find({externalId:{$in:v.sourceRecordingIds}}).session(session).lean();
   if(sources.length!==v.sourceRecordingIds.length)fail('Choose existing source recordings.');
   const works=await Work.find({externalId:{$in:v.sourceWorkIds}}).session(session).lean();if(works.length!==v.sourceWorkIds.length)fail('Choose existing source works.');
   const recordId=id||makeId('recording');
   assertAcyclic(recordId,v.sourceRecordingIds,await ArchiveModel.find({}).session(session).lean());
   // Serialize source-graph changes across transactions to prevent concurrent A→B/B→A write skew.
   await mongoose.connection.collection('musicontologylocks').updateOne({_id:'source-graph'},{$inc:{revision:1}},{upsert:true,session});
   let audioAssetId='';
   if(v.audioUrl){const existing=await AudioAsset.findOne({url:v.audioUrl}).session(session);audioAssetId=existing?.externalId||`audio-${createHash('sha256').update(v.audioUrl).digest('hex')}`;if(!existing)await AudioAsset.create([{externalId:audioAssetId,url:v.audioUrl,durationSeconds:v.durationSeconds,provenance:provenance(v.provenance,actor)}],{session});}
   const duration=v.durationSeconds==null?'':`${Math.floor(v.durationSeconds/60)}:${String(Math.floor(v.durationSeconds%60)).padStart(2,'0')}`;
   const data={title:v.title,recordingType:v.recordingType,recordingAmount:amountFor(v.recordingType),componentWorkIds,workId:v.workId,audioAssetId,sourceRecordingIds:v.sourceRecordingIds,sourceWorkIds:v.sourceWorkIds,publicationStatus:v.publicationStatus,archivalStatus:v.archivalStatus,versionLabel:v.versionLabel,productionNotes:v.productionNotes,provenance:provenance(v.provenance,actor),ontologyRevision:(old?.ontologyRevision||0)+1,description:v.description,date:v.releaseDate,audioUrl:v.audioUrl,coverImage:v.coverImage,duration,published:v.publicationStatus==='PUBLISHED'&&v.archivalStatus==='ACTIVE',mediaType:'audio'};
   if(migration){for(const key of ['title','description','date','audioUrl','coverImage','duration','mediaType'])delete data[key];data.ontologyMigrationId=migration.runId;await mongoose.connection.collection('musicontologymigrationbackups').insertOne({_id:`${migration.runId}:${recordId}`,runId:migration.runId,recordingId:recordId,before:plain(old),afterRevision:data.ontologyRevision,createdAt:new Date()},{session});}
   let row;
   if(old){old.set(data);row=await old.save({session});}else row=(await ArchiveModel.create([{...data,externalId:recordId,category:'Music Archive',artist:''}],{session}))[0];
   await Version.create([{externalId:makeId('version'),recordingId:recordId,number:data.ontologyRevision,snapshot:plain(row),changedBy:actor||'admin'}],{session});
   return recordId;
  });
 }
 async function workMap(ids){
  const works=await Work.find({externalId:{$in:ids}}).lean();
  const [melodies,lyrics,vocabulary]=await Promise.all([Melody.find({externalId:{$in:works.map(w=>w.melodyId)}}).lean(),Lyrics.find({externalId:{$in:works.map(w=>w.lyricsId).filter(Boolean)}}).lean(),Vocabulary.find({}).lean()]);
  const vs=new Map(vocabulary.map(v=>[v.externalId,{...v,id:v.externalId,_id:undefined}]));
  const entity=(kind,id)=>vs.get(id)?.kind===kind?vs.get(id):null;
  const mm=new Map(melodies.map(m=>[m.externalId,m])),lm=new Map(lyrics.map(l=>[l.externalId,l]));
  const mapped=works.map(w=>{
   const m=mm.get(w.melodyId),l=lm.get(w.lyricsId);
   return [w.externalId,{...w,id:w.externalId,_id:undefined,credits:creditNames(w.credits||[],vs),melody:m?{...m,id:m.externalId,_id:undefined,rhythm:entity('rhythm',m.rhythmId),genres:(m.genreIds||[]).map(id=>entity('genre',id)).filter(Boolean),instruments:(m.instrumentIds||[]).map(id=>entity('instrument',id)).filter(Boolean),musicianCredits:creditNames(m.musicianCredits||[],vs)}:null,lyrics:w.type==='SONG'&&l?{...l,id:l.externalId,_id:undefined,language:entity('language',l.languageId),dialect:entity('dialect',l.dialectId),regions:(l.regionIds||[]).map(id=>entity('region',id)).filter(Boolean),primaryConcept:entity('concept',l.primaryConceptId),concepts:(l.conceptIds||[]).map(id=>entity('concept',id)).filter(Boolean),artistCredits:creditNames(l.artistCredits||[],vs)}:null}];
  });return {works:new Map(mapped),vocabulary:vs};
 }
 async function hydrate(rows,{admin=false}={}){
  rows=rows.map(plain);const {works,vocabulary}=await workMap([...new Set(rows.flatMap(r=>[r.workId,...(r.componentWorkIds||[])]).filter(Boolean))]);
  const assets=await AudioAsset.find({externalId:{$in:rows.map(r=>r.audioAssetId).filter(Boolean)}}).lean();const am=new Map(assets.map(a=>[a.externalId,a]));
  return rows.map(r=>{
   const w=works.get(r.workId)||null,a=am.get(r.audioAssetId),deliver=url=>admin?previewUrl(deliveryUrl(url)):deliveryUrl(url);
   const componentWorkIds=[...new Set([r.workId,...(r.componentWorkIds||[])].filter(Boolean))],componentWorks=componentWorkIds.map(id=>works.get(id)).filter(Boolean);
   const artist=[...new Set([...inferredRecordingCredits(componentWorks),...componentWorks.flatMap(c=>[...(c.credits||[]),...(c.melody?.musicianCredits||[]),...(c.lyrics?.artistCredits||[])])].map(c=>vocabulary.get(c.artistId)?.name).filter(Boolean))].join(', ')||(!r.workId?r.artist||'':'');
   return {id:r.externalId,title:r.title,description:r.description||'',recordingType:contract.recordingTypes.includes(r.recordingType)?r.recordingType:null,recordingAmount:r.recordingAmount||amountFor(r.recordingType),componentWorkIds,componentWorks,workId:r.workId||null,work:w,ontologyStatus:r.workId?'MAPPED':'UNMAPPED',recordingMetadata:inferredRecordingMetadata(componentWorks),credits:inferredRecordingCredits(componentWorks),sourceRecordingIds:r.sourceRecordingIds||[],sourceWorkIds:r.sourceWorkIds||[],publicationStatus:r.publicationStatus||(r.published!==false?'PUBLISHED':'DRAFT'),archivalStatus:r.archivalStatus||'ACTIVE',revision:r.ontologyRevision||0,versionLabel:r.versionLabel||'',productionNotes:r.productionNotes||'',provenance:r.provenance||null,audio:{assetId:r.audioAssetId||null,url:deliver(r.audioUrl||a?.url||''),durationSeconds:r.duration?String(r.duration).split(':').reduce((t,n)=>t*60+Number(n),0):(a?.durationSeconds??null)},audioUrl:deliver(r.audioUrl||''),coverImage:deliver(r.coverImage||r.image||''),artist,duration:r.duration||'',date:r.date||'',releaseDate:r.date||'',createdAt:r.createdAt,updatedAt:r.updatedAt,sortOrder:r.sortOrder||0,published:r.published!==false,...(admin?{storedAudioUrl:r.audioUrl||'',storedCoverImage:r.coverImage||r.image||''}:{})};
  });
 }
 async function list(admin=false,filters={}){
  const rows=admin?await ArchiveModel.find().sort({sortOrder:1,createdAt:-1}):await require('../music-archive').publicSongs();
  return (await hydrate(rows.filter(r=>admin||r.audioUrl),{admin})).filter(r=>matches(r,filters));
 }
 async function preflightRecording(input,id){
  const v=V.recording.parse(input);
  if(!await Work.exists({externalId:v.workId}))fail('Choose an existing musical work.');
  const componentIds=[...new Set([v.workId,...(v.componentWorkIds||[])])];
  if(componentIds.length>100||await Work.countDocuments({externalId:{$in:componentIds}})!==componentIds.length)fail('Choose up to 100 existing recording component works.');
  if(v.audioUrl&&!ownedAsset(v.audioUrl)||v.coverImage&&!ownedAsset(v.coverImage))fail('Choose media uploaded to this website.');
  if(v.audioUrl&&!require('../music-archive-files').localAssetPattern.test(v.audioUrl)&&!/\/video\/(upload|authenticated)\//.test(v.audioUrl))fail('Choose an uploaded audio asset.');
  if(v.publicationStatus==='PUBLISHED'&&(!v.audioUrl||v.archivalStatus!=='ACTIVE'))fail('Published recordings require audio and active archival status.');
  if(await ArchiveModel.countDocuments({externalId:{$in:v.sourceRecordingIds}})!==v.sourceRecordingIds.length)fail('Choose existing source recordings.');
  if(await Work.countDocuments({externalId:{$in:v.sourceWorkIds}})!==v.sourceWorkIds.length)fail('Choose existing source works.');
  assertAcyclic(id||'__new_recording__',v.sourceRecordingIds,await ArchiveModel.find({}).lean());
  return v;
 }
 async function deleteLegacy(id){return transaction(async session=>{await mongoose.connection.collection('musicontologylocks').updateOne({_id:'source-graph'},{$inc:{revision:1}},{upsert:true,session});const row=await ArchiveModel.findOne({externalId:id}).session(session);if(!row)return null;if(row.workId)fail('Archive this recording through the ontology editor.',409);if(await ArchiveModel.exists({sourceRecordingIds:id}).session(session))fail('This recording is used as a source; retain its identity and media.',409);return ArchiveModel.findOneAndDelete({externalId:id}).session(session);});}
 return {transaction,saveVocabulary,saveWork,saveRecording,hydrate,list,workMap,models,contract,deleteLegacy,preflightRecording};
}
module.exports={createService,assertAcyclic,matches,norm,fail};
