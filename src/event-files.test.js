const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {registerEventFiles,matchesType}=require('./event-files');
async function fixture(t){
  const app=express(),uploads=[];
  registerEventFiles(app,{requireAuth:(req,res)=>res.sendStatus(401),optionalAuth:(req,res,next)=>{req.authUser=req.headers.authorization==='Bearer client'?{id:'client-1'}:null;next();},uploadImpl:async(buffer,options)=>{uploads.push(options);return {secure_url:'https://res.cloudinary.com/demo/'+options.public_id};}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const send=(bytes,type,kind,auth=false)=>{const form=new FormData();form.append('kind',kind);form.append('file',new Blob([Buffer.from(bytes)],{type}),'upload');return fetch(`http://127.0.0.1:${server.address().port}/api/ai-booking/event-files`,{method:'POST',headers:auth?{Authorization:'Bearer client'}:{},body:form});};
  return {send,uploads};
}
const JPEG=[0xff,0xd8,0xff,0xe0,0,0,0,0],PDF=[0x25,0x50,0x44,0x46,0x2d,0x31];
test('visitors can upload photos and documents without an account; the file must really be what it claims',async t=>{
  const {send,uploads}=await fixture(t);
  assert.equal((await send(JPEG,'image/jpeg','photo')).status,200);
  assert.equal((await send(PDF,'application/pdf','file')).status,200);
  assert.equal((await send(Buffer.from('#!/bin/sh\nrm -rf /'),'image/jpeg','photo')).status,400); // a script renamed as a photo
  assert.equal((await send(JPEG,'image/jpeg','file')).status,400); // a photo is not a document
  assert.equal(uploads.length,2);
  assert.equal(matchesType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '),'image/webp'),true);
});
test('a visitor has a small upload allowance, signed-in clients a larger one',async t=>{
  const {send}=await fixture(t);
  let last;for(let i=0;i<11;i++)last=await send(JPEG,'image/jpeg','photo');
  assert.equal(last.status,429);
  assert.equal((await send(JPEG,'image/jpeg','photo',true)).status,200);
});
