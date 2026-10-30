const test=require('node:test');
const assert=require('node:assert/strict');
const {WebSocketServer,WebSocket}=require('ws');
const {createTranslator,bridgeAlibabaVoice,realtimeUrl}=require('./ai-voice-alibaba');
const tool={type:'function',name:'update_event_draft',description:'d',parameters:{type:'object'}};
const make=()=>createTranslator({instructions:'BASE',tools:[tool],voice:'Tina',maxOutputTokens:900});

test('session.update uses nested tool format, PCM and server VAD',()=>{
 const {session}=make().open();
 assert.equal(session.input_audio_format,'pcm');assert.equal(session.turn_detection.type,'server_vad');
 assert.deepEqual(session.tools[0],{type:'function',function:{name:'update_event_draft',description:'d',parameters:{type:'object'}}});
});
test('browser opening instruction speaks first; later replies wait for committed audio',()=>{
 const t=make();
 assert.deepEqual(t.toUpstream({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'CTX'}]}}),[]);
 const out=t.toUpstream({type:'response.create',response:{instructions:'GREET'}});
 assert.equal(out[0].type,'session.update');assert.match(out[0].session.instructions,/BASE\nCTX\nGREET/);
 assert.deepEqual(out[1],{type:'response.create'});assert.equal(out.length,2);
 const later=make();
 assert.deepEqual(later.toUpstream({type:'response.create'}),[]);
 later.toClient({type:'input_audio_buffer.committed'});
 assert.deepEqual(later.toUpstream({type:'response.create'}),[{type:'response.create'}]);
});
test('function calls surface on response.done and tool output is forwarded',()=>{
 const t=make();
 assert.deepEqual(t.toClient({type:'response.function_call_arguments.done',name:'update_event_draft',call_id:'c1',arguments:'{"updates":[]}'}),[]);
 const [done]=t.toClient({type:'response.done',response:{id:'r1',status:'completed',usage:{input_tokens:10,output_tokens:5}}});
 assert.equal(done.response.output[0].call_id,'c1');assert.equal(done.response.usage.input_tokens,10);
 assert.deepEqual(t.toClient({type:'response.done',response:{id:'r2'}})[0].response.output,[]);
 assert.deepEqual(t.toUpstream({type:'conversation.item.create',item:{type:'function_call_output',call_id:'c1',output:'{"ok":1}'}}),[{type:'conversation.item.create',item:{type:'function_call_output',call_id:'c1',output:'{"ok":1}'}}]);
});
test('audio and transcripts are renamed to the shapes the page handles; unknown events are dropped',()=>{
 const t=make();
 assert.deepEqual(t.toClient({type:'response.audio.delta',delta:'AAA='}),[{type:'response.output_audio.delta',delta:'AAA='}]);
 assert.equal(t.toClient({type:'response.audio_transcript.done',transcript:'hi',item_id:'i'})[0].type,'response.output_audio_transcript.done');
 assert.deepEqual(t.toClient({type:'session.updated'}),[]);
 assert.deepEqual(t.toUpstream({type:'session.update'}),[]);
 assert.match(t.toClient({code:'AccessDenied',message:'Access denied by API-Key restrictions.'})[0].error.message,/key does not allow/);
});
test('realtime URL derives from the workspace host',()=>{
 assert.equal(realtimeUrl({DASHSCOPE_BASE_URL:'https://ws1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'},'m'),'wss://ws1.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=m');
 assert.match(realtimeUrl({},'m'),/^wss:\/\/dashscope-intl\.aliyuncs\.com\/api-ws\/v1\/realtime/);
});
test('bridge relays audio up, translated events down, and closes both sides',async()=>{
 const received=[];let auth='';
 const upstreamServer=new WebSocketServer({port:0});
 upstreamServer.on('connection',(socket,req)=>{auth=req.headers.authorization;socket.on('message',raw=>{const event=JSON.parse(raw);received.push(event.type);if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='input_audio_buffer.append'){socket.send(JSON.stringify({type:'response.audio.delta',delta:'QQ=='}));socket.send(JSON.stringify({type:'response.done',response:{id:'r',status:'completed'}}));}});});
 const clientServer=new WebSocketServer({port:0});
 let closed=0;
 clientServer.on('connection',client=>{bridgeAlibabaVoice({client,env:{DASHSCOPE_API_KEY:'k',DASHSCOPE_REALTIME_URL:`ws://127.0.0.1:${upstreamServer.address().port}/api-ws/v1/realtime`},model:'m',instructions:'I',tools:[tool],onClose:()=>closed++});});
 const browser=new WebSocket(`ws://127.0.0.1:${clientServer.address().port}`);
 const got=[];
 await new Promise(resolve=>{browser.on('open',()=>{browser.send(JSON.stringify({type:'input_audio_buffer.append',audio:'AAAA'}));browser.send(JSON.stringify({type:'response.create'}));});browser.on('message',raw=>{const event=JSON.parse(raw);got.push(event.type);if(event.type==='response.done')resolve();});});
 assert.equal(auth,'Bearer k');
 assert.deepEqual(received,['session.update','input_audio_buffer.append']);
 assert.ok(got.includes('response.output_audio.delta'));
 browser.close();
 await new Promise(resolve=>{const wait=()=>closed?resolve():setTimeout(wait,10);wait();});
 assert.equal(closed,1);
 upstreamServer.close();clientServer.close();
});
