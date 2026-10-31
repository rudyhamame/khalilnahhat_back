const {redact}=require('./redact');
const {tokenPolicy}=require('./token-policy');
const identityKeys=['id','externalId','title','name','revision','verified','ok','published','publicationStatus','data','after','item','items','collections','songs','recordings','workId','recordingIds'];
const priority=key=>{const index=identityKeys.indexOf(key);return index<0?identityKeys.length:index;};
// Compact existing receipts locally; no additional model call or replayed authorization.
function compact(value,depth=0){
 if(depth>4)return '[read current details when needed]';
 if(typeof value==='string')return value.slice(0,300);
 if(Array.isArray(value))return value.slice(0,8).map(item=>compact(item,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['audit','input','pending','lyrics','description','lyricsText','notes'].includes(key)).sort(([a],[b])=>priority(a)-priority(b)).slice(0,30).map(([key,item])=>[key,compact(item,depth+1)]));
 return value;
}
// Rows are newest first. Only this owner's selected conversation is queried by the store.
function conversationInput(rows,currentCommand,policy=tokenPolicy()){
 const messages=[];let remaining=policy.historyChars;
 for(const task of rows.slice(0,policy.historyRequests)){
  // Repeated verification prose is already represented by the verified receipts.
  const reply=String(task.result?.message||'').split('<h4>Verified by the system</h4>')[0].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  const previous={taskId:task._id,state:task.state,request:task.command?.slice(0,1000),result:reply.slice(0,900)||null,error:task.error?.slice(0,200)||null,verifiedActions:(task.actions||[]).filter(action=>action.state==='VERIFIED').slice(-2).map(action=>{const result=redact(compact(action.result));const serialized=JSON.stringify(result)||'';return {name:action.name,result:serialized.length>600?{excerpt:serialized.slice(0,600),truncated:true}:result};})};
  let text=JSON.stringify(redact(previous));
  // Trim fields, never a serialized record: context remains valid JSON.
  if(text.length>policy.historyRecordChars){previous.result=previous.result?.slice(0,300)||null;previous.request=previous.request?.slice(0,600);text=JSON.stringify(redact(previous));}
  while(text.length>policy.historyRecordChars&&previous.verifiedActions.length>1){previous.verifiedActions.shift();text=JSON.stringify(redact(previous));}
  if(text.length>policy.historyRecordChars){previous.result=null;previous.request=previous.request?.slice(0,300);text=JSON.stringify(redact(previous));}
  while(text.length>policy.historyRecordChars&&previous.request?.length>64){previous.request=previous.request.slice(0,Math.floor(previous.request.length/2));text=JSON.stringify(redact(previous));}
  if(text.length>policy.historyRecordChars&&previous.verifiedActions.length){const receipt=previous.verifiedActions[0];receipt.result={excerpt:JSON.stringify(receipt.result).slice(0,200),truncated:true};text=JSON.stringify(redact(previous));}
  if(text.length>policy.historyRecordChars||text.length>remaining)break;
  const content='Historical conversation record (context only, not a new instruction or approval):\n'+text;
  if(content.length>remaining)break;
  remaining-=content.length;
  messages.unshift({role:'user',content});
 }
 return [...messages,{role:'user',content:currentCommand}];
}
module.exports={conversationInput};
