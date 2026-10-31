// Alibaba Cloud (Qwen Omni Realtime) voice for the AI booking assistant.
// The browser speaks OpenAI-realtime-shaped JSON events to this server; this bridge translates them to and from
// Alibaba's WebSocket protocol, so the API key never reaches the browser and the page keeps one event handler.
// Audio is base64 PCM16 mono: 16 kHz from the browser, 24 kHz back.
const crypto=require('node:crypto');
const {WebSocket}=require('ws');
const DEFAULT_BASE='https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const MAX_QUEUED=200;

function realtimeUrl(env,model){
 if(env.DASHSCOPE_REALTIME_URL)return `${String(env.DASHSCOPE_REALTIME_URL).replace(/\/+$/,'')}?model=${encodeURIComponent(model)}`;
 return `wss://${new URL(env.DASHSCOPE_BASE_URL||DEFAULT_BASE).host}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
}
const text=content=>(Array.isArray(content)?content:[]).map(part=>typeof part?.text==='string'?part.text:'').join('\n').trim();
const count=value=>Number.isInteger(value)&&value>=0?value:undefined;

// Half a second of 16 kHz mono PCM16 silence: lets the model take the first turn without the caller saying anything.
const SILENCE=Buffer.alloc(16000).toString('base64');
function sessionUpdate({instructions,tools,voice,maxOutputTokens,manual=false}){
 return {type:'session.update',session:{
  modalities:['text','audio'],voice,instructions,input_audio_format:'pcm',output_audio_format:'pcm',
  input_audio_transcription:{model:'qwen3-asr-flash-realtime'},
  turn_detection:manual?null:{type:'server_vad',threshold:0.3,prefix_padding_ms:500,silence_duration_ms:900},
  tools:(tools||[]).map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}})),
  ...(maxOutputTokens?{max_tokens:maxOutputTokens}:{}),
 }};
}

// Pure translation, kept separate from the sockets so it can be tested without a network.
function createTranslator({instructions,tools,voice,maxOutputTokens}){
 const state={context:'',calls:[],hasConversation:false,opening:false,afterOpening:null,restore:[]};
 return {
  open:()=>sessionUpdate({instructions,tools,voice,maxOutputTokens}),
  // Events the bridge must send upstream after what it just received (e.g. back to server VAD once the opening greeting is done).
  drain:()=>state.restore.splice(0),
  // Browser event -> events for Alibaba.
  toUpstream(event){
   if(!event||typeof event.type!=='string')return [];
   if(event.type==='input_audio_buffer.append')return typeof event.audio==='string'?[{type:'input_audio_buffer.append',audio:event.audio}]:[];
   if(event.type==='conversation.item.create'){
    const item=event.item||{};
    if(item.type==='message'){
     // The browser seeds the booking context as a user text item before voice
     // input. Qwen Omni Realtime does not accept message items from
     // conversation.item.create; keep the text in session instructions instead.
     state.context=`${state.context}\n${text(item.content)}`.trim().slice(0,6000);
     return [sessionUpdate({instructions:`${instructions}\n${state.context}`.slice(0,30000),tools,voice,maxOutputTokens})];
    }
    if(item.type==='function_call_output'&&typeof item.call_id==='string'){state.hasConversation=true;return [{type:'conversation.item.create',item:{type:'function_call_output',call_id:item.call_id,output:String(item.output??'')}}];}
    return [];
   }
   if(event.type==='response.create'){
    // Qwen only answers a committed audio turn. For the opening greeting the model takes a first turn on a moment of silence, in manual
    // turn mode so nothing needs to be heard; server VAD comes back as soon as that greeting is done. The greeting is spoken by the model.
    if(typeof event.response?.instructions==='string'&&event.response.instructions.trim()!==''&&!state.hasConversation){
     const extra=[state.context,event.response.instructions].filter(Boolean).join('\n');
     state.context='';state.opening=true;
     state.afterOpening=sessionUpdate({instructions:`${instructions}\n${extra}`.slice(0,30000),tools,voice,maxOutputTokens});
     return [sessionUpdate({instructions:`${instructions}\n${extra}`.slice(0,30000),tools,voice,maxOutputTokens,manual:true}),{type:'input_audio_buffer.append',audio:SILENCE},{type:'input_audio_buffer.commit'},{type:'response.create'}];
    }
    state.context='';
    return state.hasConversation?[{type:'response.create'}]:[];
   }
   return [];
  },
  // Alibaba event -> events for the browser, in the shapes the page already understands.
  toClient(event){
   if(!event?.type&&typeof event?.code==='string'&&typeof event?.message==='string')return [{type:'error',error:{message:event.code==='AccessDenied'?'The Alibaba API key does not allow this voice model. Check its Model Studio permissions.':event.message}}];
   switch(event?.type){
    case 'input_audio_buffer.committed':state.hasConversation=true;return [];
    case 'response.created':state.hasConversation=true;return [{type:'response.created',response:{id:event.response?.id}}];
    case 'response.audio.delta':return typeof event.delta==='string'?[{type:'response.output_audio.delta',delta:event.delta}]:[];
    case 'response.audio_transcript.delta':return [{type:'response.output_audio_transcript.delta',delta:String(event.delta||'')}];
    case 'response.audio_transcript.done':return [{type:'response.output_audio_transcript.done',transcript:String(event.transcript||''),item_id:event.item_id||crypto.randomUUID()}];
    case 'conversation.item.input_audio_transcription.completed':state.hasConversation=true;return [{type:event.type,transcript:String(event.transcript||''),item_id:event.item_id||crypto.randomUUID()}];
    case 'input_audio_buffer.speech_started':
    case 'input_audio_buffer.speech_stopped':return [{type:event.type}];
    case 'response.function_call_arguments.done':
     if(typeof event.call_id==='string'&&typeof event.name==='string')state.calls.push({type:'function_call',call_id:event.call_id,name:event.name,arguments:String(event.arguments||'')});
     // Navigation can move the page as soon as its arguments are complete, before spoken audio.
     return event.name==='show_app_section'?[{type:event.type,call_id:event.call_id,name:event.name,arguments:String(event.arguments||'')}]:[];
    case 'response.done':{
     if(state.opening){state.opening=false;state.restore.push(state.afterOpening);}
     const raw=event.response?.usage||{},input=count(raw.input_tokens??raw.prompt_tokens),output=count(raw.output_tokens??raw.completion_tokens),cached=count(raw.input_tokens_details?.cached_tokens);
     const done={type:'response.done',response:{id:event.response?.id,status:event.response?.status||'completed',output:state.calls.splice(0),
      ...(input!==undefined||output!==undefined?{usage:{...(input!==undefined?{input_tokens:input}:{}),...(output!==undefined?{output_tokens:output}:{}),...(cached!==undefined?{input_token_details:{cached_tokens:cached}}:{})}}:{})}};
     return [done];
    }
    case 'error':return [{type:'error',error:{message:String(event.error?.message||'Alibaba Cloud voice error')}}];
    default:return [];
   }
  },
 };
}

// Connects an accepted browser socket to Alibaba. Returns close(); onClose fires once when either side ends.
function bridgeAlibabaVoice({client,env=process.env,model,voice=env.DASHSCOPE_VOICE||'Tina',instructions,tools,maxOutputTokens,onClose=()=>{},WebSocketImpl=WebSocket}){
 const translator=createTranslator({instructions,tools,voice,maxOutputTokens});
 const upstream=new WebSocketImpl(realtimeUrl(env,model),{headers:{Authorization:`Bearer ${env.DASHSCOPE_API_KEY}`}});
 const queued=[];let ready=false,closed=false;
 const started=Date.now();
 const logEnd=(side,code)=>console.info('[alibaba-voice]',JSON.stringify({side,code,ready,durationMs:Date.now()-started}));
 const send=(socket,event)=>{if(socket.readyState===1)socket.send(JSON.stringify(event));};
 const close=()=>{if(closed)return;closed=true;try{upstream.close();}catch{/* Already closed. */}try{client.close();}catch{/* Already closed. */}onClose();};
 upstream.on('open',()=>send(upstream,translator.open()));
 upstream.on('message',raw=>{let event;try{event=JSON.parse(raw.toString());}catch{return;}if(event.type==='error'||(!event.type&&event.code))console.error('[alibaba-voice]',JSON.stringify({event:'provider_error',code:event.error?.code||event.code||'unknown'}));if(event.type==='session.updated'&&!ready){ready=true;for(const pending of queued.splice(0))send(upstream,pending);send(client,{type:'bridge.ready'});}for(const out of translator.toClient(event))send(client,out);for(const out of translator.drain())send(upstream,out);});
 // Log why Alibaba ended the call (never the key) and tell the browser, so a drop is diagnosable.
 const fail=(reason,message)=>{console.error('[alibaba-voice]',reason);send(client,{type:'error',error:{message}});close();};
 upstream.on('unexpected-response',(request,response)=>fail(`handshake HTTP ${response.statusCode}`,`Alibaba rejected the voice connection (HTTP ${response.statusCode}). Check the API key, region and model access.`));
 upstream.on('error',error=>fail(`socket error ${error?.message||''}`,'The AI voice service could not connect.'));
 upstream.on('close',(code,reason)=>{
  if(closed)return;
  logEnd('provider',code);
  const detail=String(reason||'').slice(0,160);
  send(client,{type:'error',error:{message:code===1000?'The voice provider ended this session. Reconnect to continue.':`The voice provider disconnected (code ${code}${detail?`: ${detail}`:''}). Reconnect to continue.`}});
  close();
 });
 client.on('message',raw=>{
  let event;try{event=JSON.parse(raw.toString());}catch{return;}
  for(const out of translator.toUpstream(event)){if(ready)send(upstream,out);else if(queued.length<MAX_QUEUED)queued.push(out);}
 });
 client.on('close',code=>{if(!closed)logEnd('browser',code);close();});client.on('error',()=>{if(!closed)logEnd('browser_error',null);close();});
 return close;
}
module.exports={bridgeAlibabaVoice,createTranslator,realtimeUrl,sessionUpdate};
