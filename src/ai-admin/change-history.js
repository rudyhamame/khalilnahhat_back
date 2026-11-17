const {redact}=require('./redact');
const metadata=new Set(['_id','id','revision','ontologyRevision','createdAt','updatedAt','__v']);
function atoms(value,path='',out=new Map()){
 if(value&&typeof value==='object'&&Object.keys(value).length){
  for(const [key,child] of Object.entries(value)){
   if(!path&&metadata.has(key))continue;
   atoms(child,path?`${path}.${key}`:key,out);
  }
 }else out.set(path||'value',value);
 return out;
}
function changedAtoms(before,after){
 const old=atoms(redact(before||{})),next=atoms(redact(after||{}));
 // A missing snapshot is an empty object, not a change to an atom named "value".
 if(!before||!Object.keys(before).length)old.delete('value');
 if(!after||!Object.keys(after).length)next.delete('value');
 return [...new Set([...old.keys(),...next.keys()])].flatMap(path=>{
  const a=old.get(path),b=next.get(path);
  if(a==='[redacted]'||b==='[redacted]'||JSON.stringify(a)===JSON.stringify(b))return [];
  return [{path,before:a??null,after:b??null}];
 });
}
function taskChanges(task){
 return (task.actions||[]).flatMap(action=>{
  if(action.state!=='VERIFIED'||action.result?.verified!==true||!action.prepared||!Object.hasOwn(action.result,'after'))return [];
  const changes=changedAtoms(action.prepared.before,action.result.after);
  if(!changes.length)return [];
  const at=(task.audit||[]).findLast(event=>event.type==='TOOL_VERIFIED'&&event.actionId===action.id)?.at||task.updatedAt||action.createdAt||task.createdAt;
  return [{id:`${task._id}:${action.id}`,taskId:task._id,tool:action.name,title:redact(task.command||''),at,changes}];
 }).reverse();
}
module.exports={changedAtoms,taskChanges};
