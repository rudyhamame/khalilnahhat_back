const test=require('node:test');
const assert=require('node:assert/strict');
const {createBookingData,bookingDataTool}=require('./ai-booking-data');
test('booking eye reads fresh sources and distinguishes failed availability from an empty calendar',async()=>{
 let calls=0,failed=false;
 const load=createBookingData({loadAvailability:async year=>{calls++;if(failed)throw Error('private DB error');return {year,days:{[`${year}-11-14`]:[{start:1080,end:1380}]}};},loadCatalog:async()=>[{id:'wedding',kind:'event'}],loadEquipment:async()=>[{slug:'set',name:'Set',setItems:[{equipmentId:'speaker',quantity:2}],stockTracked:true,quantityOwned:3}],loadPrices:async()=>[{serviceId:'set',amountCents:50000,currency:'CAD',privateNote:'secret'}]});
 const year=new Date().getUTCFullYear(),first=await load(year);
 assert.equal(first.availability.status,'ready');assert.deepEqual(first.availability.data.days[`${year}-11-14`],[{start:1080,end:1380}]);
 assert.equal(first.equipment.data[0].isSet,true);assert.equal(first.equipment.data[0].availableQuantity,3);assert.equal(first.prices.data[0].privateNote,undefined);assert.equal(first.reserved,false);
 failed=true;const next=await load(year);assert.equal(calls,2);assert.equal(next.availability.status,'unavailable');assert.equal(next.availability.data,null);assert.equal(next.catalog.status,'ready');assert.doesNotMatch(JSON.stringify(next),/private DB/);
 await assert.rejects(()=>load(1900),{status:400});assert.equal(bookingDataTool.name,'read_booking_data');
});


test('live-data instructions agree with automatic task saving and distinguish business reservation',()=>{
 const {bookingDataInstructions}=require('./ai-booking-data');
 assert.match(bookingDataInstructions,/applied and saved automatically/);
 assert.match(bookingDataInstructions,/saved=true/);
 assert.match(bookingDataInstructions,/Never ask for task checkmarks/);
 assert.match(bookingDataInstructions,/never a reservation/);
});
