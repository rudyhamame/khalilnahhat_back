const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const mongoose=require('mongoose');

test('recording preflight and save accept registered OVH audio while rejecting other media and foreign URLs',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'recording-ovh-validation-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const env={MEDIA_STORAGE_PROVIDER:'vps',MEDIA_STORAGE_DIR:directory,MEDIA_PUBLIC_ORIGIN:'https://media.example',MEDIA_SIGNING_KEY:'isolated-test-signing-key',MEDIA_RESERVE_BYTES:'1',CLOUDINARY_CLOUD_NAME:'demo'};
 for(const [key,value]of Object.entries(env)){const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}
 const media=require('../src/vps-media'),store=media.store();
 const wav=Buffer.alloc(44+8000*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
 const pub=await store.upload(wav,{resource_type:'video'}),priv=await store.upload(wav,{resource_type:'video',type:'authenticated'});
 const image=await store.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
 const old={externalId:'recording-existing',revision:0,audioUrl:pub.secure_url,set(value){Object.assign(this,value);},async save(){return this;}};
 const versions=[];
 t.mock.method(mongoose,'startSession',async()=>({withTransaction:fn=>fn(),endSession:async()=>{}}));
 const models={DjWorkTypeSeed:{findOneAndUpdate:()=>({lean:async()=>({externalId:'defaults-v1'})})},DjWorkType:{findOne:()=>({lean:async()=>({externalId:'MIX'}),session:async()=>({externalId:'MIX'})})},Version:{create:async values=>{versions.push(...values);}}};
 const {createService}=require('../src/music-ontology/service'),{ownedAsset}=require('../src/music-archive');
 const service=createService({models,ArchiveModel:{findOne:()=>({session:async()=>old})},ownedAsset});
 const input=audioUrl=>({audioUrl,workType:'MIX',atoms:[{id:'atom-1',name:'Main'}],status:'PUBLISHED',durationMinutes:1,revision:old.revision});
 for(const url of [pub.secure_url,priv.secure_url,store.resolve(priv.secure_url),pub.public_id]){
  await service.preflightRecording(input(url));
  assert.equal(await service.saveRecording(input(url),old.externalId,'test-admin'),old.externalId);
  assert.equal(old.audioUrl,url);
 }
 assert.equal(versions.length,4);
 for(const url of [image.secure_url,'https://foreign.example'+new URL(pub.secure_url).pathname,'https://media.example/khalil-media/public/'+ 'f'.repeat(64)+'.wav']){
  await assert.rejects(service.preflightRecording(input(url)),/Choose (media uploaded|an uploaded audio)/);
  await assert.rejects(service.saveRecording(input(url),old.externalId,'test-admin'),/Choose (media uploaded|an uploaded audio)/);
 }
 for(const url of ['https://res.cloudinary.com/demo/video/upload/v1/audio.mp3','/api/music-archive/media/11111111-1111-1111-1111-111111111111'])await service.preflightRecording(input(url));
});
