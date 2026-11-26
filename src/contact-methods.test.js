const test=require('node:test'),assert=require('node:assert/strict');
const {CONTACT_METHODS}=require('./contact-methods');
const {User}=require('./models');
const core=require('./eventOrderCore.mjs');
const {eventSchema}=require('./quote-validation');
test('Meet Echo is valid in accounts, the booking contract and legacy quote payloads',()=>{
 assert.ok(CONTACT_METHODS.includes('meet-echo'));
 assert.equal(core.optionName('customer.contactMethod','meet-echo'),'Meet Echo');
 const user=new User({firstName:'Ana',lastName:'Client',username:'ana',email:'ana@example.test',passwordHash:'test-hash',preferredContact:'meet-echo'});
 assert.equal(user.validateSync(),undefined);
 const order=core.applyAccountProfile(core.createEventOrder(),{firstName:'Ana',lastName:'Client',email:'ana@example.test',phoneNumber:'4165550100',preferredContact:'meet-echo'});
 assert.equal(order.customer.contactMethod,'meet-echo');assert.equal(core.orderToLegacy(order).contactMethod,'meet-echo');
 assert.equal(eventSchema.safeParse({eventType:'wedding',eventDate:'2099-06-20',phone:'4165550100',contactMethod:'meet-echo'}).success,true);
 user.preferredContact='invalid-method';assert.ok(user.validateSync());
});
