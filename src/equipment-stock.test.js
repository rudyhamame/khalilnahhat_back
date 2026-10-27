const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {PRICE_EQUIPMENT,stockView,priceStockView}=require('./equipment-stock');
const {Equipment,registerEquipmentRoutes,publicView}=require('./equipment');
test('only confirmed stock is published, zero is unavailable and minimum order quantity is respected',()=>{
 assert.deepEqual(stockView({quantityOwned:1,stockTracked:false}),{availableQuantity:null,availabilityStatus:'on_request'});
 assert.deepEqual(stockView({quantityOwned:4,stockTracked:true}),{availableQuantity:4,availabilityStatus:'available'});
 assert.deepEqual(stockView({quantityOwned:0,stockTracked:true}),{availableQuantity:0,availabilityStatus:'unavailable'});
 assert.deepEqual(stockView({quantityOwned:4,stockTracked:true,minQuantity:10}),{availableQuantity:4,availabilityStatus:'unavailable'});
 assert.deepEqual(stockView({quantityOwned:4,stockTracked:true,isActive:false}),{availableQuantity:0,availabilityStatus:'unavailable'});
 for(const value of [undefined,null,-1,1.5,NaN])assert.equal(stockView({quantityOwned:value,stockTracked:true}).availableQuantity,null);
});
test('public equipment data contains quantity/status but never internal price or inventory controls',()=>{
 const result=publicView({slug:'qsc-k122',name:'QSC K12.2',quantityOwned:2,stockTracked:true,isActive:true,priceCents:10000});
 assert.equal(result.availableQuantity,2);assert.equal(result.availabilityStatus,'available');assert.equal(result.priceCents,undefined);assert.equal(result.stockTracked,undefined);assert.equal(result.quantityOwned,undefined);
});
test('price items link explicitly to the same equipment and non-equipment services have no fabricated stock',()=>{
 assert.equal(Object.keys(PRICE_EQUIPMENT).length,16);
 const rows=[{slug:'qsc-k122',quantityOwned:6,stockTracked:true}];
 assert.deepEqual(priceStockView({serviceId:'qsc-k12-2-speaker'},rows),{equipmentId:'qsc-k122',availableQuantity:6,availabilityStatus:'available'});
 assert.deepEqual(priceStockView({serviceId:'song-request-live'},rows),{equipmentId:null,availableQuantity:null,availabilityStatus:'not_applicable'});
 assert.equal(priceStockView({serviceId:'qsc-k12-2-speaker'},[]).equipmentId,null);
});
test('quantity editing requires admin, rejects invalid counts and updates the public equipment result',async t=>{
 const rows=[{slug:'qsc-k122',category:'sound',name:'QSC',quantityOwned:1,stockTracked:false,isActive:true},{slug:'hidden',category:'sound',name:'Hidden',isActive:false},{slug:'dj',category:'dj',name:'DJ',isActive:true}];
 const originals={bulkWrite:Equipment.bulkWrite,find:Equipment.find,findOneAndUpdate:Equipment.findOneAndUpdate};
 Equipment.bulkWrite=async()=>{};
 Equipment.find=filter=>({sort:async()=>rows.filter(row=>!filter||!filter.isActive||row.isActive===filter.isActive&&row.category!==filter.category.$ne)});
 Equipment.findOneAndUpdate=async(filter,body)=>{const item=rows.find(row=>row.slug===filter.slug);if(item)Object.assign(item,body);return item;};
 t.after(()=>Object.assign(Equipment,originals));
 const app=express();app.use(express.json());registerEquipmentRoutes(app,(req,res,next)=>req.get('authorization')==='Bearer admin'?next():res.sendStatus(401));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}/api/equipment`;
 const patch=async(body,token='admin')=>fetch(base+'/qsc-k122',{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 let result=await (await fetch(base)).json();assert.equal(result.items.length,1);assert.equal(result.items[0].availableQuantity,null);
 assert.equal((await patch({quantityOwned:10,stockTracked:true},'client')).status,401);assert.equal(rows[0].stockTracked,false);
 for(const count of [-1,0.5,'2',null])assert.equal((await patch({quantityOwned:count,stockTracked:true})).status,400);
 result=await (await patch({quantityOwned:7,stockTracked:true})).json();assert.equal(result.item.availableQuantity,7);
 result=await (await fetch(base)).json();assert.equal(result.items[0].availableQuantity,7);assert.equal(result.items[0].availabilityStatus,'available');assert.equal(result.items[0].priceCents,undefined);
 await patch({quantityOwned:0,stockTracked:true});result=await (await fetch(base)).json();assert.equal(result.items[0].availabilityStatus,'unavailable');assert.equal(result.items[0].availableQuantity,0);
});
