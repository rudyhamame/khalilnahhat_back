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
