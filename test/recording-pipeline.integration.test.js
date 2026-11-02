const {test}=require('node:test');const assert=require('node:assert/strict');const mongoose=require('mongoose');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const net=require('node:net');const {spawn}=require('node:child_process');
const {createRecordingPipeline}=require('../src/recording-pipeline');const {recordingJobs}=require('../src/recording-jobs');const {liveKitSources,createRecordingProviders}=require('../src/recording-providers');
test('durable live recording pipeline',{timeout:90000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-recording-test-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});
 t.after(async()=>{await mongoose.disconnect();mongo.kill('SIGTERM');if(mongo.exitCode===null)await new Promise(resolve=>mongo.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});});
 for(let i=0;i<40;i++){try{await mongoose.connect(`mongodb://127.0.0.1:${port}/recording_pipeline_qa`,{serverSelectionTimeoutMS:200});break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 assert.equal(mongoose.connection.readyState,1);
 const {LiveRecording:Model,view}=require('../src/live-recordings');await Model.init();let sequence=0;
 const fixture=async options=>{
  const row=await Model.create({roomName:'room-'+(++sequence),title:'QA live stream',...options});const uploads=[],removed=[],remote=new Map([['one','first-file'],['two','second-file']]);
  let snapshot={sources:[{key:'one',remote:'one'},{key:'two',remote:'two'}],active:false,ended:true,captureState:'ended',warning:''};
  const provider={inspect:async()=>snapshot,download:async(_row,source,file)=>fs.writeFile(file,remote.get(source.remote)),remove:async(_row,source)=>{const saved=await Model.findById(row._id);assert.ok(saved.sources.find(s=>s.key===source.key)?.saved,'never delete before durable save');removed.push(source.remote);}};
  const prepareFiles=async file=>[{filename:file,bytes:(await fs.stat(file)).size,duration:3}];
  const upload=async(file,id)=>{uploads.push(id);return {public_id:id,bytes:(await fs.stat(file)).size};};
  const pipeline=createRecordingPipeline({Model,providers:{livekit:provider,ovh:provider},prepareFiles,upload});
  return {row,uploads,removed,provider,prepareFiles,upload,pipeline,setSnapshot:value=>{snapshot=value;}};
 };
 await t.test('all completed LiveKit jobs and files are discovered; active files are excluded',()=>{
  const sources=liveKitSources([{egressId:'a',status:3,startedAt:1,fileResults:[{filename:'room/a.mp4'},{filename:'room/b.mp4'}]},{egressId:'b',status:3,startedAt:2,fileResults:[{filename:'room/c.mp4'}]},{egressId:'c',status:1,fileResults:[{filename:'room/open.mp4'}]}],'room');
  assert.equal(sources.length,3);assert.equal(new Set(sources.map(s=>s.key)).size,3);
  assert.throws(()=>liveKitSources([{egressId:'bad',status:3,fileResults:[{filename:'other/a.mp4'}]}],'room'));
 });
 await t.test('mid-save failure retains originals and resumes without duplicating saved parts',async()=>{
  const f=await fixture();let failed=false;
  const p=createRecordingPipeline({Model,providers:{livekit:f.provider},prepareFiles:f.prepareFiles,upload:async(file,id)=>{const value=await fs.readFile(file,'utf8');if(value==='second-file'&&!failed){failed=true;throw new Error('provider outage');}return f.upload(file,id);}});
  await p.run(f.row._id);let row=await Model.findById(f.row._id);assert.equal(row.status,'upload_failed');assert.equal(row.parts.length,1);assert.deepEqual(f.removed,['one']);
  await p.run(f.row._id);row=await Model.findById(f.row._id);assert.equal(row.status,'ready');assert.equal(row.parts.length,2);assert.equal(f.uploads.length,2);assert.equal(new Set(row.parts.map(p=>p.publicId)).size,2);assert.deepEqual(f.removed,['one','two']);assert.equal(row.attempts,0);assert.ok(row.parts.every(part=>part.sha256?.length===64));
 });
 await t.test('two workers cannot process the same recording concurrently',async()=>{
  const f=await fixture();let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});const download=f.provider.download;
  f.provider.download=async(...args)=>{entered();await gate;return download(...args);};
  const first=f.pipeline.run(f.row._id);await started;assert.equal((await f.pipeline.run(f.row._id)).busy,true);release();await first;assert.equal((await Model.findById(f.row._id)).status,'ready');assert.equal(f.uploads.length,2);
 });
 await t.test('a worker that loses its lease cannot commit or delete the source',async()=>{
  const f=await fixture();const p=createRecordingPipeline({Model,providers:{livekit:f.provider},prepareFiles:f.prepareFiles,upload:async(...args)=>{const result=await f.upload(...args);await Model.updateOne({_id:f.row._id},{$set:{leaseToken:'replacement',leaseUntil:new Date(Date.now()+60000)}});return result;}});
  await p.run(f.row._id);const row=await Model.findById(f.row._id);assert.equal(row.leaseToken,'replacement');assert.equal(row.parts.length,0);assert.equal(row.status,'processing');assert.equal(f.removed.length,0);
 });
 await t.test('cleanup failure preserves Ready and is retried without uploading again',async()=>{
  const f=await fixture();const remove=f.provider.remove;let fail=true;f.provider.remove=async(...args)=>{if(fail)throw new Error('cleanup offline');return remove(...args);};
  await f.pipeline.run(f.row._id);let row=await Model.findById(f.row._id);assert.equal(row.status,'ready');assert.equal(row.cleanupPending,true);fail=false;await f.pipeline.run(f.row._id);row=await Model.findById(f.row._id);assert.equal(row.status,'ready');assert.equal(row.cleanupPending,false);assert.equal(f.uploads.length,2);
 });
 await t.test('saved files remain incomplete when capture failed; active jobs never become Ready',async()=>{
  const f=await fixture();f.setSnapshot({sources:[{key:'one',remote:'one'}],active:true,ended:false,captureState:'recording',warning:'Capture interrupted'});await f.pipeline.run(f.row._id);let row=await Model.findById(f.row._id);assert.equal(row.status,'recording');assert.equal(row.parts.length,1);
  f.setSnapshot({sources:[],active:false,ended:true,captureState:'ended',warning:'Capture interrupted'});await f.pipeline.run(f.row._id);row=await Model.findById(f.row._id);assert.equal(row.status,'partial');assert.equal(view(row).canPreview,true);assert.equal(row.parts.length,1);assert.ok(!JSON.stringify(view(row)).includes(row.parts[0].publicId));
 });
 await t.test('renewing a live lease blocks takeover and expired ownership is fenced',async()=>{
  const f=await fixture();let now=1000000;const jobs=recordingJobs(Model,{clock:()=>now,leaseMs:100,heartbeatMs:100000});
  await jobs.run(f.row._id,async lease=>{now+=50;await lease.assert();now+=60;assert.equal((await jobs.run(f.row._id,async()=>{})).busy,true);now+=200;await assert.rejects(lease.save({title:'stale'}),{code:'RECORDING_LEASE_LOST'});});assert.notEqual((await Model.findById(f.row._id)).title,'stale');
 });
 await t.test('old relay saved segments are acknowledged without being uploaded twice',async()=>{
  const relay=require('../src/obs-relay-client');const original=relay.request;relay.request=async()=>({state:'ended',endedAt:Date.now()-30000,segments:[{id:'2026_01.mp4'}]});
  try{const provider=createRecordingProviders({clock:Date.now}).ovh;const result=await provider.inspect({roomName:'khalil-obs-00000000-0000-4000-8000-000000000000',relaySegments:['2026_01.mp4']});assert.equal(result.sources[0].alreadySaved,true);assert.equal(result.ended,true);}finally{relay.request=original;}
 });
 await t.test('one bad source does not prevent other completed sources from being saved',async()=>{
  const f=await fixture();const download=f.provider.download;f.provider.download=async(row,source,file)=>{if(source.key==='one')throw new Error('first source missing');return download(row,source,file);};
  for(let i=0;i<3;i++)await f.pipeline.run(f.row._id);
  const row=await Model.findById(f.row._id);assert.equal(row.status,'partial');assert.equal(row.parts.length,1);assert.equal(row.sources.filter(s=>!s.saved).length,1);assert.equal(view(row).canRetry,true);assert.deepEqual(f.removed,['two']);
 });
 await t.test('legacy single-file archive survives staging cleanup migration',async()=>{
  const f=await fixture({status:'ready',publicId:'legacy-file',bytes:12,duration:7,objectKey:'old.mp4',cleanupPending:true});
  f.provider.remove=async()=>{};await f.pipeline.run(f.row._id);const row=await Model.findById(f.row._id);assert.equal(row.publicId,'legacy-file');assert.equal(row.parts.length,1);assert.equal(row.parts[0].duration,7);assert.equal(row.objectKey,'');assert.equal(f.uploads.length,0);
 });
 await t.test('archive publication is locked, requires incomplete confirmation and resumes saved delivery metadata',async()=>{
  const express=require('express'),cloudinary=require('cloudinary').v2,{registerLiveRecordings}=require('../src/live-recordings');
  const app=express();app.use(express.json());const admin=(req,res,next)=>req.headers.authorization==='Bearer qa-admin'?next():res.sendStatus(403);
  registerLiveRecordings(app,admin,{startWorker:false,sweep:async()=>{}});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const cloudConfig=cloudinary.config();cloudinary.config({cloud_name:'qa',api_key:'qa',api_secret:'qa'});const originalRename=cloudinary.uploader.rename,originalResource=cloudinary.api.resource,{ArchiveItem}=require('../src/models'),{MediaItem}=require('../src/content');const originals=[ArchiveItem.findOneAndUpdate,MediaItem.findOneAndUpdate];let renamed=0,confirmedBytes=0;
  cloudinary.uploader.rename=async id=>{renamed++;return {public_id:id,bytes:confirmedBytes};};ArchiveItem.findOneAndUpdate=async()=>({});MediaItem.findOneAndUpdate=async()=>({});
  const f=await fixture();f.setSnapshot({sources:[{key:'one',remote:'one'}],ended:true,active:false,captureState:'ended',warning:'Capture interrupted'});await f.pipeline.run(f.row._id);
  const call=async(body,token='qa-admin')=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/live-recordings/${f.row._id}/publish`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return res.status;};
  try{
   assert.equal(await call({},'viewer'),403);assert.equal(await call({}),409);assert.equal(renamed,0);
   await Model.updateOne({_id:f.row._id},{$set:{leaseToken:'other',leaseUntil:new Date(Date.now()+60000)}});assert.equal(await call({allowPartial:true}),409);assert.equal(renamed,0);
   await Model.updateOne({_id:f.row._id},{$set:{leaseUntil:new Date(0)}});assert.equal(await call({allowPartial:true}),502);confirmedBytes=Buffer.byteLength('first-file');assert.equal(await call({allowPartial:true}),200);
   let row=await Model.findById(f.row._id);assert.equal(row.published,true);assert.equal(row.parts[0].delivery,'upload');assert.equal(row.sources[0].parts[0].delivery,'upload');
   await f.pipeline.run(f.row._id);row=await Model.findById(f.row._id);assert.equal(row.parts[0].delivery,'upload');assert.equal(await call({allowPartial:true}),200);assert.equal(renamed,2);
  }finally{cloudinary.config(cloudConfig);cloudinary.uploader.rename=originalRename;cloudinary.api.resource=originalResource;[ArchiveItem.findOneAndUpdate,MediaItem.findOneAndUpdate]=originals;await new Promise(resolve=>server.close(resolve));}
 });

 await t.test('missing archive confirmation keeps originals and retries cleanup separately',async()=>{
  const f=await fixture();let available=false;
  const p=createRecordingPipeline({Model,providers:{livekit:f.provider},prepareFiles:f.prepareFiles,upload:f.upload,verify:async()=>{if(!available)throw new Error('archive unavailable');}});
  await p.run(f.row._id);let row=await Model.findById(f.row._id);assert.equal(row.cleanupPending,true);assert.equal(row.status,'ready');assert.equal(f.removed.length,0);
  available=true;await p.run(f.row._id);row=await Model.findById(f.row._id);assert.equal(row.cleanupPending,false);assert.equal(f.uploads.length,2);assert.equal(f.removed.length,2);
 });
 await t.test('real encoded media is inspected, hashed, saved and committed before cleanup',async()=>{
  const {execFile}=require('node:child_process'),{promisify}=require('node:util'),exec=promisify(execFile);const media=path.join(dir,'source.mp4');
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-c:a','aac',media]);
  const f=await fixture();f.setSnapshot({sources:[{key:'real-media',remote:'one'}],active:false,ended:true,captureState:'ended',warning:''});f.provider.download=async(_r,_s,file)=>fs.copyFile(media,file);
  const p=createRecordingPipeline({Model,providers:{livekit:f.provider},prepareFiles:require('../src/recording-files').prepareRecordingFiles,upload:f.upload});await p.run(f.row._id);
  const row=await Model.findById(f.row._id);assert.equal(row.status,'ready');assert.equal(row.parts.length,1);assert.ok(row.duration>=1.9);assert.equal(row.parts[0].sha256,require('node:crypto').createHash('sha256').update(await fs.readFile(media)).digest('hex'));assert.deepEqual(f.removed,['one']);
 });

});
