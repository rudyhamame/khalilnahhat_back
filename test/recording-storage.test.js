const {test}=require('node:test');
const assert=require('node:assert/strict');
const {recordingStorageConfig}=require('../src/recording-storage');
const fixture={ECHO_RECORDING_PUBLIC_ENDPOINT:'https://s3.us-west-004.backblazeb2.com',ECHO_RECORDING_BUCKET:'echo-staging-private',ECHO_RECORDING_REGION:'us-west-004',ECHO_RECORDING_ACCESS_KEY:'fixture-key',ECHO_RECORDING_SECRET:'fixture-secret'};
test('recording storage requires explicit HTTPS provider settings and never infers a local container',()=>{
 assert.equal(recordingStorageConfig({}),null);
 assert.equal(recordingStorageConfig({...fixture,ECHO_RECORDING_PUBLIC_ENDPOINT:''}),null);
 for(const endpoint of ['http://storage.example','https://user:password@storage.example','https://storage.example/private/path','https://storage.example/?secret=value','not-a-url'])assert.equal(recordingStorageConfig({...fixture,ECHO_RECORDING_PUBLIC_ENDPOINT:endpoint}),null);
});
test('B2 regional endpoint, bucket and credentials are preserved for both recording clients',()=>{
 const config=recordingStorageConfig(fixture);
 assert.equal(config.publicEndpoint,fixture.ECHO_RECORDING_PUBLIC_ENDPOINT);assert.equal(config.storageEndpoint,fixture.ECHO_RECORDING_PUBLIC_ENDPOINT);
 assert.equal(config.region,'us-west-004');assert.equal(config.bucket,'echo-staging-private');assert.equal(config.port,443);assert.equal(config.useSSL,true);
});
test('disk reserve is opt-in and rejects invalid configuration',()=>{
 const {recordingDiskReserve}=require('../src/recording-storage');
 assert.equal(recordingDiskReserve({}),0);
 assert.equal(recordingDiskReserve({ECHO_RECORDING_MIN_FREE_BYTES:'15032385536'}),14*1024**3);
 for(const value of ['-1','NaN','1.5','Infinity'])assert.throws(()=>recordingDiskReserve({ECHO_RECORDING_MIN_FREE_BYTES:value}),/Invalid recording disk reserve/);
});
test('LiveKit uses OVH HTTPS storage and rejects low disk before creating a room',async()=>{
 const {S3Client}=require('@aws-sdk/client-s3');const {RoomServiceClient}=require('livekit-server-sdk');const {prepareRecordingRoom,LiveRecording}=require('../src/live-recordings');
 const env={...fixture,ECHO_RECORDING_PUBLIC_ENDPOINT:'https://recordings.example',ECHO_RECORDING_REGION:'us-east-1',CLOUDINARY_API_SECRET:'fixture',LIVEKIT_URL:'wss://fixture.livekit.cloud',LIVEKIT_API_KEY:'fixture',LIVEKIT_API_SECRET:'fixture'};
 const keys=[...Object.keys(env),'ECHO_RECORDING_STORAGE_ENDPOINT','ECHO_RECORDING_MIN_FREE_BYTES'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const original={send:S3Client.prototype.send,createRoom:RoomServiceClient.prototype.createRoom,create:LiveRecording.create};
 let room,bucketMissing=false;
 try{
  Object.assign(process.env,env);delete process.env.ECHO_RECORDING_STORAGE_ENDPOINT;delete process.env.ECHO_RECORDING_MIN_FREE_BYTES;
  S3Client.prototype.send=async function(command){
   assert.equal(command.input.Bucket,fixture.ECHO_RECORDING_BUCKET);
   if(command.constructor.name==='HeadBucketCommand'){
    if(bucketMissing)throw {$metadata:{httpStatusCode:404}};
    return {};
   }
   assert.equal(command.constructor.name,'ListObjectsV2Command');return {Contents:[]};
  };
  RoomServiceClient.prototype.createRoom=async options=>{room=options;};LiveRecording.create=async()=>({_id:'fixture'});
  await prepareRecordingRoom('room-fixture','Fixture',true);
  const upload=room.egress.participant.fileOutputs[0].output.value;
  assert.equal(upload.endpoint,env.ECHO_RECORDING_PUBLIC_ENDPOINT);assert.equal(upload.bucket,fixture.ECHO_RECORDING_BUCKET);assert.equal(upload.region,'us-east-1');assert.equal(upload.forcePathStyle,true);
  bucketMissing=true;
  await assert.rejects(prepareRecordingRoom('room-missing','Missing',true),/Create the private recording staging bucket/);
  process.env.ECHO_RECORDING_MIN_FREE_BYTES=String(Number.MAX_SAFE_INTEGER);room=null;
  await assert.rejects(prepareRecordingRoom('room-low-disk','Low disk',true),/low on disk space/);
  assert.equal(room,null);
 }finally{
  S3Client.prototype.send=original.send;RoomServiceClient.prototype.createRoom=original.createRoom;LiveRecording.create=original.create;
  for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
});
