const {test}=require('node:test');const assert=require('node:assert/strict');
const express=require('express');const {WebSocketServer,WebSocket}=require('ws');
const {EventEmitter}=require('node:events');
const {registerAiBooking,attachAlibabaVoiceSocket}=require('../src/ai-booking');
const {bridgeAlibabaVoice}=require('../src/ai-voice-alibaba');
const {defaults}=require('../src/ai-configuration');
async function fixture(t,{alibaba=false,fetchImpl,upstreamUrl,limit=1}={}){
 const config=defaults({});config.voice.requestsPer10Min=limit;if(alibaba){config.voice.provider='alibaba';config.voice.model='qwen3.8-omni-flash-realtime';}
 const app=express();app.use(express.json());
 const routes=registerAiBooking(app,{requireAuth:(req,res,next)=>{req.authUser={id:'owner'};next();},env:{OPENAI_API_KEY:'fake',DASHSCOPE_API_KEY:'fake',DASHSCOPE_REALTIME_URL:upstreamUrl},configService:{load:async()=>config,reserve:async()=>null},fetchImpl,recordMetric(){}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));attachAlibabaVoiceSocket(server,routes.voiceSocketHooks);
 const base=`http://127.0.0.1:${server.address().port}`;const calls=[];
 const request=async(path='voice',body={consent:true,sdp:'v=0\r\noffer'})=>{const res=await fetch(base+'/api/ai-booking/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await res.json();if(json.callId)calls.push(json.callId);return {status:res.status,body:json,headers:res.headers};};
 t.after(async()=>{for(const callId of calls)await request('voice/end',{callId});await new Promise(resolve=>server.close(resolve));});return {request,base};
}
test('failed provider starts do not exhaust voice sessions, but retry attempts stay bounded',async t=>{
 const {request}=await fixture(t,{fetchImpl:async()=>new Response('',{status:503})});
 for(let i=0;i<20;i++)assert.equal((await request()).status,502);
 const blocked=await request();assert.equal(blocked.status,429);assert.ok(blocked.body.retryAfterSeconds>0);assert.equal(Number(blocked.headers.get('retry-after')),blocked.body.retryAfterSeconds);
});
test('active-call conflicts do not consume session quota; unattached tickets are refunded',async t=>{
 const {request}=await fixture(t,{alibaba:true});const first=await request();assert.equal(first.status,200);
 for(let i=0;i<5;i++)assert.equal((await request()).status,409);
 await request('voice/end',{callId:first.body.callId});assert.equal((await request()).status,200);
});
test('a completed voice start still enforces the configured session limit with retry timing',async t=>{
 const {request}=await fixture(t,{fetchImpl:async url=>url.endsWith('/hangup')?new Response(''):new Response('v=0\r\nanswer',{headers:{location:'/calls/call_1'}})});
 const first=await request();assert.equal(first.status,200);await request('voice/end',{callId:first.body.callId});
 const next=await request();assert.equal(next.status,429);assert.match(next.body.message,/voice limit.*seconds/);assert.ok(next.body.retryAfterSeconds<=600);
});
test('Alibaba abnormal provider disconnect releases the call and permits a bounded reconnect',async t=>{
 const upstream=new WebSocketServer({port:0});await new Promise(resolve=>upstream.once('listening',resolve));
 t.after(()=>new Promise(resolve=>upstream.close(resolve)));
 upstream.on('connection',socket=>socket.on('message',raw=>{if(JSON.parse(raw).type==='session.update'){socket.send(JSON.stringify({type:'session.updated'}));}}));
 const {request,base}=await fixture(t,{alibaba:true,upstreamUrl:`ws://127.0.0.1:${upstream.address().port}/voice`});
 for(let i=0;i<4;i++){
  const result=await request();assert.equal(result.status,200);
  const browser=new WebSocket(base.replace('http:','ws:')+'/api/ai-booking/voice-ws?ticket='+result.body.wsTicket);
  const got=[];
  await new Promise((resolve,reject)=>{browser.on('error',reject);browser.on('message',raw=>{const event=JSON.parse(raw);got.push(event);if(event.type==='bridge.ready')for(const socket of upstream.clients)socket.terminate();});browser.on('close',resolve);});
  assert.ok(got.some(event=>event.type==='error'&&/1006/.test(event.error.message)));
 }
});
class Socket extends EventEmitter{constructor(){super();this.readyState=1;this.sent=[];this.pings=0;}send(message){this.sent.push(JSON.parse(message));}close(){this.readyState=3;}ping(){this.pings++;this.emit('pong');}}
test('bridge times out a silent provider and clears its timers',async()=>{
 const client=new Socket();let upstream,detail;
 class Upstream extends Socket{constructor(){super();upstream=this;}}
 await new Promise(resolve=>{bridgeAlibabaVoice({client,env:{DASHSCOPE_API_KEY:'fake'},model:'m',WebSocketImpl:Upstream,readyTimeoutMs:15,heartbeatMs:1000,onClose:value=>{detail=value;resolve();}});});
 assert.equal(detail.side,'provider');assert.equal(detail.ready,false);assert.equal(upstream.readyState,3);assert.ok(client.sent.some(event=>event.error?.retryable));
});
test('bridge keeps both WebSockets alive and identifies the closing side once',async()=>{
 const client=new Socket();let upstream,closed=0,ready=0;
 class Upstream extends Socket{constructor(){super();upstream=this;}}
 let close;
 await new Promise(resolve=>{close=bridgeAlibabaVoice({client,env:{DASHSCOPE_API_KEY:'fake'},model:'m',WebSocketImpl:Upstream,readyTimeoutMs:1000,heartbeatMs:10,onReady:()=>ready++,onClose:()=>closed++});upstream.emit('open');upstream.emit('message',Buffer.from('{"type":"session.updated"}'));const check=setInterval(()=>{if(upstream.pings>=2){clearInterval(check);resolve();}},5);});
 assert.equal(ready,1);assert.ok(client.pings>=2);close();close();assert.equal(closed,1);
});
test('Alibaba eligibility errors remain visible and are not replaced by a later 1006',()=>{
 const {voiceProviderError,createTranslator}=require('../src/ai-voice-alibaba');
 const error=voiceProviderError({code:'AccessDenied.Unpurchased',message:'Access denied'});
 assert.equal(error.retryable,false);assert.match(error.message,/Model Studio is not activated/);
 assert.equal(createTranslator({}).toClient({type:'error',error:{code:'AccessDenied.Unpurchased',message:'Access denied'}})[0].error.code,'AccessDenied.Unpurchased');
 const client=new Socket();let upstream,detail;
 class Upstream extends Socket{constructor(){super();upstream=this;}}
 bridgeAlibabaVoice({client,env:{DASHSCOPE_API_KEY:'fake'},model:'m',WebSocketImpl:Upstream,onClose:value=>{detail=value;}});
 upstream.emit('message',Buffer.from('{"code":"AccessDenied.Unpurchased","message":"Access denied"}'));
 upstream.emit('close',1006,Buffer.alloc(0));
 assert.equal(detail.providerCode,'AccessDenied.Unpurchased');assert.equal(client.sent.length,1);assert.equal(client.sent[0].error.code,'AccessDenied.Unpurchased');assert.equal(client.readyState,3);
});
