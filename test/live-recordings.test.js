const {test}=require('node:test');
const assert=require('node:assert/strict');
const {objectBelongsToRoom,view}=require('../src/live-recordings');
test('recordings accept only MP4 objects belonging to the exact room',()=>{
 assert.equal(objectBelongsToRoom('room/participant-2026.mp4','room'),true);
 for(const key of ['other/participant.mp4','room-evil/a.mp4','room/../other/a.mp4','room/a.json',null])assert.equal(objectBelongsToRoom(key,'room'),false);
});
test('archive responses expose status but no private storage identifiers',()=>{
 const result=view({_id:'123',title:'Live',status:'ready',publicId:'private/path',objectKey:'secret/object',delivery:'authenticated',bytes:100,error:''});
 assert.equal(result.status,'ready');assert.equal(result.publicId,undefined);assert.equal(result.objectKey,undefined);
});
test('private multipart view exposes count/size but no asset identifiers',()=>{
 const result=view({_id:'id',status:'ready',parts:[{publicId:'secret-one',delivery:'authenticated',bytes:10,duration:2},{publicId:'secret-two',delivery:'authenticated',bytes:20,duration:4}]});
 assert.equal(result.canPreview,true);assert.equal(result.partCount,2);assert.deepEqual(result.parts,[{index:0,bytes:10,durationSec:2},{index:1,bytes:20,durationSec:4}]);assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('preview and download routes require admin and reject missing or invalid parts',async()=>{
 const {registerLiveRecordings,LiveRecording}=require('../src/live-recordings');const routes={};const admin=()=>{};
 registerLiveRecordings({get:(p,a,h)=>{assert.equal(a,admin);routes[p]=h;},post:(_p,a)=>assert.equal(a,admin),delete:(_p,a)=>assert.equal(a,admin)},admin);
 assert.ok(routes['/api/admin/live-recordings/:id/preview']);
 const original=LiveRecording.findOne;LiveRecording.findOne=async()=>({status:'ready',publicId:'private-id',delivery:'authenticated'});
 const response=()=>({code:200,set(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
 try {
  const invalid=response();await routes['/api/admin/live-recordings/:id/preview']({params:{id:'012345678901234567890123'},query:{part:'-1'}},invalid);assert.equal(invalid.code,400);
  LiveRecording.findOne=async()=>({status:'upload_failed'});const failed=response();await routes['/api/admin/live-recordings/:id/preview']({params:{id:'012345678901234567890123'},query:{}},failed);assert.equal(failed.code,404);
 }finally{LiveRecording.findOne=original;}
});
test('signed preview URL is inline, authenticated, bounded and cannot choose another recording',()=>{
 const {recordingLink}=require('../src/live-recordings');const cloudinary=require('cloudinary').v2;
 const old=cloudinary.config();cloudinary.config({cloud_name:'test',api_key:'test',api_secret:'test'});
 try{const url=new URL(recordingLink({parts:[{publicId:'owned/part1',delivery:'authenticated'},{publicId:'owned/part2',delivery:'authenticated'}]},'1',false));
 assert.equal(url.searchParams.get('public_id'),'owned/part2');assert.equal(url.searchParams.get('type'),'authenticated');assert.equal(url.searchParams.get('attachment'),'false');assert.ok(Number(url.searchParams.get('expires_at'))<=Date.now()/1000+181);
 assert.equal(recordingLink({parts:[{publicId:'owned/part1'}]},'2',false),null);
 }finally{cloudinary.config(old);}
});
test('missing Cloudinary asset in nested SDK 404 proceeds to private upload; other errors never do',async()=>{
 const {uploadRecordingPart}=require('../src/live-recordings');const c=require('cloudinary').v2;const {EventEmitter}=require('node:events');
 const read=c.api.resource,upload=c.uploader.upload_large;let uploads=0;
 try{
  c.api.resource=async()=>{throw {error:{http_code:404,message:'not found'}};};
  c.uploader.upload_large=(_file,options,cb)=>{uploads++;assert.equal(options.type,'authenticated');assert.equal(options.resource_type,'video');assert.equal(options.overwrite,false);queueMicrotask(()=>cb(null,{public_id:options.public_id,bytes:10}));return new EventEmitter();};
  assert.equal((await uploadRecordingPart('fixture','owned/part')).bytes,10);assert.equal(uploads,1);
  c.api.resource=async()=>{throw {error:{http_code:500}};};
  await assert.rejects(uploadRecordingPart('fixture','owned/part'));assert.equal(uploads,1);
  c.api.resource=async()=>({public_id:'owned/part',bytes:10});await uploadRecordingPart('fixture','owned/part');assert.equal(uploads,1);
 }finally{c.api.resource=read;c.uploader.upload_large=upload;}
});
test('delete is admin-only, atomic, recoverable and cannot remove active/saving media',async()=>{
 const {registerLiveRecordings,LiveRecording}=require('../src/live-recordings');const routes={};const admin=()=>{};
 const register=(p,a,h)=>{assert.equal(a,admin);routes[p]=h;};registerLiveRecordings({get:register,post:register,delete:register},admin);
 const old=LiveRecording.findOneAndUpdate;let filter,change;
 LiveRecording.findOneAndUpdate=async(f,c)=>{filter=f;change=c;return {_id:'012345678901234567890123',status:'ready'};};
 const res=()=>({code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
 try{
  let r=res();await routes['/api/admin/live-recordings/:id']({params:{id:'012345678901234567890123'}},r);
  assert.equal(r.body.recoverable,true);assert.equal(filter.deletedAt,null);assert.ok(!filter.status.$in.includes('processing'));assert.ok(!filter.status.$in.includes('recording'));assert.ok(change.$set.deletedAt instanceof Date);
  LiveRecording.findOneAndUpdate=async()=>null;r=res();await routes['/api/admin/live-recordings/:id']({params:{id:'012345678901234567890123'}},r);assert.equal(r.code,409);
  LiveRecording.findOneAndUpdate=async(f,c)=>{filter=f;change=c;return {_id:'012345678901234567890123',status:'ready'};};
  r=res();await routes['/api/admin/live-recordings/:id/restore']({params:{id:'012345678901234567890123'}},r);assert.equal(change.$set.deletedAt,null);assert.deepEqual(filter.deletedAt,{$ne:null});
 }finally{LiveRecording.findOneAndUpdate=old;}
});
test('recording is started from the publisher when LiveKit recreated the room without it, and never twice',async()=>{
 const env={ECHO_RECORDING_PUBLIC_ENDPOINT:'https://s3.example.com',ECHO_RECORDING_ACCESS_KEY:'k',ECHO_RECORDING_SECRET:'s',CLOUDINARY_API_SECRET:'c',LIVEKIT_URL:'https://x.livekit.cloud',LIVEKIT_API_KEY:'a',LIVEKIT_API_SECRET:'b'};
 const saved={};for(const key of Object.keys(env)){saved[key]=process.env[key];process.env[key]=env[key];}
 const {EgressClient,RoomServiceClient}=require('livekit-server-sdk');
 const originals=[EgressClient.prototype.listEgress,EgressClient.prototype.startParticipantEgress,RoomServiceClient.prototype.listParticipants];
 let jobs=[],participants=[];const started=[];
 EgressClient.prototype.listEgress=async()=>jobs;
 EgressClient.prototype.startParticipantEgress=async(room,identity,output)=>{started.push([room,identity,Boolean(output.file)]);return {};};
 RoomServiceClient.prototype.listParticipants=async()=>participants;
 try {
  const {ensureRecording}=require('../src/live-recordings');
  assert.equal(await ensureRecording('room'),false);            // connected but nothing published yet
  participants=[{identity:'khalil-obs',tracks:[{}]}];
  assert.equal(await ensureRecording('room'),true);             // media is flowing and nothing records it: start now
  assert.deepEqual(started,[['room','khalil-obs',true]]);
  jobs=[{status:1}];
  assert.equal(await ensureRecording('room'),false);            // already recording: no second recording
  assert.equal(started.length,1);
 } finally {
  [EgressClient.prototype.listEgress,EgressClient.prototype.startParticipantEgress,RoomServiceClient.prototype.listParticipants]=originals;
  for(const key of Object.keys(env)){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
 }
});
