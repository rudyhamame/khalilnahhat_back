const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../src/event-order');

test('favourite song records survive backend normalization and AI patch validation',()=>{
 const songs=[{song:'Favourite',artist:'Artist',link:'https://youtu.be/example'},{song:'Second song',artist:'Second artist'}];
 const patch=core.sanitizeOrderPatch([{path:'music.favouriteSongs',value:JSON.stringify(songs)}]);
 assert.equal(patch.length,1);
 const order=core.applyOrderPatch(core.createEventOrder(),patch);
 assert.deepEqual(core.normalizeEventOrder(order).music.favouriteSongs,songs);
 for(const entry of [{song:'Only a name'},{song:'Song',artist:''},{song:'Song',artist:'Artist',link:'https://example.com/watch'}])assert.equal(core.sanitizeOrderPatch([{path:'music.favouriteSongs',value:JSON.stringify([entry])}]).length,0);
});
test('old song-only entries remain valid beside structured favourites',()=>{
 const favourites=['An existing favourite',{song:'New favourite',artist:'Artist'}];
 assert.deepEqual(core.normalizeEventOrder({...core.createEventOrder(),music:{favouriteSongs:favourites}}).music.favouriteSongs,favourites);
});
