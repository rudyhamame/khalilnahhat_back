const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {fixture}=require('./helpers/music-ontology-fixture.cjs');
const {Eidos,registerEidos}=require('../src/eden-eidos');

test('Eidos are persistent identity-only seeds behind administrator authentication',{timeout:120000},async t=>{
 const db=await fixture();t.after(()=>db.stop());
 const app=express();app.use(express.json());
 registerEidos(app,{requireAdmin:(req,res,next)=>req.headers.authorization==='Bearer admin'?next():res.sendStatus(401)});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint=`http://127.0.0.1:${server.address().port}/api/admin/eden/eidos`;
 const request=async(method='GET',body)=>{const res=await fetch(endpoint,{method,headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:res.status,body:await res.json()};};
 assert.equal((await fetch(endpoint)).status,401);
 assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.deepEqual((await request()).body.items,[{id:'booking'}]);
 const created=await request('POST',{});assert.equal(created.status,201,JSON.stringify(created.body));
 const seed=created.body.item;assert.match(seed.id,/^eidos-[\da-f-]{36}$/);assert.deepEqual(Object.keys(seed),['id']);
 const second=await request('POST',{});assert.equal(second.status,201);assert.notEqual(second.body.item.id,seed.id);
 assert.deepEqual((await request()).body.items.find(item=>item.id===seed.id),seed);
 const stored=await Eidos.findOne({externalId:seed.id}).lean();assert.deepEqual(Object.keys(stored).sort(),['_id','externalId']);assert.equal(stored.externalId,seed.id);
 for(const body of [{name:'Not a named entity'},{description:'No metadata'},{externalId:'chosen-id'},{goalId:'other'}])assert.equal((await request('POST',body)).status,400);
 assert.equal((await fetch(endpoint+'/'+seed.id,{method:'DELETE',headers:{Authorization:'Bearer admin'}})).status,404);
 assert.ok(await Eidos.exists({externalId:seed.id}));
 assert.equal((await request()).body.items.filter(item=>item.id==='booking').length,1);
});
