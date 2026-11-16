const test=require('node:test'),assert=require('node:assert/strict');
const {explicitGuestCount,withGuestCount}=require('./guest-count');
test('exact guest counts are found, ranges and ambiguity are not',()=>{
 assert.equal(explicitGuestCount('Yes, 120 guests. The venue is X'),120);
 assert.equal(explicitGuestCount('about 1,200 people'),1200);
 assert.equal(explicitGuestCount('between 100-150 guests'),null);
 assert.equal(explicitGuestCount('100 to 120 people'),null);
 assert.equal(explicitGuestCount('50 guests and 60 people'),null);
 assert.equal(explicitGuestCount('at 7pm on 12 June'),null);
});
test('a forgotten guest count is added once, never duplicated or repeated',()=>{
 const base={reply:'ok',orderPatch:[{path:'event.date',value:'2027-06-12'}]};
 assert.deepEqual(withGuestCount(base,'120 guests',{}).orderPatch.at(-1),{path:'event.guestCount',value:'120'});
 assert.equal(withGuestCount({...base,orderPatch:[{path:'event.guestCount',value:'80'}]},'120 guests',{}).orderPatch.length,1);
 assert.equal(withGuestCount(base,'120 guests',{'event.guestCount':'120'}).orderPatch.length,1);
 assert.equal(withGuestCount(base,'hello',{}),base);
});
