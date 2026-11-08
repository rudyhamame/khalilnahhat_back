const {test}=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const express=require('express');
const {createAdminServices}=require('../src/ai-admin/services');
const {registerAiAdministrator}=require('../src/ai-admin/routes');
const text={enabled:false,provider:'openai',model:'gpt-4o-mini',freeOnly:false,maxOutputTokens:3000};
const stt={enabled:true,provider:'browser',model:'browser-recognition'};
const configService={load:async()=>({chat:{provider:'openai',model:'gpt-4o-mini'}}),describe:async()=>({catalog:[{mode:'chat',provider:'openai',id:'gpt-4o-mini'},{mode:'voice',provider:'openai',id:'legacy-realtime'}],providers:{}})};
test('administrator ignores legacy call settings and saves text/dictation without a voice model',async t=>{
 let saved={revision:1,text,stt,voice:{enabled:true,provider:'obsolete',model:'retired'}};
 const Model=mongoose.models.EchoAdminServices;
 t.mock.method(Model,'findById',()=>({lean:async()=>saved}));
 t.mock.method(Model,'updateOne',async(filter,update)=>{assert.equal(filter.revision,saved.revision);saved={...saved,...update.$set};return {matchedCount:1};});
 const service=createAdminServices({configService,env:{}});
 assert.deepEqual(await service.load(),{revision:1,text,stt});
 const described=await service.describe();assert.ok(described.catalog.every(row=>row.mode==='text'||row.mode==='stt'));assert.equal('voice' in described.item,false);
 const updated=await service.save({revision:1,text,stt},'administrator');assert.equal(updated.revision,2);assert.deepEqual(updated.stt,stt);assert.equal('voice' in updated,false);
 await assert.rejects(service.save({...updated,voice:{enabled:true}},'administrator'));
});
test('administrator defaults expose text and dictation only',async t=>{
 t.mock.method(mongoose.models.EchoAdminServices,'findById',()=>({lean:async()=>null}));
 const result=await createAdminServices({configService,env:{}}).load();assert.deepEqual(Object.keys(result).sort(),['revision','stt','text']);assert.deepEqual(result.stt,stt);
});
test('administrator registers text tasks and transcription, with no call endpoints or socket lifecycle',()=>{
 const app=express();const service=registerAiAdministrator(app,{requireAdmin:(_req,_res,next)=>next(),authorize:async()=>null,configService,env:{}});
 const paths=app.router.stack.map(layer=>layer.route?.path).filter(Boolean);
 assert.ok(paths.includes('/api/admin/ai-administrator/tasks'));
 assert.ok(paths.includes('/api/admin/ai-administrator/transcribe'));
 assert.ok(!paths.some(path=>path.startsWith('/api/admin/ai-administrator/voice')));
 assert.equal('attachVoice' in service,false);service.stop();
});
