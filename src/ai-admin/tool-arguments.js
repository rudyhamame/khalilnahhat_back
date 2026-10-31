// Parse provider output without guessing, evaluating code, or repairing broken
// JSON. The registered tool schema remains authoritative for every accepted form.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function parseToolArguments(raw,entry){
 if(typeof raw!=='string')throw Error('Tool arguments must be a JSON object.');
 let outer;try{outer=JSON.parse(raw);}catch{throw Error('Tool arguments are not valid JSON.');}
 if(!object(outer))throw Error('Tool arguments must be a JSON object.');
 let args=outer;
 if(Object.hasOwn(outer,'arguments_json')){
  if(Object.keys(outer).length!==1)throw Error('The arguments_json wrapper must not contain other fields.');
  if(typeof outer.arguments_json==='string'){
   try{args=JSON.parse(outer.arguments_json);}catch{throw Error('arguments_json must contain valid JSON, with correctly escaped strings.');}
  }else args=outer.arguments_json;
 }
 if(!object(args))throw Error('The tool input must be an object, not a string, list, or null.');
 const parsed=entry.schema.safeParse(args);
 if(!parsed.success){
  const issues=parsed.error.issues.slice(0,5).map(issue=>`${issue.path.join('.')||'input'}: ${issue.message}`);
  throw Error('Tool input does not match its schema: '+issues.join('; '));
 }
 return parsed.data;
}
module.exports={parseToolArguments};
