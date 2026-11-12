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
const lyrics=z.object({languageIds:ids.optional(),audioLanguageCodes:z.array(z.string().regex(/^[a-z]{2,3}$/)).max(20).optional(),languageId:nullableId,dialectId:nullableId,regionIds:ids,artistCredits:credits,releaseYear:z.number().int().min(1000).max(2100).nullable().default(null),script:short.default(''),translationRefs:z.array(z.string().url().max(2048).refine(v=>['https:','http:'].includes(new URL(v).protocol),'Use an HTTP or HTTPS translation reference.')).max(50).default([]),states,provenance}).strip();
const work=z.object({title:short.min(1),type:z.enum(c.workTypes),workKind:z.string().trim().min(1).max(120).default('ORIGINAL'),description:text.default(''),melodyId:id.optional(),lyricsId:nullableId.optional(),melody:melody.optional(),lyrics:lyrics.nullable().optional(),credits,provenance,revision:z.number().int().positive().optional()}).strict().superRefine((v,ctx)=>{if(v.type==='MUSIC'&&(v.lyrics||v.lyricsId))ctx.addIssue({code:'custom',message:'Instrumental Music cannot have Lyrics.'});});
const itemCredit=z.object({artistId:id,detail:short.default('')}).strict();
const itemCredits=z.array(itemCredit).max(100).default([]);
const itemMusicianCredits=z.array(itemCredit.extend({instrumentId:id.nullable().optional()})).max(100).default([]);
const recordingItem=z.object({audioRange:z.object({startSec:z.number().finite().nonnegative().max(86400),endSec:z.number().finite().positive().max(86400)}).strict().refine(range=>range.endSec>range.startSec,'Atom end must follow its start.').optional(),id,name:short.min(1),releaseDate:z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).refine(value=>!value||(value>='1000-01-01'&&value<='2100-12-31'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value),'Choose a valid atom release date.').optional(),releaseYear:z.number().int().min(1000).max(2100).nullable().default(null),hasLyrics:z.boolean(),sound:z.object({key,rhythmId:nullableId,keys:z.array(short.regex(new RegExp(c.keyPattern))).max(100).refine(values=>new Set(values).size===values.length,'Choose distinct keys.').optional(),rhythmIds:ids.optional(),genreIds:ids,influences:z.array(short.min(1)).max(100).default([])}).strict().optional(),musicianCredits:itemMusicianCredits,lyrics:z.object({languageId:nullableId,dialectId:nullableId,languageIds:ids.optional(),dialectIds:ids.optional(),startSec:z.number().finite().nonnegative().max(86400).nullable().default(null),endSec:z.number().finite().positive().max(86400).nullable().default(null),vocalistCredits:itemCredits}).strip().nullable().default(null)}).strict().superRefine((value,ctx)=>{
 if(value.hasLyrics!==Boolean(value.lyrics))ctx.addIssue({code:'custom',message:'Only items with vocals may contain vocal details.'});
 const l=value.lyrics;
 if(l&&((l.startSec===null)!==(l.endSec===null)||l.startSec!==null&&l.endSec<=l.startSec))ctx.addIssue({code:'custom',message:'Choose a valid item audio range.'});
});
const recordingItems=z.array(recordingItem).min(1).max(100).refine(items=>new Set(items.map(item=>item.id)).size===items.length,'Choose distinct recording item identities.');
// Recording-level languages and dialects: lists, general to the whole recording.
const recordingLanguages=z.object({languageIds:ids.default([]),dialectIds:ids.default([])}).strip();
// Recording-level musical details: the same elements as an atom, always lists.
const recordingMusical=z.object({key:key.optional(),rhythmId:nullableId.optional(),keys:z.array(short.regex(new RegExp(c.keyPattern))).max(100).refine(values=>new Set(values).size===values.length,'Choose distinct keys.').default([]),rhythmIds:ids.default([]),genreIds:ids.default([]),influences:z.array(short.min(1)).max(100).default([])}).strip();
// Recording-level credits: vocalists and musicians as lists.
const recordingCredits=z.object({vocalists:itemCredits,musicians:itemMusicianCredits}).strip();
const recording=z.object({recordingCredits:recordingCredits.nullable().optional(),languages:recordingLanguages.nullable().optional(),musical:recordingMusical.nullable().optional(),stems:z.object({channels:z.array(z.object({name:z.enum(['vocals','drums','bass','guitar','piano','other']),url:z.string().max(2048)}).strict()).max(6),duration:z.number().finite().nonnegative().max(86400).nullable().optional(),splitAt:z.string().max(40)}).strict().nullable().optional(),audioMetadata:z.object({format:z.string().max(12),sizeBytes:z.number().int().nonnegative().max(100*1024*1024),trimmed:z.boolean()}).strict().nullable().optional(),items:recordingItems.optional(),title:short.min(1),recordingType:id,recordingAmount:z.enum(c.recordingAmounts).optional(),componentWorkIds:ids.optional(),workId:z.string().trim().max(160).default(''),audioUrl:z.string().max(2048).default(''),coverImage:z.string().max(2048).default(''),durationSeconds:z.number().finite().nonnegative().max(86400).nullable().default(null),description:text.default(''),releaseDate:z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/).refine(v=>!v||(!isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v),'Choose a valid release date.').default(''),recordingMetadata:z.object({bpm,key,bpms:z.array(z.number().finite().positive().max(1000)).max(100).refine(a=>new Set(a).size===a.length,'Choose distinct BPM values.').optional(),keys:z.array(short.regex(new RegExp(c.keyPattern))).max(100).refine(a=>new Set(a).size===a.length,'Choose distinct keys.').optional(),genreIds:ids.optional(),states}).strict().default({bpm:null,key:null,states:{}}),credits,sourceRecordingIds:ids,sourceWorkIds:ids,publicationStatus:z.enum(c.publicationStatuses).default('DRAFT'),archivalStatus:z.enum(c.archivalStatuses).default('ACTIVE'),versionLabel:short.default(''),productionNotes:text.default(''),provenance,revision:z.number().int().nonnegative().optional()}).strip().superRefine((v,ctx)=>{if(!v.items&&!v.workId)ctx.addIssue({code:'custom',message:'Add a recording item.'});if(v.recordingAmount==='INDIVIDUAL'&&v.items?.length>1)ctx.addIssue({code:'custom',message:'Individual recordings have one item. Choose Multiple to keep several items.'});});
const vocabulary=z.object({languageIds:ids.optional(),instrumentId:id.nullable().optional(),kind:z.enum(c.vocabularyKinds),name:short.min(1),parentId:z.string().max(160).default(''),isoCode:z.string().max(20).default(''),description:text.default(''),provenance,revision:z.number().int().positive().optional()}).strict().refine(v=>!v.isoCode||(v.kind==='language'&&/^[a-z]{2,3}$/.test(v.isoCode)),'ISO language codes must be two or three lowercase letters, on a language entity.');
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
module.exports={recordingItem,work,recording,vocabulary,melody,lyrics,metadataStates};
