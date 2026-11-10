const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const net=require('node:net');const {spawn,execFileSync}=require('node:child_process');const mongoose=require('mongoose');
test('direct recording durable chunks and archive lifecycle',{timeout:90000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'direct-recording-test-'));process.env.ECHO_DIRECT_RECORDING_DIR=path.join(dir,'spool');
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});
 t.after(async()=>{await mongoose.disconnect();mongo.kill('SIGTERM');if(mongo.exitCode===null)await new Promise(r=>mongo.once('exit',r));await fs.rm(dir,{recursive:true,force:true});});
 for(let i=0;i<50;i++){try{await mongoose.connect(`mongodb://127.0.0.1:${port}/direct_recording_test`,{serverSelectionTimeoutMS:200});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const {LiveRecording}=require('../src/live-recordings');const direct=require('../src/direct-recording');const {recordingJobs}=require('../src/recording-jobs');await LiveRecording.init();const jobs=recordingJobs(LiveRecording);
 const source=path.join(dir,'sample.webm');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1','-c:v','libvpx','-c:a','libopus',source]);const bytes=await fs.readFile(source);
 const row=await direct.createDirectRecording('test-direct-room','Direct test','owner');
 await t.test('duplicates are acknowledged once; conflicting or out-of-order data is rejected',async()=>{
  const half=Math.floor(bytes.length/2),first=bytes.subarray(0,half);
  assert.equal((await jobs.run(row._id,l=>direct.acceptChunk(l,0,first,'video/webm'))).nextSequence,1);
  assert.equal((await jobs.run(row._id,l=>direct.acceptChunk(l,0,first,'video/webm'))).nextSequence,1);
  await assert.rejects(jobs.run(row._id,l=>direct.acceptChunk(l,0,Buffer.from('wrong'),'video/webm')),/different data/);
  await assert.rejects(jobs.run(row._id,l=>direct.acceptChunk(l,2,first,'video/webm')),/missing recording chunk/);
  await jobs.run(row._id,l=>direct.acceptChunk(l,1,bytes.subarray(half),'video/webm'));
  await assert.rejects(jobs.run(row._id,l=>direct.seal(l,3,true)),/not arrived/);
  await assert.rejects(jobs.run(row._id,l=>direct.acceptChunk(l,2,Buffer.from('x'),'video/webm','0'.repeat(64))),/checksum mismatch/);
  await assert.rejects(jobs.run(row._id,l=>direct.seal(l,2,true,1)),/size does not match/);
  assert.equal((await LiveRecording.findById(row._id)).direct.count,2);
 });
 await t.test('real WebM chunks become an MP4 and originals survive archive failure',async()=>{
  await LiveRecording.updateOne({_id:row._id},{$set:{error:'Old capture error',attempts:2}});
  await jobs.run(row._id,l=>direct.seal(l,2,true));const sealed=await LiveRecording.findById(row._id);assert.equal(sealed.status,'processing');assert.equal(sealed.error,'');assert.equal(sealed.attempts,0);const provider=direct.directProvider();let fail=true,uploads=0;
  const pipeline=require('../src/recording-pipeline').createRecordingPipeline({Model:LiveRecording,providers:{direct:provider},prepareFiles:require('../src/recording-files').prepareRecordingFiles,upload:async(file,id)=>{uploads++;if(fail)throw new Error('archive unavailable');const stat=await fs.stat(file);return {public_id:id,bytes:stat.size};}});
  await pipeline.run(row._id);let saved=await LiveRecording.findById(row._id);assert.equal(saved.status,'upload_failed');await fs.access(path.join(direct.directory(saved),'capture.mp4'));
  fail=false;await pipeline.run(row._id);saved=await LiveRecording.findById(row._id);assert.equal(saved.status,'ready');assert.equal(saved.parts.length,1);assert.equal(saved.cleanupPending,false);assert.ok(saved.duration>0);await assert.rejects(fs.access(direct.directory(saved)),{code:'ENOENT'});assert.equal(uploads,2);
 });
 await t.test('AAC stereo source is archived without changing a single encoded audio packet',async()=>{
  const source=path.join(dir,'stereo.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','aevalsrc=sin(2*PI*440*t)|sin(2*PI*880*t):s=48000','-t','1','-c:v','libx264','-c:a','aac','-b:a','256k',source]);
  const original=await fs.readFile(source),r=await direct.createDirectRecording('test-audio-passthrough','Stereo passthrough','owner');
  await jobs.run(r._id,l=>direct.acceptChunk(l,0,original,'video/mp4'));await jobs.run(r._id,l=>direct.seal(l,1,true));
  const provider=direct.directProvider();try{await jobs.run(r._id,l=>provider.inspect(l.row,l));}finally{provider.release(r);}
  const output=path.join(direct.directory(r),'capture.mp4');
  const audio=file=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',file,'-map','0:a:0','-c:a','copy','-f','adts','pipe:1']);
  assert.deepEqual(audio(output),audio(source));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=channels,sample_rate','-of','json',output]));
  assert.equal(probe.streams[0].channels,2);assert.equal(probe.streams[0].sample_rate,'48000');
 });
 await t.test('authenticated upload routes fence owners and reject anonymous writes',async()=>{
  const express=require('express'),app=express();app.use(express.json());direct.registerDirectRecordingRoutes(app,(req,res,next)=>{if(!req.headers.authorization)return res.status(401).end();req.user={_id:req.headers.authorization};next();});const http=app.listen(0,'127.0.0.1');await new Promise(r=>http.once('listening',r));t.after(()=>http.close());const url=`http://127.0.0.1:${http.address().port}/api/live-stream/recordings/${row._id}`;
  assert.equal((await fetch(url+'/status')).status,401);assert.equal((await fetch(url+'/status',{headers:{Authorization:'other'}})).status,404);
  const r=await direct.createDirectRecording('test-missing-room','Test','owner');const result=await fetch(url.replace(String(row._id),String(r._id))+'/chunks/0',{method:'POST',headers:{Authorization:'owner','Content-Type':'application/octet-stream','X-Recording-Mime':'video/webm'},body:bytes});assert.equal(result.status,200);
 });
});
