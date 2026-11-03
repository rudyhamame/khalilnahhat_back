const test=require('node:test'),assert=require('node:assert/strict');
const {equipmentDemand,validateSetMembers}=require('../src/equipment-demand');
const {normalizeQuoteItems}=require('../src/quote-validation');
const catalog=[{slug:'speaker',name:'Speaker',isActive:true,minQuantity:1},{slug:'set',name:'Set',isActive:true,isSet:true,minQuantity:1,setItems:[{equipmentId:'speaker',quantity:2}]}];
test('bundles and standalone pieces share physical demand without duplicating quote prices',()=>{
 const lines=[{serviceId:'set',quantity:2},{serviceId:'speaker',quantity:1}];
 assert.deepEqual(equipmentDemand(lines,catalog),[{slug:'set',quantity:2},{slug:'speaker',quantity:5}]);
 assert.equal(normalizeQuoteItems(lines,catalog).length,2);
});
test('deleted members and cyclic bundles fail before submission or confirmation',()=>{
 assert.throws(()=>equipmentDemand([{serviceId:'set',quantity:1}],catalog.slice(1)),/no longer available/);
 assert.throws(()=>equipmentDemand([{serviceId:'loop',quantity:1}],[{slug:'loop',setItems:[{equipmentId:'loop',quantity:1}]}]),/cyclic/);
});
test('admin set validation rejects self references, missing members and nested sets',async()=>{
 const Model={find:async()=>catalog};
 await assert.rejects(validateSetMembers({slug:'set',isSet:true,setItems:[{equipmentId:'set',quantity:2}]},null,Model),/itself/);
 await assert.rejects(validateSetMembers({slug:'new',isSet:true,setItems:[{equipmentId:'set',quantity:2}]},null,{find:async()=>[catalog[1]]}),/individual/);
 await validateSetMembers({slug:'new',isSet:true,setItems:[{equipmentId:'speaker',quantity:2}]},null,{find:async()=>[catalog[0]]});
});
