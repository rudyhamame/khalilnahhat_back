const test=require('node:test');
const assert=require('node:assert/strict');
const {createTranslator}=require('../src/ai-voice-alibaba');
const {orderInstructions,draftTool}=require('../src/event-order');
const call={type:'function_call',id:'item1',call_id:'select1',name:'update_event_draft',arguments:'{"updates":[{"path":"event.date","value":"2026-11-14"},{"path":"event.type","value":"birthday"}]}'};
test('Alibaba draft calls reach the browser as soon as complete, with names recovered from the output item',()=>{
 const translator=createTranslator({instructions:'BASE',tools:[draftTool],voice:'Tina'});
 translator.toClient({type:'response.output_item.added',item:{...call,arguments:''}});
 const [event]=translator.toClient({type:'response.function_call_arguments.done',call_id:call.call_id,item_id:call.id,arguments:call.arguments});
 assert.equal(event.type,'response.function_call_arguments.done');assert.equal(event.name,'update_event_draft');assert.equal(event.arguments,call.arguments);
 const [final]=translator.toClient({type:'response.output_item.done',item:{...call,status:'completed'}});assert.equal(final.call_id,event.call_id);
 const [done]=translator.toClient({type:'response.done',response:{id:'r',status:'completed',output:[call]}});assert.equal(done.response.output.length,1);
});
test('final function items and response output are supported without argument-done events',()=>{
 for(const shape of ['item','response']){
  const translator=createTranslator({instructions:'BASE',tools:[],voice:'Tina'});
  if(shape==='item')assert.equal(translator.toClient({type:'response.output_item.done',item:call})[0].name,call.name);
  const done=translator.toClient({type:'response.done',response:{output:shape==='response'?[call]:[]}})[0];assert.equal(done.response.output[0].call_id,call.call_id);
 }
});
test('draft selection language is distinct from business reservation',()=>{
 assert.match(orderInstructions(),/November fourteen/);assert.match(orderInstructions(),/NOT as a request for a business reservation/);assert.match(orderInstructions(),/event.type/);assert.match(draftTool.description,/lock in/);assert.match(orderInstructions(),/event.startTime=18:00/);assert.match(orderInstructions(),/event.endTime=02:30/);
});
