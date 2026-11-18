const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBookingCode,bookingCodeCollision}=require('./booking-code');
test('booking IDs are generated as readable grouped codes rather than timestamps',()=>{
 const first=createBookingCode(),second=createBookingCode();
 assert.match(first,/^ECHO-(?:[2-9A-HJ-NP-Z]{4}-){2}[2-9A-HJ-NP-Z]{4}$/);
 assert.notEqual(first,second);
 assert.equal(bookingCodeCollision({code:11000,keyPattern:{confirmationCode:1}}),true);
 assert.equal(bookingCodeCollision({code:11000,keyPattern:{clientSubmissionId:1}}),false);
});
test('the canonical confirmation code has a unique index and cannot be edited',()=>{
 const {ServiceRequest}=require('./models');
 assert.equal(ServiceRequest.schema.path('confirmationCode').options.immutable,true);
 const index=ServiceRequest.schema.indexes().find(([keys])=>keys.confirmationCode===1);
 assert.equal(index[1].unique,true);
 assert.deepEqual(index[1].partialFilterExpression,{confirmationCode:{$type:'string'}});
});
