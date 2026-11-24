const {test}=require('node:test'),assert=require('node:assert/strict'),mongoose=require('mongoose');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn,spawnSync}=require('node:child_process');
test('all local media types follow database ownership, direct deletion, retry, holds and restart adoption',{timeout:90000},async t=>{
 if(spawnSync('mongod',['--version'],{stdio:'ignore'}).status!==0)return t.skip('mongod required');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vps-cleanup-')),dbdir=path.join(directory,'db'),mediaDir=path.join(directory,'media');await fs.mkdir(dbdir);
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dbdir,'--logpath',path.join(directory,'mongo.log')],{stdio:'ignore'});
 Object.assign(process.env,{MEDIA_STORAGE_PROVIDER:'vps',MEDIA_STORAGE_DIR:mediaDir,MEDIA_PUBLIC_ORIGIN:'https://media.example',MEDIA_SIGNING_KEY:'cleanup-test-secret',MEDIA_RESERVE_BYTES:'1'});
 t.after(async()=>{await mongoose.disconnect();mongo.kill('SIGTERM');await new Promise(r=>mongo.exitCode!==null?r():mongo.once('exit',r));await fs.rm(directory,{recursive:true,force:true});});
 await mongoose.connect(`mongodb://127.0.0.1:${port}/cleanup`,{serverSelectionTimeoutMS:15000});
 const {Asset,uploadVpsAsset,adoptVpsAssets,hasReferences,sweep}=require('../src/cloudinary-assets'),media=require('../src/vps-media').store();await Asset.init();
 const db=mongoose.connection.db,png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
 const first=await uploadVpsAsset(png,{resource_type:'image'});await db.collection('gallery').insertOne({image:first.secure_url});await db.collection('equipment').insertOne({nested:{images:[first.secure_url]}});
 await Asset.updateMany({},{$set:{holdUntil:new Date(0)}});await db.collection('gallery').deleteMany({});await sweep();assert.ok(media.metadata(first.secure_url),'shared file stays');
 await db.collection('equipment').deleteMany({});
 await db.collection('musicaudioassets').insertOne({externalId:'indirect-audio',url:first.secure_url});await db.collection('musicrecordings').insertOne({audioAssetId:'indirect-audio'});
 let receipt=await Asset.findOne({publicId:first.public_id}).lean();assert.ok(await hasReferences(receipt),'audioAssetId indirection retains a local file');await db.collection('musicrecordings').deleteMany({});
 await db.collection('emailtemplates').insertOne({html:'<p><img src="'+first.secure_url+'"></p>'});assert.ok(await hasReferences(receipt),'rich-text embeds retain their files');await db.collection('emailtemplates').deleteMany({});
 const later=new Date(Date.now()+60*60*1000);await sweep({now:later});assert.ok(media.metadata(first.secure_url),'direct deletion gets grace');
 const remove=media.remove;let fails=true;media.remove=async(...a)=>{if(fails)throw Error('Filesystem temporarily unavailable');return remove(...a);};await sweep({now:new Date(+later+6*60*1000)});assert.ok(media.metadata(first.secure_url));assert.match((await Asset.findOne()).lastError,/Filesystem/);fails=false;
 await sweep({now:new Date(+later+7*60*1000)});assert.equal(media.metadata(first.secure_url),null);assert.equal((await Asset.findOne()).state,'deleted');
 const second=await uploadVpsAsset(png,{resource_type:'image',type:'authenticated'});let row=await Asset.findOne({publicId:second.public_id});await Asset.updateOne({_id:row._id},{$set:{holdUntil:new Date(0),missingSince:new Date(0)}});
 await sweep({check:async()=>{throw Error('Database scan failed');},now:later});assert.ok(media.metadata(second.secure_url),'DB errors never authorize deletion');
 let checks=0;await sweep({now:later,check:async()=>++checks===2});assert.ok(media.metadata(second.secure_url),'second reference scan cancels deletion');
 await Asset.updateOne({_id:row._id},{$set:{state:'deleting'}});await assert.rejects(uploadVpsAsset(png,{resource_type:'image',type:'authenticated'}),e=>e.status===409);await Asset.updateOne({_id:row._id},{$set:{state:'ready',holdUntil:new Date(Date.now()+600000)}});await sweep();assert.ok(media.metadata(second.secure_url),'upload holds protect an unsaved form');
 for(const [resourceType,bytes,ext]of [['raw',Buffer.from('%PDF-1.7 test'),'pdf'],['raw',Buffer.from('glTF-test'),'glb'],['raw',Buffer.from('word bytes'),'docx']]){
  const r=await uploadVpsAsset(bytes,{resource_type:resourceType,type:'authenticated',public_id:'file.'+ext});await db.collection('documents').insertOne({publicId:r.public_id});const asset=await Asset.findOne({publicId:r.public_id}).lean();assert.ok(await hasReferences(asset));
  await db.collection('documents').deleteMany({});await Asset.updateOne({_id:asset._id},{$set:{holdUntil:new Date(0),missingSince:new Date(0)}});await sweep({now:later});assert.equal(media.metadata(r.secure_url),null);
 }
 // Audio and video use the same ownership rules as images and raw documents.
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status===0){
  for(const format of ['wav','mp4']){
   const filename=path.join(directory,'sample.'+format);
   const args=format==='wav'?['-f','lavfi','-i','sine=frequency=440:sample_rate=8000','-t','0.1',filename]:['-f','lavfi','-i','color=c=black:s=32x32:r=10','-t','0.2','-c:v','libx264','-pix_fmt','yuv420p',filename];
   assert.equal(spawnSync('ffmpeg',['-v','error',...args],{stdio:'ignore'}).status,0);
   const r=await uploadVpsAsset(await fs.readFile(filename),{resource_type:'video',type:'authenticated'});
   await db.collection('media').insertOne({nested:{url:r.secure_url}});const asset=await Asset.findOne({publicId:r.public_id}).lean();assert.ok(await hasReferences(asset));
   await db.collection('media').deleteMany({});await Asset.updateOne({_id:asset._id},{$set:{holdUntil:new Date(0),missingSince:new Date(0)}});await sweep({now:later});assert.equal(media.metadata(r.secure_url),null);
  }
 }
 // A committed manifest whose registry insert was lost is re-adopted after restart.
 const orphan=await media.upload(png);await Asset.deleteMany({publicId:orphan.public_id});await adoptVpsAssets();row=await Asset.findOne({publicId:orphan.public_id});assert.ok(row);assert.ok(+row.holdUntil>Date.now());
 const {references,sweep:batchSweep}=require('../src/vps-media-lifecycle');
 const batchFile=await uploadVpsAsset(Buffer.concat([png,Buffer.from('batch')]),{resource_type:'image'});await db.collection('batchowners').insertOne({deep:{html:'<img src="'+batchFile.secure_url+'">'}});
 await Asset.updateOne({publicId:batchFile.public_id},{$set:{holdUntil:new Date(0)}});let batchRow=await Asset.findOne({publicId:batchFile.public_id}).lean();assert.ok((await references([batchRow])).has(batchRow.key));
 await batchSweep();assert.ok(media.metadata(batchFile.secure_url));await db.collection('batchowners').deleteMany({});await Asset.updateOne({_id:batchRow._id},{$set:{holdUntil:new Date(0),missingSince:new Date(0)}});
 await assert.rejects(batchSweep({scan:async()=>{throw Error('Batch database read failed');}}),/Batch database/);assert.ok(media.metadata(batchFile.secure_url));
 let batchChecks=0;await batchSweep({scan:async()=>new Set(++batchChecks===2?[batchRow.key]:[])});assert.ok(media.metadata(batchFile.secure_url),'batch recheck preserves a racing reference');
 await Asset.updateOne({_id:batchRow._id},{$set:{holdUntil:new Date(0),missingSince:new Date(0)}});let scans=0;await batchSweep({scan:async(...args)=>{scans++;return references(...args);}});assert.equal(scans,2);assert.equal(media.metadata(batchFile.secure_url),null);assert.equal((await Asset.findOne({_id:batchRow._id})).state,'deleted');
 const m=media.metadata(orphan.public_id);m.pinned=true;await Asset.deleteMany({publicId:orphan.public_id});await adoptVpsAssets();assert.equal(await Asset.findOne({publicId:orphan.public_id}),null,'code-owned site assets are not garbage collected');
});
