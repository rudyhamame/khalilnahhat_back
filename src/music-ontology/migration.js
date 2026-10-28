const {randomUUID}=require('crypto');
const {createService,fail}=require('./service');
const {ArchiveItem}=require('../models');
const mongoose=require('mongoose');
const duration=value=>{const n=String(value||'').split(':').reduce((s,p)=>s*60+Number(p),0);return value&&Number.isFinite(n)&&n>=0?n:null;};
function migrationInput(row,mapping){
 const bpm=row.bpm&&Number(row.bpm)>0&&Number(row.bpm)<=1000?Number(row.bpm):null;
 const key=/^[A-G](?:#|b)? (?:major|minor)$/.test(row.musicalKey||'')?row.musicalKey:null;
 return {title:row.title,recordingType:mapping.recordingType,workId:mapping.workId,audioUrl:row.audioUrl||'',coverImage:row.coverImage||row.image||'',durationSeconds:duration(row.duration),albumId:row.albumId||'',description:row.description||'',releaseDate:/^\d{4}-\d{2}-\d{2}$/.test(row.date||'')?row.date:'',recordingMetadata:{bpm,key,states:{bpm:bpm?'SPECIFIED':'UNKNOWN',key:key?'SPECIFIED':'UNKNOWN'}},credits:mapping.credits||[],sourceRecordingIds:mapping.sourceRecordingIds||[],sourceWorkIds:mapping.sourceWorkIds||[],publicationStatus:row.published!==false&&row.audioUrl?'PUBLISHED':'DRAFT',archivalStatus:'ACTIVE',versionLabel:'',productionNotes:'Legacy fields retained verbatim on the existing recording. Unmapped metadata requires review.',provenance:{source:'Legacy archive',note:`Reviewed mapping ${mapping.note||''}`},revision:row.ontologyRevision||0};
}
async function audit(){
 const rows=await ArchiveItem.find().lean();
 return {total:rows.length,mapped:rows.filter(r=>r.workId).length,unmapped:rows.filter(r=>!r.workId).length,withAudio:rows.filter(r=>r.audioUrl).length,withLegacyLyricsMetadata:rows.filter(r=>r.lyricsLanguage||r.lyricsSummary).length,recordings:rows.map(r=>({id:r.externalId,title:r.title,legacyTrackClass:r.trackClass||null,legacyLanguage:r.lyricsLanguage||r.language||null,legacyBpm:r.bpm||null,hasAudio:Boolean(r.audioUrl),mapped:Boolean(r.workId)}))};
}
async function migrate(mapping,{apply=false,runId=randomUUID(),service}={}){
 if(!Array.isArray(mapping)||new Set(mapping.map(m=>m.recordingId)).size!==mapping.length)fail('Provide an array with distinct recordingId mappings.');
 const plan=[];
 for(const m of mapping){const row=await ArchiveItem.findOne({externalId:m.recordingId}).lean();if(!row)fail(`Recording not found: ${m.recordingId}`);if(row.workId)fail(`Recording is already mapped: ${m.recordingId}`);const body=require('./validation').recording.parse(migrationInput(row,m));if(!await require('./models').Work.exists({externalId:body.workId}))fail(`Create and review the primary work first: ${body.workId}`);if(service)await service.preflightRecording(body,m.recordingId);plan.push({recordingId:m.recordingId,input:body});}
 if(apply){if(!service)fail('An asset-validating archive service is required.');for(const item of plan)await service.saveRecording(item.input,item.recordingId,'migration',{runId});}
 return {runId,applied:apply,plan};
}
async function rollback(runId,{apply=false,service=createService()}={}){
 const backups=await mongoose.connection.collection('musicontologymigrationbackups').find({runId}).toArray();
 const plan=[];
 for(const b of backups){const row=await ArchiveItem.findOne({externalId:b.recordingId}).lean();if(!row||row.ontologyMigrationId!==runId||row.ontologyRevision!==b.afterRevision)fail(`Recording changed after migration; rollback refused: ${b.recordingId}`,409);plan.push(b.recordingId);}
 if(apply)await service.transaction(async session=>{for(const b of backups){const result=await ArchiveItem.collection.replaceOne({externalId:b.recordingId,ontologyMigrationId:runId,ontologyRevision:b.afterRevision},b.before,{session});if(result.matchedCount!==1)fail('Recording changed during rollback.',409);await require('./models').Version.deleteOne({recordingId:b.recordingId,number:b.afterRevision}).session(session);await mongoose.connection.collection('musicontologymigrationbackups').updateOne({_id:b._id},{$set:{rolledBackAt:new Date()}},{session});}});
 return {runId,applied:apply,recordingIds:plan,retained:'Works, component identities, audio assets and media files are retained for recovery and reuse.'};
}
module.exports={migrationInput,audit,migrate,rollback};
