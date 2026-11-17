const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerAiBooking,instructions}=require('./ai-booking');
async function fixture(t,options={}){
  const app=express();app.use(express.json());
  registerAiBooking(app,{loadBookingData:options.loadBookingData|| (async year=>({year,availability:{status:'ready',data:{days:{}}}})),loadSetupCatalog:async()=>[],configService:options.configService||null,requireAuth:(req,res,next)=>{if(req.headers.authorization!=='Bearer unit-test')return res.status(401).json({message:'Sign in is required.'});req.authUser={id:'unit-user',email:'private@example.invalid'};next();},optionalAuth:(req,res,next)=>{if(!req.headers.authorization){req.authUser=null;return next();}if(req.headers.authorization!=='Bearer unit-test')return res.status(401).json({message:'Sign in is required.'});req.authUser={id:'unit-user',email:'private@example.invalid'};next();},env:options.env||{OPENAI_API_KEY:'test-only'},recordMetric:options.recordMetric||(()=>{}),fetchImpl:options.fetchImpl||(()=>{throw new Error('Unexpected provider request');})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return (path,body,auth=true,extraHeaders={})=>fetch(`http://127.0.0.1:${server.address().port}/api/ai-booking/${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer unit-test'}:{}),...extraHeaders},body:body?JSON.stringify(body):undefined});
}
test('status exposes availability, never credentials',async t=>{const request=await fixture(t,{env:{}});const r=await request('status');assert.deepEqual(await r.json(),{configured:false,voiceConfigured:false,requiresSignIn:true,maxCallSeconds:300});});
test('booking data requires sign-in and chat receives the same fresh snapshots',async t=>{
 const years=[],year=new Date().getUTCFullYear();let sent;
 const request=await fixture(t,{loadBookingData:async year=>{years.push(year);return {year,availability:{status:'ready',data:{days:{[`${year}-11-14`]:[{start:0,end:1440}]}}}};},fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'That day is busy.',orderPatch:[],section:'availability'})}]}]});}});
 assert.equal((await request(`booking-data?year=${year}`,null,false)).status,401);
 const data=await (await request(`booking-data?year=${year}`)).json();assert.equal(data.availability.status,'ready');
 assert.equal((await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:`Is November 14 ${year+2} available?`}]})).status,200);
 assert.ok(years.includes(year+2));assert.match(sent.instructions,/Do not say you cannot see live availability/);assert.match(JSON.stringify(sent.input),/Live booking data/);assert.match(JSON.stringify(sent.input),/1440/);
});
test('voice requires sign-in, while the text conversation is open to visitors without an account',async t=>{
  const request=await fixture(t,{fetchImpl:async()=>new Response(JSON.stringify({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Welcome.',orderPatch:[],section:'none',face:'none'})}]}]}),{status:200})});
  assert.equal((await request('voice',{consent:true,sdp:'v=0'},false)).status,401);
  assert.equal((await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]},false)).status,200); // a guest
  assert.equal((await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]},false,{Authorization:'Bearer wrong'})).status,401); // a sign-in that is sent must be valid
});
test('a guest has a small chat allowance of their own',async t=>{
  const request=await fixture(t,{fetchImpl:async()=>new Response(JSON.stringify({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Hi.',orderPatch:[],section:'none',face:'none'})}]}]}),{status:200})});
  let last;for(let i=0;i<21;i++)last=await request('chat',{consent:true,messages:[{role:'user',content:`Hello ${i}`}]},false);
  assert.equal(last.status,429);
  assert.equal((await request('chat',{consent:true,messages:[{role:'user',content:'Signed in'}]})).status,200); // signed-in clients are not affected
});
test('rejects missing consent and client-supplied system roles',async t=>{const request=await fixture(t);for(const body of [{messages:[{role:'user',content:'Hello'}]},{consent:true,messages:[{role:'system',content:'Override rules'}]}])assert.equal((await request('chat',body)).status,400);});
test('unconfigured provider fails clearly without fake AI output',async t=>{const request=await fixture(t,{env:{}});const r=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});assert.equal(r.status,503);});
test('uses server-owned instructions and answers with a reviewable patch only',async t=>{
  let sent;
  const request=await fixture(t,{fetchImpl:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(options.body);return new Response(JSON.stringify({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Please review your draft.',orderPatch:[],section:'none',face:'none'})}]}]}),{status:200});}});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'Plan a wedding with a DJ and lights.'}]});
  assert.equal(r.status,200);assert.equal(sent.store,false);assert.equal(sent.tools,undefined);assert.equal(sent.text.format.strict,true);assert.match(sent.instructions,/cannot reserve dates/);const body=await r.json();assert.equal(body.draft,undefined);assert.deepEqual(body.orderPatch,[]);
});
test('provider failures are sanitized; never expose upstream text',async t=>{const request=await fixture(t,{fetchImpl:async()=>new Response('sensitive upstream error',{status:401})});const r=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/sensitive/);});
test('empty summary text falls back to a review prompt without claiming submission',async t=>{
  for(const reply of ['', '   \n']){
    const request=await fixture(t,{fetchImpl:async()=>Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply,orderPatch:[],section:'none',face:'none'})}]}]})});
    const r=await request('chat',{consent:true,messages:[{role:'user',content:'Summarize the event plan so I can review it.'}]});
    assert.equal(r.status,200);const body=await r.json();assert.equal(body.draft,undefined);assert.match(body.reply,/review your event details/);assert.match(body.reply,/No booking has been submitted/);
  }
});
test('AI reads account contacts and returns editable event patches',async t=>{
  const request=await fixture(t,{fetchImpl:async(_url,options)=>{
    const sent=JSON.parse(options.body);assert.match(JSON.stringify(sent.input),/private@example.invalid/);
    assert.ok(sent.text.format.schema.required.includes('orderPatch'));
    return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply:'What date?',section:'none',face:'none',orderPatch:[{path:'event.guestCount',value:'150'}]})}]}]});
  }});
  const response=await request('chat',{consent:true,order:{'event.type':'wedding','customer.email':'private@example.invalid'},messages:[{role:'user',content:'We expect 150 guests.'}]});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).orderPatch,[{path:'event.guestCount',value:'150'}]);
});
test('incomplete replies fail clearly without exposing a partial draft',async t=>{
  const request=await fixture(t,{fetchImpl:async()=>Response.json({status:'incomplete',output:[{content:[{type:'output_text',text:'partial sensitive response'}]}]})});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});const body=await r.json();
  assert.equal(r.status,502);assert.equal(body.code,'ai_reply_incomplete');assert.equal(body.draft,undefined);assert.doesNotMatch(JSON.stringify(body),/sensitive/);
});
test('refusal is a readable reply with no booking changes',async t=>{
  const reply='I can only help with event planning.';
  const request=await fixture(t,{fetchImpl:async()=>Response.json({output:[{content:[{type:'refusal',refusal:reply}]}]})});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'Unrelated request'}]});assert.equal(r.status,200);assert.deepEqual(await r.json(),{reply});
});
test('malformed provider JSON fails closed without leaking content',async t=>{
  const request=await fixture(t,{fetchImpl:async()=>Response.json({output:[{content:[{type:'output_text',text:'sensitive invalid JSON'}]}]})});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/sensitive/);
});
test('four suggested songs with escaped YouTube links recover from missing phases without losing order',async t=>{
 const songs=[
  {song:'Fairuz - Nassam Alayna El Hawa',link:'https://www.youtube.com/watch?v=iIYV7CyYdxU'},
  {song:'Najwa Karam - Shou Hal Hala',link:'https://www.youtube.com/watch?v=faLLKMdiEHs'},
  {song:'Wael Kfoury - El Bint El Awiye',link:'https://www.youtube.com/watch?v=QqiqISFT15w'},
  {song:'Amr Diab - Nour El Ein',link:'https://www.youtube.com/watch?v=KLJA-srM_yM'},
 ];
 const expected=songs.map(song=>({...song,phase:''}));
 let calls=0;
 const request=await fixture(t,{fetchImpl:async(url,options)=>{
  calls++;const sent=JSON.parse(options.body);
  assert.match(sent.instructions,/never omit phase/);
  assert.match(sent.instructions,/Decode Markdown punctuation escapes/);
  if(calls===2){assert.equal(sent.stream,false);assert.match(sent.input.at(-1).content,/Correct the structured JSON/);}
  return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply:'I have added your suggested songs. Would you like to add any special requests?',orderPatch:[{path:'music.suggestedSongs',value:JSON.stringify(calls===1?songs:expected)}]})}]}]});
 }});
 const content='Suggested songs: '+songs.map(({song,link})=>`${song} ${link.replaceAll(':','\\:').replaceAll('.','\\.')}`).join(' ; ');
 const response=await request('chat',{consent:true,order:{},messages:[{role:'user',content}]},true,{Accept:'application/x-ndjson'});
 assert.equal(response.status,200);
 const events=(await response.text()).trim().split('\n').map(JSON.parse);
 assert.equal(events.at(-1).type,'complete');
 assert.equal(calls,2);
 assert.deepEqual(JSON.parse(events.at(-1).orderPatch[0].value),expected);
});
test('unreadable structured replies get one repair attempt before returning a validated patch',async t=>{
 let calls=0;
 const patch=[{path:'music.suggestedSongs',value:JSON.stringify([{song:'Fairuz - Nassam Alayna El Hawa',phase:''}])}];
 const request=await fixture(t,{fetchImpl:async()=>Response.json({output:[{content:[{type:'output_text',text:++calls===1?'```json\n{"reply":"truncated':JSON.stringify({reply:'Please review your suggested songs.',orderPatch:patch})}]}]})});
 const response=await request('chat',{consent:true,messages:[{role:'user',content:'Suggested songs: Fairuz - Nassam Alayna El Hawa'}]});
 assert.equal(response.status,200);assert.equal(calls,2);
 assert.deepEqual((await response.json()).orderPatch,patch);
});
test('voice sessions have server-owned settings and an ownership-checked end',async t=>{
  let hangups=0;
  const request=await fixture(t,{fetchImpl:async(url,options)=>{
    if(url.endsWith('/hangup')){hangups++;return new Response(null,{status:200});}
    const session=JSON.parse(options.body.get('session'));assert.equal(session.type,'realtime');assert.equal(session.model,'gpt-realtime-2.1-mini');assert.deepEqual(session.tools.map(tool=>tool.name),['update_event_draft','show_app_section','read_booking_data']);assert.match(session.instructions,/cannot reserve dates/);
    return new Response('v=0\r\nanswer',{status:201,headers:{location:'https://api.openai.com/v1/realtime/calls/rtc_unit_test'}});
  }});
  const r=await request('voice',{consent:true,sdp:'v=0\r\noffer'});assert.equal(r.status,200);assert.equal((await r.json()).maxCallSeconds,300);
  await request('voice/end',{callId:'not_ours'});assert.equal(hangups,0);
  await request('voice/end',{callId:'rtc_unit_test'});assert.equal(hangups,1);
});

test('modern chat requests one shared patch and records usage without content',async t=>{
  const metrics=[];
  const request=await fixture(t,{recordMetric:value=>metrics.push(value),fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);
    assert.deepEqual(body.text.format.schema.required,['reply','orderPatch','section','face']);
    assert.deepEqual(Object.keys(body.text.format.schema.properties),['reply','section','face','orderPatch']);
    return Response.json({status:'completed',usage:{input_tokens:120,output_tokens:30,input_tokens_details:{cached_tokens:80}},output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Which date?',orderPatch:[{path:'event.type',value:'wedding'}]})}]}]});
  }});
  const response=await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:'PRIVATE wedding information'}]});
  assert.deepEqual(await response.json(),{reply:'Which date?',orderPatch:[{path:'event.type',value:'wedding'}]});
  assert.equal(metrics[0].inputTokens,120);assert.equal(metrics[0].cachedInputTokens,80);assert.equal(metrics[0].outputTokens,30);
  assert.doesNotMatch(JSON.stringify(metrics),/PRIVATE|wedding|private@example/);
});
test('streamed reply arrives before the validated final patch',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const encoder=new TextEncoder();
  const request=await fixture(t,{fetchImpl:async(_url,options)=>{
    assert.equal(JSON.parse(options.body).stream,true);
    const body=new ReadableStream({async start(controller){
      controller.enqueue(encoder.encode('data: '+JSON.stringify({type:'response.output_text.delta',delta:'{"reply":"Hello'})+'\n\n'));
      await gate;
      const result={reply:'Hello there',orderPatch:[{path:'event.type',value:'wedding'}]};
      controller.enqueue(encoder.encode('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(result)}]}]}})+'\n\n'));controller.close();
    }});
    return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
  }});
  const response=await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:'A wedding'}]},true,{Accept:'application/x-ndjson'});
  const reader=response.body.getReader(),decoder=new TextDecoder();
  const first=decoder.decode((await reader.read()).value);
  assert.match(first,/reply.delta/);assert.match(first,/Hello/);assert.doesNotMatch(first,/orderPatch/);
  release();let remaining='';while(true){const chunk=await reader.read();if(chunk.done)break;remaining+=decoder.decode(chunk.value);}
  const complete=remaining.trim().split('\n').map(JSON.parse).find(event=>event.type==='complete');
  assert.deepEqual(complete.orderPatch,[{path:'event.type',value:'wedding'}]);
});
test('stream interruption returns an error event and never a draft patch',async t=>{
  const text='data: '+JSON.stringify({type:'response.output_text.delta',delta:'{"reply":"Hello","orderPatch":['})+'\n\n';
  const request=await fixture(t,{fetchImpl:async()=>new Response(text,{headers:{'Content-Type':'text/event-stream'}})});
  const response=await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:'Wedding'}]},true,{Accept:'application/x-ndjson'});
  const events=(await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type,'error');assert.ok(events.every(event=>!('orderPatch' in event)));assert.ok(!events.some(event=>event.type==='complete'));
});
test('client cancellation aborts upstream generation',async t=>{
  let upstreamSignal;
  const request=await fixture(t,{fetchImpl:async(_url,options)=>{
    upstreamSignal=options.signal;
    const body=new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.output_text.delta',delta:'{"reply":"Hello'})+'\n\n'));
      options.signal.addEventListener('abort',()=>controller.error(new Error('Aborted')),{once:true});
    }});
    return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
  }});
  const response=await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:'Wedding'}]},true,{Accept:'application/x-ndjson'});
  const reader=response.body.getReader();await reader.read();await reader.cancel();
  for(let i=0;i<50&&!upstreamSignal.aborted;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(upstreamSignal.aborted,true);
});
test('voice usage is bounded, owner checked, and labeled as client reported',async t=>{
  const metrics=[];
  const request=await fixture(t,{recordMetric:value=>metrics.push(value),fetchImpl:async(url)=>url.endsWith('/hangup')?new Response():new Response('v=0\r\nanswer',{status:201,headers:{location:'https://api.openai.com/v1/realtime/calls/rtc_usage'}})});
  await request('voice',{consent:true,sdp:'v=0\r\noffer'});
  await request('voice/end',{callId:'someone_else',usage:{responses:999,inputTokens:999,outputTokens:999,cachedInputTokens:0}});
  assert.equal(metrics.length,1);
  await request('voice/end',{callId:'rtc_usage',usage:{responses:2,inputTokens:100,outputTokens:20,cachedInputTokens:30}});
  assert.equal(metrics.at(-1).usageSource,'client-reported');assert.equal(metrics.at(-1).inputTokens,100);
});

test('saved configuration drives models, output limits, voice duration and disabled modes',async t=>{
 const {defaults}=require('./ai-configuration');const config=defaults({});config.chat.model='gpt-5.6-luna';config.chat.maxOutputTokens=3000;config.voice.model='gpt-realtime-2.1';config.voice.maxCallSeconds=60;
 const calls=[];let fail=false;
 const configService={load:async()=>config,reserve:async()=>({id:'usage'}),complete:async()=>{},fail:async()=>{fail=true;}};
 const request=await fixture(t,{configService,fetchImpl:async(url,options)=>{
  if(url.endsWith('/responses')){const body=JSON.parse(options.body);calls.push(body.model);assert.equal(body.max_output_tokens,3000);return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Hi',orderPatch:[]})}]}]});}
  const session=JSON.parse(options.body.get('session'));calls.push(session.model);return new Response('v=0\r\nanswer',{status:201,headers:{location:'https://api.openai.com/v1/realtime/calls/rtc_config'}});
 }});
 assert.equal((await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]})).status,200);
 const voice=await request('voice',{consent:true,sdp:'v=0\r\noffer'});assert.equal((await voice.json()).maxCallSeconds,60);
 assert.deepEqual(calls,['gpt-5.6-luna','gpt-realtime-2.1']);assert.equal(fail,false);
 config.chat.enabled=false;assert.equal((await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]})).status,503);assert.equal(calls.length,2);
});
test('pricing rejection happens before any provider request',async t=>{
 const {defaults}=require('./ai-configuration');const request=await fixture(t,{configService:{load:async()=>defaults({}),reserve:async()=>{throw Object.assign(new Error('Accept price first'),{status:402});}}});
 const chat=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});assert.equal(chat.status,402);
 const voice=await request('voice',{consent:true,sdp:'v=0\r\noffer'});assert.equal(voice.status,402);
});

test('OpenRouter free chat preserves validated order patches and never calls paid OpenAI',async t=>{
 const {defaults}=require('./ai-configuration');const config=defaults({OPENROUTER_API_KEY:'test-only'});
 const sent=[];const request=await fixture(t,{env:{OPENROUTER_API_KEY:'test-only'},configService:{load:async()=>config,reserve:async()=>null},fetchImpl:async(url,options)=>{
  sent.push(url);
  if(url.endsWith('/models'))return Response.json({data:[]});
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');const body=JSON.parse(options.body);
  assert.equal(body.model,'openrouter/free');assert.deepEqual(body.provider.max_price,{prompt:0,completion:0,request:0});assert.equal(body.provider.require_parameters,true);assert.equal(body.response_format.json_schema.strict,true);
  // Some constrained decoders treat JSON Schema patterns as full matches;
  // a bare \\S constrains the reply to one character. Use length constraints.
  assert.equal(body.response_format.json_schema.schema.properties.reply.pattern,undefined);
  assert.equal(body.response_format.json_schema.schema.properties.reply.minLength,8);
  assert.match(JSON.stringify(body.messages),/private@example.invalid/);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'What date would you like?',orderPatch:[{path:'event.type',value:'wedding'}]})}}],usage:{prompt_tokens:100,completion_tokens:20}});
 }});
 const result=await request('chat',{consent:true,responseFormat:'patch',order:{'customer.email':'private@example.invalid'},messages:[{role:'user',content:'A wedding'}]},true,{Accept:'application/x-ndjson'});
 assert.equal(result.status,200);const events=(await result.text()).trim().split('\n').map(JSON.parse);assert.equal(events[0].type,'complete');assert.deepEqual(events[0].orderPatch,[{path:'event.type',value:'wedding'}]);assert.ok(sent.every(url=>!url.includes('openai.com')));
});
test('Alibaba voice issues a one-time socket ticket and bridges it to the provider',async t=>{
 const {WebSocketServer,WebSocket}=require('ws');const {attachAlibabaVoiceSocket}=require('./ai-booking');const {defaults}=require('./ai-configuration');
 const config=defaults({});config.voice.provider='alibaba';config.voice.model='qwen3.8-omni-flash-realtime';config.voice.providerRates={textInput:.23,textCached:.23,textOutput:.7,audioInput:.93,audioCached:.93,audioOutput:1.87};
 const seen=[];const upstream=new WebSocketServer({port:0});t.after(()=>upstream.close());
 upstream.on('connection',(socket,req)=>{seen.push(req.url);socket.on('message',raw=>{const event=JSON.parse(raw);seen.push(event.type);if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='input_audio_buffer.append')socket.send(JSON.stringify({type:'response.done',response:{id:'r',status:'completed'}}));});});
 const app=express();app.use(express.json());
 const routes=registerAiBooking(app,{configService:{load:async()=>structuredClone(config),reserve:async()=>({id:'t'}),complete:async()=>{},fail:async()=>{},updateMetrics:async()=>{}},env:{DASHSCOPE_API_KEY:'k',DASHSCOPE_REALTIME_URL:`ws://127.0.0.1:${upstream.address().port}/api-ws/v1/realtime`},requireAuth:(req,res,next)=>{if(req.headers.authorization!=='Bearer unit-test')return res.status(401).end();req.authUser={_id:'u1'};next();},recordMetric(){}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>server.close());
 attachAlibabaVoiceSocket(server,routes.voiceSocketHooks);
 const base=`127.0.0.1:${server.address().port}`;
 const post=await fetch(`http://${base}/api/ai-booking/voice`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer unit-test'},body:JSON.stringify({consent:true})});
 assert.equal(post.status,200);const body=await post.json();assert.equal(body.provider,'alibaba');assert.equal(body.maxCallSeconds,300);assert.match(body.wsTicket,/^[0-9a-f]{48}$/);
 const second=await fetch(`http://${base}/api/ai-booking/voice`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer unit-test'},body:JSON.stringify({consent:true})});assert.equal(second.status,409);
 const bad=new WebSocket(`ws://${base}/api/ai-booking/voice-ws?ticket=nope`);await new Promise(resolve=>{bad.on('error',resolve);bad.on('close',resolve);});
 const browser=new WebSocket(`ws://${base}/api/ai-booking/voice-ws?ticket=${body.wsTicket}`);
 await new Promise(resolve=>{browser.on('message',raw=>{const event=JSON.parse(raw);if(event.type==='bridge.ready')browser.send(JSON.stringify({type:'input_audio_buffer.append',audio:'AAAA'}));if(event.type==='response.done')resolve();});});
 assert.match(seen[0],/model=qwen3\.8-omni-flash-realtime/);assert.ok(seen.includes('session.update'));
 const reuse=new WebSocket(`ws://${base}/api/ai-booking/voice-ws?ticket=${body.wsTicket}`);await new Promise(resolve=>{reuse.on('error',resolve);reuse.on('close',resolve);});
 await fetch(`http://${base}/api/ai-booking/voice/end`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer unit-test'},body:JSON.stringify({callId:body.callId})});
 const again=await fetch(`http://${base}/api/ai-booking/voice`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer unit-test'},body:JSON.stringify({consent:true})});assert.equal(again.status,200);
 await again.json();browser.close();
});

test('text assistant can follow a question viewport without changing the draft',async t=>{
 const request=await fixture(t,{fetchImpl:async()=>Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply:'What venue are you planning to use?',orderPatch:[],section:'simulation'})}]}]})});
 const response=await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:'Help me with the venue'}]});
 assert.equal(response.status,200);assert.equal((await response.json()).section,'simulation');
});


test('text has voice-equivalent navigation instructions and returns venue faces with draft patches',async t=>{
 let sent;
 const request=await fixture(t,{fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Here is the venue view.',section:'availability',face:'venue',orderPatch:[{path:'event.type',value:'party'}]})}]}]});}});
 const response=await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:'Make it a party and show me the venue.'}]});
 assert.equal(response.status,200);const result=await response.json();assert.equal(result.section,'availability');assert.equal(result.face,'venue');assert.equal(result.orderPatch[0].value,'party');
 assert.match(sent.instructions,/same homepage and shared booking draft as voice/);assert.match(sent.instructions,/applies and saves client-provided edits automatically/);assert.match(sent.instructions,/face=venue/);assert.deepEqual(sent.text.format.schema.properties.face.enum,['none','calendar','venue']);
});

test('text never forwards an arbitrary navigation face',async t=>{
 const request=await fixture(t,{fetchImpl:async()=>Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Here is your calendar.',section:'availability',face:'javascript:invalid',orderPatch:[]})}]}]})});
 const response=await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:'Show calendar.'}]});
 assert.equal(response.status,200);assert.equal((await response.json()).face,undefined);
});

test('AI patch schema and sanitizer reject all account contact edits',()=>{
 const {orderPatchJsonSchema,sanitizeOrderPatch}=require('./event-order');
 const paths=['customer.fullName','customer.email','customer.phone','customer.company'];
 for(const path of paths)assert.ok(!orderPatchJsonSchema.items.properties.path.enum.includes(path));
 assert.deepEqual(sanitizeOrderPatch(paths.map(path=>({path,value:'Changed'}))),[]);
});
test('live service catalog is split into the DJ section and the rental section',()=>{
  const {serviceCatalogInstructions}=require('./ai-booking');
  const text=serviceCatalogInstructions([{kind:'service',id:'dj',name:'DJ'},{kind:'service',id:'photo-booth',name:'Photo booth'},{kind:'service',id:'mc',name:'MC',selectionField:'music.mcRequested'},{kind:'service',id:'old',name:'Old',isActive:false},{kind:'event',id:'wedding',name:'Wedding'}]);
  assert.match(text,/Section 1[^[]*\[\{"id":"dj"/);
  assert.match(text,/"id":"photo-booth","name":"Photo booth","bookingServiceId":"rental"/);
  assert.match(text,/"id":"mc"[^}]*"selectionField":"music.mcRequested"/);
  assert.doesNotMatch(text,/Old|Wedding/);
  assert.equal(serviceCatalogInstructions([]),'');
});
test('a model cannot set a past event or claim that its rejected schedule was saved',async t=>{
 let calls=0;
 const request=await fixture(t,{fetchImpl:async()=>{calls++;return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'I saved your event date.',orderPatch:[{path:'event.date',value:'2020-01-01'},{path:'event.startTime',value:'18:00'}]})}]}]});}});
 const response=await request('chat',{consent:true,responseFormat:'patch',messages:[{role:'user',content:'Set my event to January 1, 2020 at 6 pm'}]});
 assert.equal(response.status,200);const data=await response.json();assert.deepEqual(data.orderPatch,[]);assert.match(data.reply,/already passed in Toronto/);assert.equal(calls,1);
});

test('one transient provider 503 is retried before any reply or draft changes are sent',async t=>{
 let calls=0;
 const request=await fixture(t,{fetchImpl:async()=>++calls===1?new Response('temporarily unavailable',{status:503}):Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'What music would you like?',orderPatch:[]})}]}]})});
 const response=await request('chat',{consent:true,messages:[{role:'user',content:'Add a song without a URL.'}]});
 assert.equal(response.status,200);assert.equal(calls,2);assert.equal((await response.json()).reply,'What music would you like?');
});
test('persistent provider 503 remains a failure with no success reply or patch',async t=>{
 let calls=0;const request=await fixture(t,{fetchImpl:async()=>{calls++;return new Response('upstream private text',{status:503});}});
 const response=await request('chat',{consent:true,messages:[{role:'user',content:'Add Fairuz.'}]});const body=await response.json();
 assert.equal(response.status,503);assert.equal(calls,2);assert.equal(body.code,'ai_provider_unavailable');
 assert.equal(body.failureStage,'provider_request');assert.equal(body.reply,undefined);assert.equal(body.orderPatch,undefined);assert.doesNotMatch(JSON.stringify(body),/private/);
});
test('language-only model patches retain the current language list by default',async t=>{
 const request=await fixture(t,{fetchImpl:async()=>Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'I added English. What genres do you like?',orderPatch:[{path:'music.languagePairs',value:'[{"language":"English","dialect":""}]'}]})}]}]})});
 const response=await request('chat',{consent:true,order:{'music.languagePairs':[{language:'Arabic',dialect:'Lebanese'}]},messages:[{role:'user',content:'Add English too.'}]});
 assert.equal(response.status,200);const patch=(await response.json()).orderPatch;
 assert.deepEqual(JSON.parse(patch[0].value),[{language:'Arabic',dialect:'Lebanese'},{language:'English',dialect:''}]);
});

test('a visitor without an account gets their Personal info and venue saved by the chat, and one bad field never fails the reply',async t=>{
  const patch=[{path:'customer.fullName',value:'Mark Tamer'},{path:'customer.email',value:'mark@example.invalid'},{path:'customer.phone',value:'4165550123'},{path:'event.venue.address',value:'123 Example Street'},{path:'event.venue.city',value:'Toronto'},{path:'event.venue.postalCode',value:'M1B 2K3'}];
  let calls=0;
  const request=await fixture(t,{fetchImpl:async(_url,options)=>{calls++;const sent=JSON.parse(options.body);
    assert.ok(sent.text.format.schema.properties.orderPatch.items.properties.path.enum.includes('customer.email'));assert.match(sent.instructions,/no account yet/);
    return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Thank you, Mark. I saved your details. What is the date?',section:'none',face:'none',orderPatch:[...patch,{path:'customer.notAField',value:'x'}]})}]}]});}});
  const response=await request('chat',{consent:true,order:{},messages:[{role:'user',content:'I am Mark Tamer, mark@example.invalid, 416 555 0123. Venue 123 Example Street, Toronto M1B 2K3.'}]},false);
  assert.equal(response.status,200);const body=await response.json();
  assert.deepEqual(body.orderPatch.map(change=>change.path),patch.map(change=>change.path));
  assert.ok(calls<=2);
});

test('failed guest replies are refunded, so retries after an error do not use up the allowance',async t=>{
  let fail=true;
  const request=await fixture(t,{fetchImpl:async()=>fail?new Response('upstream',{status:500}):Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Hello there.',orderPatch:[],section:'none',face:'none'})}]}]})});
  for(let i=0;i<25;i++)assert.notEqual((await request('chat',{consent:true,messages:[{role:'user',content:`Try ${i}`}]},false)).status,429);
  fail=false;assert.equal((await request('chat',{consent:true,messages:[{role:'user',content:'Now it works'}]},false)).status,200);
});

test('the booking stage chosen by the app is passed to the model as an explicit instruction',async t=>{
  const seen=[];
  const request=await fixture(t,{fetchImpl:async(_url,options)=>{seen.push(JSON.parse(options.body).instructions);return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Your booking is complete and ready to be submitted. Press Review & send.',orderPatch:[],section:'none',face:'none'})}]}]});}});
  for(const stage of ['required','optional','ready'])assert.equal((await request('chat',{consent:true,bookingStage:stage,messages:[{role:'user',content:`Stage ${stage}`}]})).status,200);
  assert.match(seen[0],/Booking stage: REQUIRED/);assert.match(seen[1],/Booking stage: OPTIONAL[^]*Do not say the booking is ready yet/);assert.match(seen[2],/Booking stage: READY[^]*ready to be submitted\. Press Review & send/);
  assert.equal((await request('chat',{consent:true,bookingStage:'bogus',messages:[{role:'user',content:'x'}]})).status,400);
});
