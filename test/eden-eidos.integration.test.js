const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');
const {Eidos,Initialization,ensureBooking,registerEidos}=require('../src/eden-eidos');
const {purgeRemovedEidos}=require('../scripts/purge-removed-eidos');

test('Eidos persist fourth goal and permanently delete identity without resurrection',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const app=express();app.use(express.json());
 registerEidos(app,{requireAdmin:(req,res,next)=>req.headers.authorization==='Bearer admin'?next():res.sendStatus(401)});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint=`http://127.0.0.1:${server.address().port}/api/admin/eden/eidos`;
 const request=async(method='GET',body,suffix='')=>{const res=await fetch(endpoint+suffix,{method,headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:res.status,body:await res.json()};};
 assert.equal((await fetch(endpoint)).status,401);
 assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.deepEqual((await request()).body.items,[{id:'booking',fourthGoal:''}]);
 const created=await request('POST',{fourthGoal:'  Guide the booking flow.  '});assert.equal(created.status,201,JSON.stringify(created.body));
 const seed=created.body.item;assert.match(seed.id,/^eidos-[\da-f-]{36}$/);assert.deepEqual(Object.keys(seed),['id','fourthGoal']);assert.equal(seed.fourthGoal,'Guide the booking flow.');
 const second=await request('POST',{});assert.equal(second.status,201);assert.notEqual(second.body.item.id,seed.id);
 assert.deepEqual((await request()).body.items.find(item=>item.id===seed.id),seed);
 const stored=await Eidos.findOne({externalId:seed.id}).lean();assert.deepEqual(Object.keys(stored).sort(),['_id','externalId','fourthGoal']);assert.equal(stored.fourthGoal,seed.fourthGoal);assert.equal(stored.externalId,seed.id);
 for(const body of [{name:'Not a named entity'},{description:'No metadata'},{externalId:'chosen-id'},{goalId:'other'}])assert.equal((await request('POST',body)).status,400);
 const updated=await request('PUT',{fourthGoal:' Updated goal. ',previousFourthGoal:seed.fourthGoal},'/'+seed.id);
 assert.equal(updated.status,200,JSON.stringify(updated.body));assert.deepEqual(updated.body.item,{id:seed.id,fourthGoal:'Updated goal.'});
 assert.equal((await request()).body.items.find(item=>item.id===seed.id).fourthGoal,'Updated goal.');
 assert.equal((await request('PUT',{fourthGoal:'Stale edit',previousFourthGoal:seed.fourthGoal},'/'+seed.id)).status,409);
 assert.equal((await request('PUT',{fourthGoal:'x',previousFourthGoal:''},'/missing')).status,404);
 assert.equal((await request('POST',{fourthGoal:'x'.repeat(2001)})).status,400);
 assert.equal((await request('POST',{fourthGoal:123})).status,400);
 assert.equal((await request('PUT',{fourthGoal:'x',previousFourthGoal:'Updated goal.',id:'replace-id'},'/'+seed.id)).status,400);
 assert.equal((await fetch(endpoint+'/'+seed.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({fourthGoal:'unauthorized',previousFourthGoal:'Updated goal.'})})).status,401);
 // Earlier ID-only records are readable and editable without regenerating identity.
 await Eidos.collection.updateOne({externalId:'booking'},{$unset:{fourthGoal:''}});
 assert.equal((await request()).body.items.find(item=>item.id==='booking').fourthGoal,'');
 const legacy=await request('PUT',{fourthGoal:'First Booking goal',previousFourthGoal:''},'/booking');assert.equal(legacy.status,200);assert.equal(legacy.body.item.id,'booking');
 const cleared=await request('PUT',{fourthGoal:'',previousFourthGoal:'Updated goal.'},'/'+seed.id);assert.equal(cleared.status,200);assert.equal(cleared.body.item.fourthGoal,'');
 assert.equal((await fetch(endpoint+'/'+seed.id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({permanent:true,previousFourthGoal:''})})).status,401);
 // A stale UI that previously only hid an item cannot authorize permanent deletion.
 assert.equal((await request('DELETE',{previousFourthGoal:''},'/'+seed.id)).status,400);
 assert.ok(await Eidos.exists({externalId:seed.id}));
 assert.equal((await request('DELETE',{permanent:true,previousFourthGoal:'stale'},'/'+seed.id)).status,409);
 const deleted=await request('DELETE',{permanent:true,previousFourthGoal:''},'/'+seed.id);
 assert.equal(deleted.status,200);assert.deepEqual(deleted.body,{deleted:true,id:seed.id});
 assert.equal(await Eidos.collection.findOne({externalId:seed.id}),null);
 assert.equal((await request()).body.items.some(item=>item.id===seed.id),false);
 assert.equal((await request('GET',undefined,'/'+seed.id)).status,404);
 assert.equal((await fetch(endpoint+'/'+seed.id+'/restore',{method:'POST',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:'{}'})).status,404);
 assert.equal((await request('DELETE',{permanent:true,previousFourthGoal:''},'/missing')).status,404);
 // Cleanup of older soft-deleted entries physically removes only those entries.
 await Eidos.collection.updateOne({externalId:second.body.item.id},{$set:{hiddenFromMap:true}});
 await Eidos.collection.updateOne({externalId:'booking'},{$set:{hiddenFromMap:false}});
 assert.equal((await purgeRemovedEidos()).previouslyRemoved,1);
 assert.ok(await Eidos.exists({externalId:second.body.item.id}));
 assert.equal((await purgeRemovedEidos({apply:true})).permanentlyDeleted,1);
 assert.equal(await Eidos.collection.findOne({externalId:second.body.item.id}),null);
 const retained=await Eidos.collection.findOne({externalId:'booking'});assert.equal(retained.fourthGoal,'First Booking goal');assert.equal(Object.hasOwn(retained,'hiddenFromMap'),false);
 assert.equal((await purgeRemovedEidos({apply:true})).permanentlyDeleted,0);
 // The initial goal seed is not silently recreated by reads, initialization or new seeds.
 assert.equal((await request('DELETE',{permanent:true,previousFourthGoal:'First Booking goal'},'/booking')).status,200);
 assert.equal(await Eidos.collection.findOne({externalId:'booking'}),null);
 await ensureBooking();assert.deepEqual((await request()).body.items,[]);
 assert.ok(await Initialization.exists({_id:'identity-registry-initialized'}));
 const fresh=await request('POST',{});assert.equal(fresh.status,201);assert.notEqual(fresh.body.item.id,'booking');assert.notEqual(fresh.body.item.id,seed.id);
 assert.equal((await request()).body.items.some(item=>item.id==='booking'),false);
});
