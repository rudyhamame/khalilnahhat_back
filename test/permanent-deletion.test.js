const {test}=require('node:test');const assert=require('node:assert/strict');
const mongoose=require('mongoose'),cloudinary=require('cloudinary').v2;
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');const {spawn,spawnSync}=require('node:child_process');
const {Asset,sweep}=require('../src/cloudinary-assets');
const {createPermanentDeletion,deletionIdentities}=require('../src/permanent-deletion');
test('cleanup identities include private raw files and every recording part, excluding static and foreign assets',()=>{
 const value={cover:'https://res.cloudinary.com/qa/image/upload/v1/Gallery/photo.jpg',foreign:'https://res.cloudinary.com/other/image/upload/Gallery/photo.jpg',logo:'https://res.cloudinary.com/qa/image/upload/khalil/site-assets/logo.png',sources:[{parts:[{publicId:'Live/part-a',delivery:'authenticated'},{publicId:'Live/part-b',delivery:'upload'}]}],document:{publicId:'khalil/private/file.pdf',resourceType:'raw',delivery:'authenticated'}};
 assert.deepEqual([...deletionIdentities(value,'qa').values()].map(a=>[a.publicId,a.resourceType,a.delivery]),[['Gallery/photo','image','upload'],['Live/part-a','video','authenticated'],['Live/part-b','video','upload'],['khalil/private/file.pdf','raw','authenticated']]);
});
test('permanent media deletion, cloud outages, shared files and live publication cascades',{timeout:120000},async t=>{
 if(spawnSync('mongod',['--version'],{stdio:'ignore'}).status!==0)return t.skip('mongod required');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'khalil-permanent-delete-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--replSet','deletionQA','--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});
 const oldCloud=cloudinary.config(),oldDestroy=cloudinary.uploader.destroy;cloudinary.config({cloud_name:'qa',api_key:'qa',api_secret:'qa'});
 t.after(async()=>{cloudinary.config(oldCloud);cloudinary.uploader.destroy=oldDestroy;await mongoose.disconnect();mongo.kill('SIGTERM');await new Promise(resolve=>mongo.exitCode!==null?resolve():mongo.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});});
 let direct;for(let i=0;i<30;i++){try{direct=await mongoose.createConnection(`mongodb://127.0.0.1:${port}`,{directConnection:true,serverSelectionTimeoutMS:400}).asPromise();break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.ok(direct);await direct.db.admin().command({replSetInitiate:{_id:'deletionQA',members:[{_id:0,host:`127.0.0.1:${port}`}]}});await direct.close();
 await mongoose.connect(`mongodb://127.0.0.1:${port}/delete_test?replicaSet=deletionQA`,{serverSelectionTimeoutMS:20000});
 const Owner=mongoose.model('DeletionTestOwner',new mongoose.Schema({url:String}));
 const {LiveRecording,registerLiveRecordings}=require('../src/live-recordings'),{MediaItem}=require('../src/content'),{ArchiveItem}=require('../src/models'),{GalleryAlbum}=require('../src/gallery-albums'),{Collection}=require('../src/music-archive'),{Version}=require('../src/music-ontology/models');
 await Promise.all([Asset,Owner,LiveRecording,MediaItem,ArchiveItem,GalleryAlbum,Collection,Version].map(M=>M.init()));
 let offline=false;const deleted=[];cloudinary.uploader.destroy=async(id,options)=>{if(offline)throw Error('Cloud offline');deleted.push({id,options});return {result:'ok'};};
 const deletion=createPermanentDeletion();
 const url=id=>`https://res.cloudinary.com/qa/image/upload/v1/Gallery/${id}.png`;
 await t.test('deleting the last owner destroys its file immediately with CDN invalidation',async()=>{
  const owner=await Owner.create({url:url('last')});await deletion.remove(Owner,{_id:owner._id});
  assert.equal(await Owner.countDocuments({_id:owner._id}),0);assert.equal(deleted.at(-1).id,'Gallery/last');assert.equal(deleted.at(-1).options.invalidate,true);
 });
 await t.test('shared media survives until the final owner is deleted',async()=>{
  const owners=await Owner.create([{url:url('shared')},{url:url('shared')}]);
  await deletion.remove(Owner,{_id:owners[0]._id});assert.equal(deleted.some(a=>a.id==='Gallery/shared'),false);
  await deletion.remove(Owner,{_id:owners[1]._id});assert.equal(deleted.some(a=>a.id==='Gallery/shared'),true);
 });
 await t.test('Cloudinary failure persists a retryable intent without restoring the item',async()=>{
  const owner=await Owner.create({url:url('retry')});offline=true;
  const removed=await deletion.remove(Owner,{_id:owner._id});assert.equal(removed.cloudinaryCleanupPending,true);assert.equal(await Owner.exists({_id:owner._id}),null);
  const receipt=await Asset.findOne({publicId:'Gallery/retry'});assert.equal(receipt.deleteRequested,true);assert.match(receipt.lastError,/offline/i);
  offline=false;await sweep();assert.ok(deleted.some(a=>a.id==='Gallery/retry'));assert.equal(await Asset.exists({publicId:'Gallery/retry'}),null);
 });
 await t.test('an in-progress reuse hold prevents racing a new upload',async()=>{
  const owner=await Owner.create({url:url('held')});await Asset.create({key:'qa:image:upload:Gallery/held',cloud:'qa',resourceType:'image',delivery:'upload',publicId:'Gallery/held',holdUntil:new Date(Date.now()+600000)});
  assert.equal((await deletion.remove(Owner,{_id:owner._id})).cloudinaryCleanupPending,true);assert.equal(deleted.some(a=>a.id==='Gallery/held'),false);
  await Asset.updateOne({publicId:'Gallery/held'},{$set:{holdUntil:new Date(0)}});await sweep();assert.ok(deleted.some(a=>a.id==='Gallery/held'));
 });
 const express=require('express'),app=express();app.use(express.json());const auth=(req,res,next)=>req.headers.authorization==='qa-admin'?next():res.status(401).json({message:'Unauthorized'});
 registerLiveRecordings(app,auth,{startWorker:false});
 require('../src/content').registerContent(app,auth);
 require('../src/mobile-admin').registerMobileAdmin(app,{requireAdmin:auth,requireAuth:auth,serializeRequest:()=>({})});
 await Promise.all(Object.values(mongoose.models).map(Model=>Model.init()));
 require('../src/music-ontology/routes').registerMusicOntology(app,{requireAdmin:auth});
 app.use((error,req,res,next)=>res.status(error.status||500).json({message:error.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const request=async(id,method='DELETE',suffix='',authorized=true)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/live-recordings/${id}${suffix}`,{method,headers:authorized?{Authorization:'qa-admin'}:{}});return {status:response.status,body:await response.json().catch(()=>({}))};};
 await t.test('live recording deletion removes published records and files atomically and has no restore route',async()=>{
  const row=await LiveRecording.create({roomName:'qa-finished',title:'QA',status:'ready',parts:[{publicId:'Live/finished',delivery:'upload'}]});
  const externalId=`live-${row._id}`,video=cloudinary.url('Live/finished',{secure:true,resource_type:'video',type:'upload',format:'mp4'});
  await ArchiveItem.collection.insertOne({externalId,title:'QA',audioUrl:cloudinary.url('Live/finished',{secure:true,resource_type:'video',type:'upload',format:'mp3'})});
  const media=await MediaItem.create({kind:'video',title:'QA',mediaUrl:video});await GalleryAlbum.create({name:'QA',itemIds:[String(media._id)]});
  assert.equal((await request(row.id,'DELETE','',false)).status,401);
  const result=await request(row.id);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.recoverable,false);
  assert.equal(await LiveRecording.exists({_id:row._id}),null);assert.equal(await ArchiveItem.exists({externalId}),null);assert.equal(await MediaItem.exists({_id:media._id}),null);
  assert.deepEqual((await GalleryAlbum.findOne({name:'QA'})).itemIds,[]);assert.ok(deleted.some(a=>a.id==='Live/finished'));
  assert.equal((await request(row.id,'POST','/restore')).status,404);
 });
 await t.test('Gallery deletion removes the actual asset and every album membership',async()=>{
  const media=await MediaItem.create({kind:'photo',title:'Image to delete',mediaUrl:url('gallery-delete')});
  const album=await GalleryAlbum.create({name:'Delete membership QA',itemIds:[String(media._id)]});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/content/media/${media.id}`,{method:'DELETE',headers:{Authorization:'qa-admin'}});
  assert.equal(response.status,200);assert.equal(await MediaItem.exists({_id:media._id}),null);assert.deepEqual((await GalleryAlbum.findById(album._id)).itemIds,[]);assert.ok(deleted.some(a=>a.id==='Gallery/gallery-delete'));
 });
 await t.test('ontology deletion clears versions and resolves audio receipt identities',async()=>{
  const id='qa-ontology-delete';
  await mongoose.connection.collection('musicaudioassets').insertOne({externalId:'qa-audio-receipt',url:'https://res.cloudinary.com/qa/video/authenticated/v1/khalil/assets/qa-audio.mp3'});
  await ArchiveItem.collection.insertOne({externalId:id,title:'QA ontology',ontologyRevision:0,audioAssetId:'qa-audio-receipt'});
  await Version.collection.insertOne({recordingId:id,number:1,snapshot:{coverImage:url('old-version')}});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/music-ontology/recordings/${id}`,{method:'DELETE',headers:{Authorization:'qa-admin','Content-Type':'application/json'},body:JSON.stringify({revision:0,permanent:true})});
  assert.equal(response.status,200,await response.text());assert.equal(await ArchiveItem.exists({externalId:id}),null);assert.equal(await Version.countDocuments({recordingId:id}),0);assert.ok(deleted.some(a=>a.id==='khalil/assets/qa-audio'));assert.ok(deleted.some(a=>a.id==='Gallery/old-version'));
 });
 await t.test('deleting a work type removes its artwork instead of leaving a soft-deleted entry',async()=>{
  const {DjWorkType}=require('../src/music-ontology/models');await DjWorkType.collection.insertOne({externalId:'qa-type',name:'QA type',revision:1,artworkUrl:url('type-artwork')});
  await require('../src/music-ontology/service').createService().deleteWorkType('qa-type');assert.equal(await DjWorkType.exists({externalId:'qa-type'}),null);assert.ok(deleted.some(a=>a.id==='Gallery/type-artwork'));
 });
 await t.test('completed AI chats are erased permanently while running tasks remain protected',async()=>{
  const {Task,createStore}=require('../src/ai-admin/store'),store=createStore();await store.init();
  await Task.create({_id:'qa-completed-chat',owner:'qa-owner',sessionId:'qa-chat',requestId:'qa-completed',command:'QA',state:'COMPLETED'});
  assert.equal((await store.deleteConversation('qa-owner','qa-chat')).deleted,1);assert.equal(await Task.exists({_id:'qa-completed-chat'}),null);
  await Task.create({_id:'qa-running-chat',owner:'qa-owner',sessionId:'qa-chat-active',requestId:'qa-running',command:'QA',state:'RUNNING'});
  assert.equal((await store.deleteConversation('qa-owner','qa-chat-active')).busy,true);assert.ok(await Task.exists({_id:'qa-running-chat'}));
 });
 await t.test('client deletion removes private documents and retains shared audio receipt identities',async()=>{
  const {User}=require('../src/models'),{StoredFile}=require('../src/mobile-admin');
  const clientId=new mongoose.Types.ObjectId();await User.collection.insertOne({_id:clientId,username:'qa-delete-client',email:'qa-delete@example.invalid',isAdmin:false});
  const file=await StoredFile.create({name:'QA contract',publicId:'khalil/private/qa-contract.pdf',resourceType:'raw',delivery:'authenticated',clientId});
  await mongoose.connection.collection('musicaudioassets').insertOne({externalId:'qa-client-shared',owner:String(clientId),url:'https://res.cloudinary.com/qa/video/authenticated/v1/khalil/assets/qa-client-shared.mp3'});
  await ArchiveItem.collection.insertOne({externalId:'qa-shared-owner',title:'Shared recording',audioAssetId:'qa-client-shared'});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/clients/${clientId}`,{method:'DELETE',headers:{Authorization:'qa-admin'}});
  assert.equal(response.status,200,await response.text());assert.equal(await User.exists({_id:clientId}),null);assert.equal(await StoredFile.exists({_id:file._id}),null);assert.ok(deleted.some(a=>a.id==='khalil/private/qa-contract.pdf'&&a.options.resource_type==='raw'));
  assert.ok(await mongoose.connection.collection('musicaudioassets').findOne({externalId:'qa-client-shared'}));
  await deletion.remove(ArchiveItem,{externalId:'qa-shared-owner'});assert.ok(deleted.some(a=>a.id==='khalil/assets/qa-client-shared'));
 });
 await t.test('active recordings and recordings referenced as source cannot be deleted',async()=>{
  const active=await LiveRecording.create({roomName:'qa-active',status:'recording'});assert.equal((await request(active.id)).status,409);assert.ok(await LiveRecording.exists({_id:active._id}));
  const row=await LiveRecording.create({roomName:'qa-used',status:'ready'}),externalId=`live-${row._id}`;
  await ArchiveItem.collection.insertMany([{externalId,title:'QA'},{externalId:'qa-dependent',title:'Dependent',sourceRecordingIds:[externalId]}]);
  assert.equal((await request(row.id)).status,409);assert.ok(await LiveRecording.exists({_id:row._id}));assert.ok(await ArchiveItem.exists({externalId}));
 });
});
