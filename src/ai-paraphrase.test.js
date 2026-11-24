const assert=require('node:assert'),{test}=require('node:test');
const {createParaphraser}=require('./ai-paraphrase');
const ok=message=>({ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify({message})}]}]})});
test('paraphrase: empty text and disabled AI are refused, a reply is returned trimmed',async()=>{
 const config={chat:{enabled:true,provider:'openai',model:'m'}};
 const run=(body,cfg=config,fetchImpl=async()=>ok(' Hello there '))=>createParaphraser({configService:{load:async()=>cfg},env:{OPENAI_API_KEY:'k'},fetchImpl})(body);
 await assert.rejects(run({text:'  '}),{status:400});
 await assert.rejects(run({text:'x'},{chat:{enabled:false}}),{status:503});
 assert.equal(await run({text:'We are booked that day.'}),'Hello there');
 await assert.rejects(run({text:'x'},config,async()=>({ok:false})),{status:503});
});

test('booking summary: unknown booking is 404, contact details are not sent, summary is returned',async()=>{
 const {createBookingSummarizer}=require('./ai-paraphrase');let sent='';
 const sr={status:'pending',items:[{name:'DJ',quantity:1}],order:{customer:{email:'secret@x.co',phone:'555'},event:{type:'wedding',date:'2099-01-01',guestCount:50}}};
 let calls=0;const run=(Model,body)=>createBookingSummarizer({configService:{load:async()=>({chat:{enabled:true,provider:'openai',model:'m'}})},Model,env:{OPENAI_API_KEY:'k'},fetchImpl:async(_u,o)=>{calls++;sent=o.body;return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify({summary:' A wedding. '})}]}]})};}})(body);
 const Model={findOne:async()=>sr,updateOne:async(_q,update)=>{sr.bookingAiSummary=update.$set.bookingAiSummary;}};
 await assert.rejects(run({findOne:async()=>null},{id:'x'}),{status:404});
 assert.equal(await run(Model,{id:'x'}),'A wedding.');assert.equal(calls,1);
 assert.equal(await run(Model,{id:'x'}),'A wedding.');assert.equal(calls,1,'unchanged booking reuses the stored summary');
 sr.order.event.guestCount=80;await run(Model,{id:'x'});assert.equal(calls,2,'an edited booking is summarized again');
 assert.ok(!sent.includes('secret@x.co')&&!sent.includes('555'));
});

test('email polish: needs text, needs AI on, returns subject and body',async()=>{
 const {createEmailPolisher}=require('./ai-paraphrase');
 const run=(input,cfg={chat:{enabled:true,provider:'openai',model:'m'}})=>createEmailPolisher({configService:{load:async()=>cfg},env:{OPENAI_API_KEY:'k'},fetchImpl:async()=>({ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify({subject:' Your booking ',body:' Dear client, hello. '})}]}]})})})(input);
 await assert.rejects(run({text:' '}),{status:400});await assert.rejects(run({text:'x'},{chat:{enabled:false}}),{status:503});
 assert.deepEqual(await run({text:'hi'}),{subject:'Your booking',body:'Dear client, hello.'});
});
