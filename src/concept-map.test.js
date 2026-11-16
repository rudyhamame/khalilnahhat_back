const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerConceptMap,defaults}=require('./concept-map');
test('public defaults, admin-only validated saves and persistence',async()=>{
 let row=null;const app=express();app.use(express.json());
 registerConceptMap(app,{requireAdmin:(req,res,next)=>{if(req.headers.authorization!=='Bearer admin')return res.sendStatus(401);req.user={id:'owner'};next();},repository:{load:async()=>row,save:async(value,owner)=>(row={value,updatedBy:owner})}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${server.address().port}/api/concept-map`;
 const put=(body,auth=true)=>fetch(url,{method:'PUT',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer admin'}:{})},body:JSON.stringify(body)});
 try{
  assert.deepEqual((await (await fetch(url)).json()).item,defaults);
  assert.equal((await put({...defaults,layout:'net'},false)).status,401);assert.equal(row,null);
  assert.equal((await put({...defaults,layout:'spiral'})).status,400);assert.equal((await put({...defaults,extra:1})).status,400);assert.equal(row,null);
  const saved=await (await put({layout:'around',shape:'elbow',format:'atoms'})).json();assert.equal(saved.item.layout,'around');assert.equal(row.updatedBy,'owner');
  assert.deepEqual((await (await fetch(url)).json()).item,saved.item);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
