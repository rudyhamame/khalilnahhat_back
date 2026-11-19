const {test}=require('node:test');const assert=require('node:assert/strict');
const {beatMap,beatMapFor}=require('../src/music-ontology/rhythm-beat-map');
const V=require('../src/music-ontology/validation');
test('presets produce valid bar-length maps, including Waltz and aliases',()=>{
 const patterns=require('../contracts/rhythm-patterns.json');for(const row of patterns)assert.ok(beatMap.safeParse(beatMapFor(row.name)).success,row.name);
 assert.deepEqual(beatMapFor('Waltz 3/4').steps,[...'D.T.T.']);assert.equal(beatMapFor('فالس').meter,'3/4');assert.equal(beatMapFor('Unknown new rhythm'),null);
});
test('maps reject malformed bars, unsupported strokes, empty hits and non-rhythm use',()=>{
 const good={meter:'3/4',subdivision:2,steps:[...'D.T.T.']};assert.ok(beatMap.safeParse(good).success);
 for(const bad of [{...good,steps:['D']},{...good,steps:[...'......']},{...good,meter:'0/4'},{...good,subdivision:3},{...good,steps:[...'D.X.X.']},{...good,source:'javascript:alert(1)'}])assert.equal(beatMap.safeParse(bad).success,false);
 assert.equal(V.vocabulary.safeParse({kind:'genre',name:'Pop',beatMap:good}).success,false);assert.ok(V.vocabulary.safeParse({kind:'rhythm',name:'Waltz',beatMap:good}).success);
});
