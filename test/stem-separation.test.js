const test=require('node:test');
const assert=require('node:assert/strict');
const {validateSource,keyFor,CHANNELS}=require('../src/stem-separation');
test('stem downloads cannot target arbitrary servers or non-audio assets',()=>{
  assert.equal(validateSource('https://res.cloudinary.com/demo/video/upload/v1/song.wav'),true);
  for(const url of ['http://127.0.0.1/private','file:///etc/passwd','https://res.cloudinary.com.evil.example/demo/video/upload/a.wav','https://res.cloudinary.com/demo/image/upload/a.png'])assert.equal(validateSource(url),false);
});
test('cache identity changes with the audio source; stem paths use only fixed channel names',()=>{
  assert.match(keyFor('https://example.test/a.wav'),/^[a-f0-9]{64}$/);
  assert.notEqual(keyFor('a.wav'),keyFor('b.wav'));
  assert.deepEqual(CHANNELS,['vocals','drums','bass','other']);
});
