const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const mongoose=require('mongoose');
const {Writable}=require('node:stream');
const cloudinary=require('cloudinary').v2;
const {registerEquipment3D,equipmentModelFields}=require('../src/equipment-3d');

test('GLB upload requires admin, validates the file and creates an owner-scoped stored model',async()=>{
 const app=express();
 const requireAdmin=(req,res,next)=>{if(req.headers['x-test-admin']!=='yes')return res.status(401).json({message:'Admin authentication is required.'});req.user={externalId:'admin-one'};next();};
 registerEquipment3D(app,{requireAdmin,env:{CLOUDINARY_CLOUD_NAME:'test',CLOUDINARY_API_KEY:'test',CLOUDINARY_API_SECRET:'test'}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}/api/admin/equipment-3d`;
 const Job=mongoose.model('Equipment3DJob');const originalCreate=Job.create,originalStream=cloudinary.uploader.upload_stream;
 let stored=null,received=null;
 try{
  assert.equal((await fetch(base+'/upload',{method:'POST'})).status,401);
  const headers={'x-test-admin':'yes'};
  assert.equal((await fetch(base+'/config',{headers}).then(r=>r.json())).maxMB,25);
  assert.equal((await fetch(base+'/upload',{method:'POST',headers})).status,400);
  const bad=new FormData();bad.append('model',new Blob(['not a model']),'bad.glb');
  assert.equal((await fetch(base+'/upload',{method:'POST',headers,body:bad})).status,400);
  const json=Buffer.from('{"asset":{"version":"2.0"}} ');const glb=Buffer.alloc(20+json.length);glb.write('glTF');glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(json.length,12);glb.writeUInt32LE(0x4e4f534a,16);json.copy(glb,20);
  Job.create=async record=>{stored=record;return {...record};};
  cloudinary.uploader.upload_stream=(options,done)=>{assert.equal(options.resource_type,'raw');const chunks=[];return new Writable({write(chunk,enc,next){chunks.push(chunk);next();},final(next){received=Buffer.concat(chunks);done(null,{secure_url:'https://assets.example.com/uploaded.glb'});next();}});};
  const form=new FormData();form.append('model',new Blob([glb]),'speaker.glb');
  const response=await fetch(base+'/upload',{method:'POST',headers,body:form});const result=await response.json();
  assert.equal(response.status,201);assert.equal(result.item.modelUrl,'https://assets.example.com/uploaded.glb');assert.equal(stored.owner,'admin-one');assert.equal(stored.status,'SUCCEEDED');assert.equal(stored.mode,'upload');assert.deepEqual(received,glb);
  const find=Job.findOne;let query;
  try{Job.findOne=value=>{query=value;return {lean:async()=>stored};};assert.equal((await equipmentModelFields({user:{externalId:'admin-one'}},stored.externalId)).modelUrl,stored.modelUrl);assert.deepEqual(query,{externalId:stored.externalId,owner:'admin-one',status:'SUCCEEDED'});}finally{Job.findOne=find;}
 }finally{Job.create=originalCreate;cloudinary.uploader.upload_stream=originalStream;await new Promise(resolve=>server.close(resolve));}
});
