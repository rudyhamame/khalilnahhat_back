const {test}=require('node:test');const assert=require('node:assert/strict');
const {prepareRecordingFiles,segmentSeconds,cloudAssetId}=require('../src/recording-files');
const {execFile}=require('node:child_process');const {promisify}=require('node:util');const exec=promisify(execFile);const fs=require('node:fs/promises');const path=require('node:path');
test('segment planning reserves headroom below account limit and rejects missing media facts',()=>{
 assert.equal(segmentSeconds(400,100,100),18);
 assert.throws(()=>segmentSeconds(0,100,100));assert.throws(()=>segmentSeconds(100,0,100));
});
test('asset names are deterministic and distinguish each part without overwriting the legacy recording',()=>{
 assert.equal(cloudAssetId('room',0,1),'Live/room');
 assert.equal(cloudAssetId('room',0,3),'Live/room/part-001');
 assert.notEqual(cloudAssetId('room',0,3),cloudAssetId('room',1,3));
});
test('real MP4 stream-copy segmentation preserves audio/video, stays under limit, retains original',async()=>{
 const dir=await fs.mkdtemp('/tmp/echo-segment-test-');
 try {
  const original=path.join(dir,'original.mp4');
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','9','-c:v','libx264','-b:v','500k','-minrate','500k','-maxrate','500k','-bufsize','1000k','-g','25','-c:a','aac','-b:a','64k',original],{timeout:60000});
  const before=await fs.readFile(original);const limit=220000;
  const parts=await prepareRecordingFiles(original,dir,limit);
  assert.ok(parts.length>1);assert.ok(parts.every(p=>p.bytes>0&&p.bytes<=limit));
  assert.deepEqual(await fs.readFile(original),before);
  for(const part of parts){const {stdout}=await exec('ffprobe',['-v','error','-show_entries','stream=codec_name','-of','json',part.filename]);const codecs=JSON.parse(stdout).streams.map(s=>s.codec_name);assert.ok(codecs.includes('h264'));assert.ok(codecs.includes('aac'));}
  assert.ok(parts.reduce((n,p)=>n+p.duration,0)>=8.5);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
