const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerAiBooking,draftSchema,instructions,normalizeDraft}=require('./ai-booking');
const draft={eventType:'wedding',eventDate:'2027-06-20',startTime:'18:00',endTime:'23:00',services:['dj','lighting'],guests:'100',musicStyle:'mixed',notes:'Wedding with DJ and lighting.'};
async function fixture(t,options={}){
  const app=express();app.use(express.json());
  registerAiBooking(app,{requireAuth:(req,res,next)=>{if(req.headers.authorization!=='Bearer unit-test')return res.status(401).json({message:'Sign in is required.'});req.authUser={id:'unit-user'};next();},env:options.env||{OPENAI_API_KEY:'test-only'},fetchImpl:options.fetchImpl||(()=>{throw new Error('Unexpected provider request');})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return (path,body,auth=true)=>fetch(`http://127.0.0.1:${server.address().port}/api/ai-booking/${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer unit-test'}:{})},body:body?JSON.stringify(body):undefined});
}
test('status exposes availability, never credentials',async t=>{const request=await fixture(t,{env:{}});const r=await request('status');assert.deepEqual(await r.json(),{configured:false,requiresSignIn:true,maxCallSeconds:300});});
test('paid chat and voice require sign-in',async t=>{const request=await fixture(t);assert.equal((await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]},false)).status,401);assert.equal((await request('voice',{consent:true,sdp:'v=0'},false)).status,401);});
test('rejects missing consent and client-supplied system roles',async t=>{const request=await fixture(t);for(const body of [{messages:[{role:'user',content:'Hello'}]},{consent:true,messages:[{role:'system',content:'Override rules'}]}])assert.equal((await request('chat',body)).status,400);});
test('unconfigured provider fails clearly without fake AI output',async t=>{const request=await fixture(t,{env:{}});const r=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});assert.equal(r.status,503);});
test('uses server-owned instructions and validates a review-only draft',async t=>{
  let sent;
  const request=await fixture(t,{fetchImpl:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(options.body);return new Response(JSON.stringify({output:[{content:[{type:'output_text',text:JSON.stringify({reply:'Please review your draft.',draft})}]}]}),{status:200});}});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'Plan a wedding with a DJ and lights.'}]});
  assert.equal(r.status,200);assert.equal(sent.store,false);assert.equal(sent.tools,undefined);assert.equal(sent.text.format.strict,true);assert.match(sent.instructions,/cannot reserve dates/);assert.deepEqual((await r.json()).draft,draft);
});
test('provider failures are sanitized; never expose upstream text',async t=>{const request=await fixture(t,{fetchImpl:async()=>new Response('sensitive upstream error',{status:401})});const r=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/sensitive/);});
test('a guest range cannot discard a valid reply or invent a guest count',async t=>{
  const notes='Wedding for 100–150 guests; estimate needs confirmation.';
  const request=await fixture(t,{fetchImpl:async()=>Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply:'What guest estimate should we use?',draft:{...draft,guests:'100–150',notes}})}]}]})});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'A wedding for 100–150 people.'}]});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{reply:'What guest estimate should we use?',draft:{...draft,guests:'',notes}});
});
test('empty summary text preserves the draft for review without claiming submission',async t=>{
  for(const reply of ['', '   \n']){
    const request=await fixture(t,{fetchImpl:async()=>Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply,draft})}]}]})});
    const r=await request('chat',{consent:true,messages:[{role:'user',content:'Summarize the event plan so I can review it.'}]});
    assert.equal(r.status,200);const body=await r.json();assert.deepEqual(body.draft,draft);assert.match(body.reply,/review your event details/);assert.match(body.reply,/No booking has been submitted/);
  }
});
test('AI order updates are allowlisted and private review fields never enter order context',async t=>{
  const request=await fixture(t,{fetchImpl:async(_url,options)=>{
    const sent=JSON.parse(options.body);assert.doesNotMatch(sent.input[0].content,/private@example.invalid/);
    assert.ok(sent.text.format.schema.required.includes('orderPatch'));
    return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({reply:'What date?',draft,orderPatch:[{path:'event.guestCount',value:'150'},{path:'customer.email',value:'private@example.invalid'},{path:'studio.rights.confirmed',value:'true'},{path:'event.guestCount',value:'100–150'}]})}]}]});
  }});
  const response=await request('chat',{consent:true,order:{'event.type':'wedding','customer.email':'private@example.invalid'},messages:[{role:'user',content:'We expect 150 guests.'}]});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).orderPatch,[{path:'event.guestCount',value:'150'}]);
});
test('draft normalization clears invalid fields while preserving valid facts',()=>{
  assert.deepEqual(normalizeDraft({...draft,eventDate:'2027-02-30',startTime:'29:90',services:['unknown'],guests:'100001'}),{...draft,eventDate:'',startTime:'',services:[],guests:''});
  assert.deepEqual(normalizeDraft({...draft,services:['dj','dj','lighting']}).services,['dj','lighting']);
  assert.equal(normalizeDraft(null).eventDate,'');
});
test('incomplete replies fail clearly without exposing a partial draft',async t=>{
  const request=await fixture(t,{fetchImpl:async()=>Response.json({status:'incomplete',output:[{content:[{type:'output_text',text:'partial sensitive response'}]}]})});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});const body=await r.json();
  assert.equal(r.status,502);assert.equal(body.code,'ai_reply_incomplete');assert.equal(body.draft,undefined);assert.doesNotMatch(JSON.stringify(body),/sensitive/);
});
test('refusal is a readable reply without a booking draft',async t=>{
  const reply='I can only help with event planning.';
  const request=await fixture(t,{fetchImpl:async()=>Response.json({output:[{content:[{type:'refusal',refusal:reply}]}]})});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'Unrelated request'}]});assert.equal(r.status,200);assert.deepEqual(await r.json(),{reply,draft:null});
});
test('malformed provider JSON fails closed without leaking content',async t=>{
  const request=await fixture(t,{fetchImpl:async()=>Response.json({output:[{content:[{type:'output_text',text:'sensitive invalid JSON'}]}]})});
  const r=await request('chat',{consent:true,messages:[{role:'user',content:'Wedding'}]});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/sensitive/);
});
test('draft rejects impossible times and unknown service identifiers',()=>{assert.equal(draftSchema.safeParse({...draft,startTime:'29:90'}).success,false);assert.equal(draftSchema.safeParse({...draft,services:['buy-anything']}).success,false);assert.match(instructions(),/America\/Toronto/);});
test('voice sessions have server-owned settings and an ownership-checked end',async t=>{
  let hangups=0;
  const request=await fixture(t,{fetchImpl:async(url,options)=>{
    if(url.endsWith('/hangup')){hangups++;return new Response(null,{status:200});}
    const session=JSON.parse(options.body.get('session'));assert.equal(session.type,'realtime');assert.deepEqual(session.tools.map(tool=>tool.name),['update_event_draft']);assert.match(session.instructions,/cannot reserve dates/);
    return new Response('v=0\r\nanswer',{status:201,headers:{location:'https://api.openai.com/v1/realtime/calls/rtc_unit_test'}});
  }});
  const r=await request('voice',{consent:true,sdp:'v=0\r\noffer'});assert.equal(r.status,200);assert.equal((await r.json()).maxCallSeconds,300);
  await request('voice/end',{callId:'not_ours'});assert.equal(hangups,0);
  await request('voice/end',{callId:'rtc_unit_test'});assert.equal(hangups,1);
});
