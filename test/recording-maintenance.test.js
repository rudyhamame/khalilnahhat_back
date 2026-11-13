const test=require('node:test'),assert=require('node:assert/strict');
const {cleanVerifiedRecordings}=require('../deploy/ovh/recording-maintenance.cjs');
const id='123456789012345678901234';
function fixture(overrides={}){
 const removed=[],saved=[],verified=[];
 const row={provider:'direct',status:'ready',roomName:'room',sources:[{saved:true,cleaned:false}],parts:[{publicId:'archive',bytes:10}],...overrides};
 return {removed,saved,verified,options:{root:'/recordings',files:{readdir:async()=>[{name:id,isDirectory:()=>true},{name:'unsafe',isDirectory:()=>true}],rm:async file=>removed.push(file)},jobs:{run:async(_id,work)=>work({row,assert:async()=>{},save:async value=>saved.push(value)})},active:async()=>false,verify:async part=>verified.push(part.publicId)}};
}
test('maintenance deletes originals only after all archive parts verify and under the recording lease',async()=>{const f=fixture();assert.equal((await cleanVerifiedRecordings(f.options)).removed,1);assert.deepEqual(f.verified,['archive']);assert.deepEqual(f.removed,['/recordings/'+id]);assert.equal(f.saved[0].cleanupPending,false);});
test('active, unarchived, missing and unverified recordings are preserved',async()=>{
 for(const overrides of [{status:'upload_failed'},{sources:[{saved:false}]},{parts:[]},{provider:'ovh'}]){const f=fixture(overrides);await cleanVerifiedRecordings(f.options);assert.equal(f.removed.length,0);}
 for(const modifier of [o=>o.active=async()=>true,o=>o.verify=async()=>{throw Error('Unavailable');},o=>o.jobs={run:async()=>({busy:true})}]){const f=fixture();modifier(f.options);await cleanVerifiedRecordings(f.options);assert.equal(f.removed.length,0);}
});
