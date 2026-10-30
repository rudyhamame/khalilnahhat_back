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

function sessionUpdate({instructions,tools,voice,maxOutputTokens}){
 return {type:'session.update',session:{
  modalities:['text','audio'],voice,instructions,input_audio_format:'pcm',output_audio_format:'pcm',
  input_audio_transcription:{model:'qwen3-asr-flash-realtime'},
  turn_detection:{type:'server_vad',threshold:0.3,prefix_padding_ms:500,silence_duration_ms:900},
  tools:(tools||[]).map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}})),
  ...(maxOutputTokens?{max_tokens:maxOutputTokens}:{}),
 }};
}

// Pure translation, kept separate from the sockets so it can be tested without a network.
function createTranslator({instructions,tools,voice,maxOutputTokens}){
 const state={context:'',calls:[],hasConversation:false};
 return {
  open:()=>sessionUpdate({instructions,tools,voice,maxOutputTokens}),
  // Browser event -> events for Alibaba.
  toUpstream(event){
   if(!event||typeof event.type!=='string')return [];
   if(event.type==='input_audio_buffer.append')return typeof event.audio==='string'?[{type:'input_audio_buffer.append',audio:event.audio}]:[];
   if(event.type==='conversation.item.create'){
    const item=event.item||{};
    if(item.type==='message'){state.context=`${state.context}\n${text(item.content)}`.trim().slice(0,6000);return [];}
    if(item.type==='function_call_output'&&typeof item.call_id==='string'){state.hasConversation=true;return [{type:'conversation.item.create',item:{type:'function_call_output',call_id:item.call_id,output:String(item.output??'')}}];}
    return [];
   }
   if(event.type==='response.create'){
    // Alibaba accepts text context through session instructions. A first response needs a committed audio turn; defer the proactive greeting until then.
    const extra=[state.context,typeof event.response?.instructions==='string'?event.response.instructions:''].filter(Boolean).join('\n');
    state.context='';
    return [...(extra?[sessionUpdate({instructions:`${instructions}\n${extra}`.slice(0,30000),tools,voice,maxOutputTokens})]:[]),...(state.hasConversation?[{type:'response.create'}]:[])];
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
     return [];
    case 'response.done':{
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
 const send=(socket,event)=>{if(socket.readyState===1)socket.send(JSON.stringify(event));};
 const close=()=>{if(closed)return;closed=true;try{upstream.close();}catch{/* Already closed. */}try{client.close();}catch{/* Already closed. */}onClose();};
 upstream.on('open',()=>send(upstream,translator.open()));
 upstream.on('message',raw=>{let event;try{event=JSON.parse(raw.toString());}catch{return;}if(event.type==='session.updated'&&!ready){ready=true;for(const pending of queued.splice(0))send(upstream,pending);send(client,{type:'bridge.ready'});}for(const out of translator.toClient(event))send(client,out);});
 upstream.on('error',()=>{send(client,{type:'error',error:{message:'The AI voice service could not connect.'}});close();});
 upstream.on('close',close);
 client.on('message',raw=>{
  let event;try{event=JSON.parse(raw.toString());}catch{return;}
  for(const out of translator.toUpstream(event)){if(ready)send(upstream,out);else if(queued.length<MAX_QUEUED)queued.push(out);}
 });
 client.on('close',close);client.on('error',close);
 return close;
}
module.exports={bridgeAlibabaVoice,createTranslator,realtimeUrl,sessionUpdate};
