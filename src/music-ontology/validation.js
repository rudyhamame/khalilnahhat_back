const {z}=require('zod');
const c=require('../../contracts/music-ontology.json');
const id=z.string().trim().min(1).max(160);
const text=z.string().trim().max(8000);
const short=z.string().trim().max(240);
const nullableId=id.nullable().default(null);
const ids=z.array(id).max(100).refine(a=>new Set(a).size===a.length,'Choose distinct references.').default([]);
const states=z.record(z.string().max(80),z.enum(c.metadataStates)).default({});
const key=short.regex(new RegExp(c.keyPattern),'Use a musical key such as C major or F# minor.').nullable().default(null);
const bpm=z.number().finite().positive().max(1000).nullable().default(null);
const provenance=z.object({source:z.string().max(2048).default(''),note:text.default('')}).strict().default({source:'',note:''});
const credits=z.array(z.object({artistId:id,role:z.enum(c.creditRoles),detail:short.default('')}).strict()).max(100).default([]);
const musicians=z.array(z.object({artistId:id,role:z.enum(c.musicianRoles),detail:short.default('')}).strict()).max(100).default([]);
const melody=z.object({bpm,key,rhythmId:nullableId,genreIds:ids,instrumentIds:ids,musicianCredits:musicians,timeSignature:short.regex(/^$|^\d{1,2}\/(?:1|2|4|8|16|32)$/).default(''),mode:short.default(''),description:text.default(''),influences:z.array(short).max(100).default([]),states,provenance}).strict();
const lyrics=z.object({languageIds:ids.optional(),audioLanguageCodes:z.array(z.string().regex(/^[a-z]{2,3}$/)).max(20).optional(),languageId:nullableId,dialectId:nullableId,regionIds:ids,artistCredits:credits,primaryConceptId:nullableId,conceptIds:ids,releaseYear:z.number().int().min(1000).max(2100).nullable().default(null),conceptLabel:short.default(''),conceptSummary:text.default(''),text:z.string().max(100000).default(''),script:short.default(''),translationRefs:z.array(z.string().url().max(2048).refine(v=>['https:','http:'].includes(new URL(v).protocol),'Use an HTTP or HTTPS translation reference.')).max(50).default([]),notes:text.default(''),completeness:z.enum(['INCOMPLETE','COMPLETE']).default('INCOMPLETE'),states,provenance}).strict();
const work=z.object({title:short.min(1),type:z.enum(c.workTypes),workKind:z.string().trim().min(1).max(120).default('ORIGINAL'),description:text.default(''),melodyId:id.optional(),lyricsId:nullableId.optional(),melody:melody.optional(),lyrics:lyrics.nullable().optional(),credits,provenance,revision:z.number().int().positive().optional()}).strict().superRefine((v,ctx)=>{if(v.type==='MUSIC'&&(v.lyrics||v.lyricsId))ctx.addIssue({code:'custom',message:'Instrumental Music cannot have Lyrics.'});});
const lyricLine=z.object({start:z.number().finite().nonnegative().max(86400),end:z.number().finite().positive().max(86400),text:z.string().trim().min(1).max(4000)}).strict().refine(line=>line.end>line.start,'Lyric end time must follow start time.');
const lyricsTiming=z.object({audioUrl:z.string().min(1).max(2048),workId:id,model:z.enum(['whisper-1']),lines:z.array(lyricLine).min(1).max(3000)}).strict().refine(value=>value.lines.every((line,i)=>!i||line.start>=value.lines[i-1].start),'Lyric lines must be ordered by start time.');
const recording=z.object({lyricsTiming:lyricsTiming.nullable().optional(),title:short.min(1),recordingType:id,recordingAmount:z.enum(c.recordingAmounts).optional(),componentWorkIds:ids.optional(),workId:id,audioUrl:z.string().max(2048).default(''),coverImage:z.string().max(2048).default(''),durationSeconds:z.number().finite().nonnegative().max(86400).nullable().default(null),description:text.default(''),releaseDate:z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).refine(v=>!v||(!isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v),'Choose a valid release date.').default(''),recordingMetadata:z.object({bpm,key,bpms:z.array(z.number().finite().positive().max(1000)).max(100).refine(a=>new Set(a).size===a.length,'Choose distinct BPM values.').optional(),keys:z.array(short.regex(new RegExp(c.keyPattern))).max(100).refine(a=>new Set(a).size===a.length,'Choose distinct keys.').optional(),genreIds:ids.optional(),states}).strict().default({bpm:null,key:null,states:{}}),credits,sourceRecordingIds:ids,sourceWorkIds:ids,publicationStatus:z.enum(c.publicationStatuses).default('DRAFT'),archivalStatus:z.enum(c.archivalStatuses).default('ACTIVE'),versionLabel:short.default(''),productionNotes:text.default(''),provenance,revision:z.number().int().nonnegative().optional()}).strict();
const vocabulary=z.object({languageIds:ids.optional(),kind:z.enum(c.vocabularyKinds),name:short.min(1),parentId:z.string().max(160).default(''),isoCode:z.string().max(20).default(''),description:text.default(''),provenance,revision:z.number().int().positive().optional()}).strict().refine(v=>!v.isoCode||(v.kind==='language'&&/^[a-z]{2,3}$/.test(v.isoCode)),'ISO language codes must be two or three lowercase letters, on a language entity.');
function metadataStates(values,explicit={}){
 const result={...explicit};
 for(const [field,value] of Object.entries(values)){
  if(field==='states'||field==='provenance')continue;
  const specified=Array.isArray(value)?value.length>0:value!==null&&value!==undefined&&value!=='';
  if(specified&&result[field]&&result[field]!=='SPECIFIED')throw Object.assign(new Error(`${field}: a specified value cannot be marked ${result[field]}.`),{status:400});
  if(!specified&&result[field]==='SPECIFIED')throw Object.assign(new Error(`${field}: enter the specified value.`),{status:400});
  result[field]=specified?'SPECIFIED':result[field]||'MISSING';
 }
 return result;
}
module.exports={work,recording,vocabulary,melody,lyrics,metadataStates};
