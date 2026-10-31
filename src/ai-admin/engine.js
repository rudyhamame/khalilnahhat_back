const {randomUUID}=require('node:crypto');
const {z}=require('zod');
const {failure}=require('./route-adapter');
const {redact}=require('./redact');
const {conversationInput}=require('./conversation');
const commandSchema=z.object({command:z.string().trim().min(1).max(8000),requestId:z.uuid(),sessionId:z.string().max(160).default('dashboard')}).strict();
const audit=(task,type,detail={})=>task.audit.push({at:new Date().toISOString(),type,...redact(detail)});
// The model's wording is not proof. This server-built section lists only writes that were verified against stored data.
const esc=text=>String(text).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function groundTruth(task,registry){
 const changed=task.actions.filter(a=>a.state==='VERIFIED'&&registry.get(a.name)?.mutation);
 const failed=task.actions.filter(a=>a.state==='FAILED'&&registry.get(a.name)?.mutation);
 return `<h4>Verified by the system</h4>${changed.length?`<ul>${changed.map(a=>`<li>Changed and re-read from the database: <code>${esc(a.name)}</code></li>`).join('')}</ul>`:'<p><strong>No data was changed.</strong> If the text above says otherwise, it is wrong.</p>'}${failed.length?`<p>Failed, not applied: ${failed.map(a=>`<code>${esc(a.name)}</code>`).join(', ')}</p>`:''}`;
}
function createEngine({store,registry,agent,authorize}){
 let timer=null,running=false;const workerToken=randomUUID();
 const actorFor=async owner=>{const actor=await authorize(owner);if(!actor)throw failure(403,'The initiating account no longer has administrator authority or an active session.');return actor;};
 const checkpoint=async task=>{if(store.lock&&!await store.lock(workerToken))throw failure(409,'Worker ownership changed.');const fresh=await store.heartbeat(task);if(fresh.cancelRequested){task.cancelRequested=true;throw failure(409,'Task cancelled. Completed operations are retained.');}if((await store.control()).paused)throw failure(409,'Emergency stop is active. Completed operations are retained.');return actorFor(task.owner);};
 const finishCall=(task,action,output)=>{task.input.push({type:'function_call_output',call_id:action.callId,output:JSON.stringify(redact(output))});action.delivered=true;};
 const handle=async task=>{
  try{
   await checkpoint(task);
   if(!task.contextInitialized&&!task.actions.length){
    const rows=store.conversation?await store.conversation(task.owner,task.sessionId,task):[];
    task.input=conversationInput(rows,task.command);task.contextInitialized=true;
    audit(task,'CONVERSATION_CONTEXT',{previousTasks:task.input.length-1});await store.save(task);
   }
   // Model outputs and every tool receipt are persisted BEFORE moving to the next step.
   for(let count=0;count<24;count++){
    let action=task.actions.find(item=>!item.delivered);
    if(!action){
     if(task.actions.length>=24)throw failure(422,'Task reached its 24-action limit. Review completed actions before a new request.');
     const response=await agent.next(task);await checkpoint(task);
     if(response.usage){const usage=response.usage;const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;audit(task,'MODEL_USAGE',{inputTokens:count(usage.input_tokens),cachedInputTokens:count(usage.input_tokens_details?.cached_tokens),outputTokens:count(usage.output_tokens)});}
     if(!response.calls.length){task.result={message:`${response.text||'No administrative action was requested.'}${groundTruth(task,registry)}`,verifiedActions:task.actions.filter(a=>a.state==='VERIFIED').length,model:response.model,provider:response.provider||'openai',usage:task.audit.filter(event=>event.type==='MODEL_USAGE').reduce((total,event)=>({calls:total.calls+1,inputTokens:total.inputTokens+event.inputTokens,cachedInputTokens:total.cachedInputTokens+event.cachedInputTokens,outputTokens:total.outputTokens+event.outputTokens}),{calls:0,inputTokens:0,cachedInputTokens:0,outputTokens:0})};task.state=task.actions.some(a=>a.state==='FAILED')?'FAILED':'COMPLETED';audit(task,task.state);await store.save(task);return;}
     task.input.push(...redact(response.output));
     const call=response.calls[0];if(!call.call_id||task.actions.some(item=>item.callId===call.call_id))throw failure(409,'The model repeated a tool-call identity. No duplicate operation was executed.');let args;
     try{const wrapped=JSON.parse(call.arguments);args=JSON.parse(wrapped.arguments_json);}catch{throw failure(400,'The model returned invalid tool arguments.');}
     action={id:randomUUID(),callId:call.call_id,name:call.name,args:redact(args),state:'PLANNED',createdAt:new Date().toISOString()};task.actions.push(action);audit(task,'TOOL_PLANNED',{name:action.name,actionId:action.id});await store.save(task);
    }
    const entry=registry.get(action.name);let actor=await checkpoint(task);
    if(action.state==='UNCERTAIN'||action.state==='WRITING'&&!action.writeResult){action.state='UNCERTAIN';throw failure(409,'An interrupted write may already have completed. Automatic retry is blocked; reconcile the target in the manual dashboard.');}
    if(action.state==='VERIFIED'||action.state==='FAILED'){finishCall(task,action,action.result||{ok:false,error:action.error});await store.save(task);continue;}
    try{
     if(!entry.mutation){action.result={ok:true,data:await registry.executeRead(action.name,action.args,actor)};action.state='VERIFIED';}
     else{
      if(!action.prepared){action.prepared=await registry.prepare(action.name,action.args,actor);action.args=action.prepared.args;action.beforeHash=registry.hash(action.prepared.before);action.digest=registry.hash({actionId:action.id,name:action.name,args:action.args,before:action.beforeHash});audit(task,'PREVIEW_READY',{actionId:action.id});await store.save(task);}
      if(action.prepared.approval&&!task.pending?.approved){task.pending={actionId:action.id,digest:action.digest,name:action.name,before:redact(action.prepared.before),after:redact(action.prepared.body),approved:false};action.state='AWAITING_APPROVAL';task.state='AWAITING_APPROVAL';audit(task,'APPROVAL_REQUIRED',{actionId:action.id,digest:action.digest});await store.save(task);return;}
      if(action.prepared.approval&&(task.pending?.actionId!==action.id||task.pending?.digest!==action.digest))throw failure(403,'Approval does not match the proposed operation.');
      actor=await checkpoint(task);
      if(!action.writeResult){
       const before=await entry.read(action.args,actor);if(registry.hash(before)!==action.beforeHash)throw failure(409,'The target changed after preview. Create a new task to review its current state.');
       action.state='WRITING';audit(task,'WRITE_STARTED',{actionId:action.id});await store.save(task);
       action.writeResult=await entry.write(action.args,action.prepared,actor);action.state='VERIFYING';await store.save(task);
      }
      actor=await checkpoint(task);
      action.result={ok:true,...await entry.verify(action.args,action.prepared,action.writeResult,actor)};action.state='VERIFIED';task.pending=null;
     }
     audit(task,'TOOL_VERIFIED',{actionId:action.id,name:action.name,mutation:entry.mutation});
    }catch(error){
     // No mutation is replayed after a write may have reached a business handler.
     action.error=error.status?error.message:error instanceof z.ZodError?error.issues[0].message:'Administrative operation failed.';
     action.state=['WRITING','VERIFYING'].includes(action.state)?'UNCERTAIN':'FAILED';audit(task,'TOOL_FAILED',{actionId:action.id,error:action.error,state:action.state});
     if(action.state==='UNCERTAIN'){await store.save(task);throw failure(409,action.error+' Reconcile actual state before retrying.');}
     action.result={ok:false,error:action.error};
    }
    finishCall(task,action,action.result);await store.save(task);
   }
   throw failure(422,'Task action limit reached.');
  }catch(error){task.state=task.cancelRequested?'CANCELLED':'FAILED';task.error=error.status?error.message:'Administrator execution failed. Review the action timeline.';audit(task,task.state,{error:task.error});await store.save(task);}
 };
 return {
  async submit(owner,body,source='dashboard'){await actorFor(owner);const parsed=commandSchema.parse(body);if((await store.control()).paused)throw failure(409,'Emergency stop is active. Resume the worker before submitting.');if(/(?:sk-[\w.-]{12,}|(?:api[_ -]?key|password|sessiontoken)\s*[:=]\s*\S{8,})/i.test(parsed.command))throw failure(400,'Do not include credentials in administrator commands.');return store.create({_id:randomUUID(),owner,...parsed,source,state:'QUEUED',input:[{role:'user',content:parsed.command}],actions:[],audit:[{at:new Date().toISOString(),type:'QUEUED',actor:owner}],pending:null});},
  async tick(){if(running)return;running=true;try{if((await store.control()).paused||store.lock&&!await store.lock(workerToken))return;const task=await store.claim();if(task)await handle(task);}finally{if(store.unlock)await store.unlock(workerToken);running=false;}},
  async start(){await store.init();if(timer)return;timer=setInterval(()=>this.tick().catch(error=>console.error('AI Administrator worker:',error.name)),1500);timer.unref?.();this.tick().catch(error=>console.error('AI Administrator worker:',error.name));},
  stop(){clearInterval(timer);timer=null;},
  async approve(id,owner,digest){await actorFor(owner);const task=await store.approve(id,owner,digest);if(!task)throw failure(409,'This approval is stale or belongs to another administrator.');return task;},
  async cancel(id,owner){await actorFor(owner);const task=await store.cancel(id,owner);if(!task)throw failure(409,'This task can no longer be cancelled.');return task;},
  async retry(id,owner){await actorFor(owner);const task=await store.retry(id,owner);if(!task)throw failure(409,'This task cannot be safely retried; reconcile uncertain writes first.');return task;},
  async pause(paused,owner){await actorFor(owner);return store.pause(paused,owner);},
  store,registry,handle,
 };
}
module.exports={createEngine,commandSchema};
