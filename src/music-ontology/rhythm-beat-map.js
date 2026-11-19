const {z}=require('zod');
const patterns=require('../../contracts/rhythm-patterns.json');
const normalize=name=>String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().replace(/\b\d+\s*\/\s*\d+\b/g,'').replace(/[^\p{L}\p{N}]/gu,'');
const beatMap=z.object({meter:z.string().regex(/^(?:[1-9]|1[0-6])\/(?:4|8)$/),subdivision:z.union([z.literal(1),z.literal(2),z.literal(4)]),steps:z.array(z.enum(['D','T','K','.'])).min(1).max(64),source:z.string().url().max(2048).refine(url=>['https:','http:'].includes(new URL(url).protocol)).optional()}).strict().superRefine((value,ctx)=>{if(value.steps.length!==Number(value.meter.split('/')[0])*value.subdivision)ctx.addIssue({code:'custom',message:'The beat map must fill exactly one bar.'});if(value.steps.every(step=>step==='.'))ctx.addIssue({code:'custom',message:'Add at least one drum hit.'});});
function beatMapFor(name){const key=normalize(name),row=patterns.find(row=>row.aliases.some(alias=>normalize(alias)===key));return row?{meter:row.meter,subdivision:row.subdivision,steps:[...row.steps],source:row.source}:null;}
module.exports={beatMap,beatMapFor};
