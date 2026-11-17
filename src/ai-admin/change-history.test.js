const {test}=require('node:test');
const assert=require('node:assert/strict');
const {changedAtoms,taskChanges}=require('./change-history');

test('each changed atom gets its persisted before and after value, including nested lists',()=>{
 const changes=changedAtoms({id:'x',revision:1,name:'Old',settings:{level:2},tags:['A','B']},{id:'x',revision:2,name:'New',settings:{level:3},tags:['A']});
 assert.deepEqual(changes,[{path:'name',before:'Old',after:'New'},{path:'settings.level',before:2,after:3},{path:'tags.1',before:'B',after:null}]);
 assert.deepEqual(changedAtoms({name:'Same',updatedAt:'old'},{name:'Same',updatedAt:'new'}),[]);
});
test('secret fields never appear in change history values',()=>{
 const changes=changedAtoms({apiKey:'old-secret',nested:{password:'old'}},{apiKey:'new-secret',nested:{password:'new'},name:'Changed'});
 assert.deepEqual(changes,[{path:'name',before:null,after:'Changed'}]);
 assert.doesNotMatch(JSON.stringify(changes),/secret|password/);
});
test('reads, proposals and failed or uncertain writes cannot masquerade as verified changes',()=>{
 const action={id:'a',name:'music_work_save',prepared:{before:{name:'Old'}},result:{verified:true,after:{name:'New'}}};
 for(const state of ['PLANNED','AWAITING_APPROVAL','FAILED','UNCERTAIN'])assert.deepEqual(taskChanges({_id:'t',actions:[{...action,state}]}),[]);
 assert.deepEqual(taskChanges({_id:'t',actions:[{state:'VERIFIED',result:{data:{name:'Read result'}}}]}),[]);
});
test('verified writes remain visible even if a later task action fails',()=>{
 const task={_id:'task',state:'FAILED',command:'Change name',updatedAt:'fallback',actions:[{id:'action',name:'music_work_save',state:'VERIFIED',prepared:{before:{name:'Old'}},result:{verified:true,after:{name:'New'}}}],audit:[{type:'TOOL_VERIFIED',actionId:'action',at:'verified-time'}]};
 const [result]=taskChanges(task);
 assert.equal(result.id,'task:action');assert.equal(result.at,'verified-time');
 assert.deepEqual(result.changes,[{path:'name',before:'Old',after:'New'}]);
});
test('history queries remain owner scoped and are paginated',async()=>{
 const {createStore,Task}=require('./store'),originalFind=Task.find,originalFindOne=Task.findOne;
 const queries=[];
 Task.find=query=>{queries.push(query);return {sort(){return this;},limit(){return this;},select(){return this;},lean:async()=>Array.from({length:21},(_,i)=>({_id:`task-${i}`,actions:[]}))};};
 Task.findOne=query=>{queries.push(query);return {select(){return this;},lean:async()=>({createdAt:new Date('2026-01-01')})};};
 try{
  const result=await createStore().verifiedChanges('alice','cursor');
  assert.equal(result.hasMore,true);assert.equal(result.nextBefore,'task-19');
  assert.equal(queries[0].owner,'alice');assert.equal(queries[1].owner,'alice');
  assert.equal(queries[1].actions.$elemMatch['result.verified'],true);
 }finally{Task.find=originalFind;Task.findOne=originalFindOne;}
});
