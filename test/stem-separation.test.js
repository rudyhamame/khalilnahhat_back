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
test('admin stem endpoints require admin auth and only accept supported audio URLs',async()=>{
  const express=require('express');
  const {registerStemSeparation}=require('../src/stem-separation');
  const app=express();
  registerStemSeparation(app,{requireAdmin:(req,res,next)=>req.headers.authorization==='Bearer admin'?next():res.sendStatus(401)});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try{
    const base=`http://127.0.0.1:${server.address().port}/api/admin/stems`,url=encodeURIComponent('https://res.cloudinary.com/demo/video/upload/v1/song.wav');
    assert.equal((await fetch(`${base}?url=${url}`)).status,401);
    assert.equal((await fetch(`${base}?url=${encodeURIComponent('https://evil.example/a.wav')}`,{headers:{authorization:'Bearer admin'}})).status,400);
    const ok=await fetch(`${base}?url=${url}`,{headers:{authorization:'Bearer admin'}});
    assert.equal(ok.status,200);
    const body=await ok.json();
    assert.ok(['idle','unavailable','ready','processing'].includes(body.status));
    assert.equal((await fetch(`${base}/audio/notachannel?url=${url}`,{headers:{authorization:'Bearer admin'}})).status,404);
  }finally{server.close();}
});
test('the same uploaded asset shares one stem cache entry regardless of its delivery URL',()=>{
  const {assetKey,keyFor}=require('../src/stem-separation');
  const hash='2e3a3b487d2b8e375cee33a9d3141952406164cf757d60a33baee83a72e3e8cd';
  const a=`https://res.cloudinary.com/demo/video/authenticated/s--AAA--/v1/khalil/assets/profile1/${hash}.wav`,b=`https://res.cloudinary.com/demo/video/authenticated/s--BBB--/v2/khalil/assets/profile1/${hash}.wav`;
  assert.equal(assetKey(a),assetKey(b));
  assert.notEqual(assetKey(a),keyFor(a));
  const other='https://res.cloudinary.com/demo/video/upload/v1/song.wav';
  assert.equal(require('../src/stem-separation').legacyAssetKey(other),keyFor(other));
  assert.notEqual(assetKey(other),keyFor(other));
});
test('the player can no longer start a separation',async()=>{
  const express=require('express');
  const {registerStemSeparation}=require('../src/stem-separation');
  const app=express();
  registerStemSeparation(app,{requireAdmin:(_req,res)=>res.sendStatus(401)});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/player/stems/any-id`,{method:'POST'});
    assert.equal(response.status,410);
  }finally{server.close();}
});
test('six-source admin keys differ from the four-source keys, but share one entry per audio file',()=>{
  const {assetKey,legacyAssetKey,ADMIN_CHANNELS}=require('../src/stem-separation');
  const hash='2e3a3b487d2b8e375cee33a9d3141952406164cf757d60a33baee83a72e3e8cd';
  const a=`https://res.cloudinary.com/demo/video/authenticated/s--AAA--/v1/khalil/assets/p/${hash}.wav`,b=`https://res.cloudinary.com/demo/video/authenticated/s--BBB--/v2/khalil/assets/p/${hash}.wav`;
  assert.equal(assetKey(a),assetKey(b));
  assert.notEqual(assetKey(a),legacyAssetKey(a));
  assert.equal(legacyAssetKey(a),legacyAssetKey(b));
  assert.deepEqual(ADMIN_CHANNELS,['vocals','drums','bass','guitar','piano','other']);
});
