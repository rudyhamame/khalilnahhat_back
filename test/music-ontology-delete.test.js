const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {ArchiveItem}=require('../src/models');
const {registerMusicOntology}=require('../src/music-ontology/routes');

test('recording deletion accepts legacy revision zero and rejects invalid or stale revisions',async t=>{
 const original=ArchiveItem.findOne;
 const versions=[];
 const row={externalId:'legacy',title:'Legacy',ontologyRevision:undefined,audioUrl:'/retained.mp3',async save(){},toObject(){return {...this};}};
 ArchiveItem.findOne=()=>({session:async()=>row});
 t.after(()=>{ArchiveItem.findOne=original;});
 const app=express();app.use(express.json());
 const service={transaction:fn=>fn(null),models:{Version:{create:async entries=>versions.push(...entries)}}};
 registerMusicOntology(app,{service,requireAdmin:(req,res,next)=>req.headers.authorization==='test'?next():res.sendStatus(401)});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=(body,authorized=true)=>fetch(`http://127.0.0.1:${server.address().port}/api/admin/music-ontology/recordings/legacy`,{method:'DELETE',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'test'}:{})},body:JSON.stringify(body)});
 assert.equal((await request({revision:0},false)).status,401);
 for(const body of [{},{revision:-1},{revision:0.5}])assert.equal((await request(body)).status,400);
 assert.equal((await request({revision:1})).status,409);
 assert.equal((await request({revision:0})).status,200);
 assert.equal(row.ontologyRevision,1);assert.equal(row.archivalStatus,'ARCHIVED');assert.equal(row.publicationStatus,'WITHDRAWN');assert.equal(row.published,false);assert.equal(row.audioUrl,'/retained.mp3');assert.equal(versions.length,1);
 assert.equal((await request({revision:0})).status,409);assert.equal(versions.length,1);
});
