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
test('LiveKit receives the configured bucket and region without creating a provider bucket',async()=>{
 const {Client}=require('minio');const {RoomServiceClient}=require('livekit-server-sdk');const {prepareRecordingRoom,LiveRecording}=require('../src/live-recordings');
 const env={...fixture,CLOUDINARY_API_SECRET:'fixture',LIVEKIT_URL:'wss://fixture.livekit.cloud',LIVEKIT_API_KEY:'fixture',LIVEKIT_API_SECRET:'fixture'};
 const previous=Object.fromEntries([...Object.keys(env),'ECHO_RECORDING_STORAGE_ENDPOINT'].map(key=>[key,process.env[key]]));
 const original={bucketExists:Client.prototype.bucketExists,listObjectsV2:Client.prototype.listObjectsV2,makeBucket:Client.prototype.makeBucket,createRoom:RoomServiceClient.prototype.createRoom,create:LiveRecording.create};
 let room;
 try{
  Object.assign(process.env,env);delete process.env.ECHO_RECORDING_STORAGE_ENDPOINT;
  Client.prototype.bucketExists=async bucket=>{assert.equal(bucket,fixture.ECHO_RECORDING_BUCKET);return true;};
  Client.prototype.listObjectsV2=async function*(){};
  Client.prototype.makeBucket=async()=>assert.fail('Buckets must be provisioned outside the application.');
  RoomServiceClient.prototype.createRoom=async options=>{room=options;};LiveRecording.create=async()=>({_id:'fixture'});
  await prepareRecordingRoom('room-fixture','Fixture',true);
  const upload=room.egress.participant.fileOutputs[0].output.value;
  assert.equal(upload.endpoint,fixture.ECHO_RECORDING_PUBLIC_ENDPOINT);assert.equal(upload.bucket,fixture.ECHO_RECORDING_BUCKET);assert.equal(upload.region,'us-west-004');assert.equal(upload.forcePathStyle,true);
  Client.prototype.bucketExists=async()=>false;
  await assert.rejects(prepareRecordingRoom('room-missing','Missing',true),/Create the private recording staging bucket/);
 }finally{
  Object.assign(Client.prototype,{bucketExists:original.bucketExists,listObjectsV2:original.listObjectsV2,makeBucket:original.makeBucket});RoomServiceClient.prototype.createRoom=original.createRoom;LiveRecording.create=original.create;
  for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
});
