const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerSeasonalTheme,defaults}=require('./seasonal-theme');
test('public defaults, admin-only saves, validation, persistence and stale-write protection',async()=>{
 let row=null;const app=express();app.use(express.json());
 registerSeasonalTheme(app,{requireAdmin:(req,res,next)=>{if(req.headers.authorization!=='Bearer admin')return res.sendStatus(401);req.user={id:'owner'};next();},repository:{load:async()=>row,save:async(value,owner)=>{if(value.revision!==(row?.value.revision||0))return null;row={value:{...value,revision:value.revision+1},updatedBy:owner};return row;}}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${server.address().port}/api/seasonal-theme`;
 const put=(body,auth=true)=>fetch(url,{method:'PUT',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer admin'}:{})},body:JSON.stringify(body)});
 try{
  assert.deepEqual((await (await fetch(url)).json()).item,defaults);
  assert.equal((await put({...defaults,enabled:true},false)).status,401);assert.equal(row,null);
  assert.equal((await put({...defaults,enabled:'yes'})).status,400);assert.equal(row,null);
  assert.equal((await put({...defaults,unknown:true})).status,400);
  const saved=await (await put({...defaults,enabled:true,snow:true})).json();assert.equal(saved.item.revision,1);assert.equal(row.updatedBy,'owner');
  assert.deepEqual((await (await fetch(url)).json()).item,saved.item);
  assert.equal((await put(defaults)).status,409);assert.equal(row.value.enabled,true);
  const off=await (await put({...saved.item,enabled:false})).json();assert.equal(off.item.enabled,false);assert.equal(off.item.revision,2);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('audio settings reference only published archive recordings and retain old configurations',async()=>{
 const audioUrl='/api/music-archive/media/f26bdf9f-ffb1-4ef1-8478-16c97f02d444';
 let value={revision:2,enabled:true,lights:true,snow:false};
 const app=express();app.use(express.json());registerSeasonalTheme(app,{requireAdmin:(_req,_res,next)=>next(),repository:{load:async()=>({value}),save:async next=>({value:value={...next,revision:next.revision+1}})},listRecordings:async()=>[{externalId:'christmas-song',audioUrl}]});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${server.address().port}/api/seasonal-theme`;
 const put=audio=>fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...value,audio})});
 try{
  assert.deepEqual((await (await fetch(url)).json()).item.audio,{enabled:false,archiveIds:[]});
  assert.equal((await put({enabled:true,archiveIds:[]})).status,400);
  assert.equal((await put({enabled:true,archiveIds:['christmas-song','christmas-song']})).status,400);
  assert.equal((await put({enabled:true,archiveIds:['a','b','c','d']})).status,400);
  assert.equal((await put({enabled:true,archiveIds:['removed-or-unpublished']})).status,400);
  assert.equal((await put({enabled:true,archiveIds:['christmas-song'],url:'https://example.com/unapproved.mp3'})).status,400);
  const result=await (await put({enabled:true,archiveIds:['christmas-song']})).json();assert.deepEqual(result.item.audio,{enabled:true,archiveIds:['christmas-song']});
  assert.deepEqual((await (await fetch(url)).json()).item.audio,result.item.audio);
  assert.equal(JSON.stringify(result).includes(audioUrl),false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
