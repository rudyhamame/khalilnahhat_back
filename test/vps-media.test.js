const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const express=require('express'),{createStore,canonical}=require('../src/vps-media');
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
async function fixture(t,options={}){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vps-media-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const hidden=path.join(directory,'.runtime');await fs.mkdir(hidden);let now=1800000000000;const store=createStore({directory:hidden,origin:'https://media.example',secret:'a-stable-test-secret',reserveBytes:0,now:()=>now,...options});return {store,directory:hidden,advance:()=>now+=8000000};}
test('uploads deduplicate bytes but never share public and private identities; manifest survives restart',async t=>{
 const {store,directory}=await fixture(t);const [a,b]=await Promise.all([store.upload(png),store.upload(png)]);assert.equal(a.public_id,b.public_id);
 const privateFile=await store.upload(png,{type:'authenticated'});assert.notEqual(a.public_id,privateFile.public_id);assert.equal(store.load().assets[a.public_id.slice(4).split('.')[0]].bytes,png.length);
 const reloaded=createStore({directory,origin:'https://media.example',secret:'a-stable-test-secret',reserveBytes:0});assert.ok(reloaded.resolve(privateFile.secure_url).includes('signature='));assert.equal(reloaded.resolve(a.secure_url),a.secure_url);
});
test('quota admission is serialized; duplicates are reusable even when capacity is full',async t=>{
 const {store}=await fixture(t,{quotaBytes:png.length});const a=await store.upload(png);assert.equal((await store.upload(png)).public_id,a.public_id);
 await assert.rejects(store.upload(png,{type:'authenticated'}),e=>e.status===507);assert.equal(Object.keys(store.load().assets).length,1);
});
test('the disk reserve refuses writes without committing any manifest entry',async t=>{
 const {store}=await fixture(t,{reserveBytes:Number.MAX_SAFE_INTEGER});await assert.rejects(store.upload(png),e=>e.status===507);assert.equal(Object.keys(store.load().assets).length,0);
});
test('private requests require an unexpired exact-path signature; public GET, HEAD and ranges work',async t=>{
 const {store,advance}=await fixture(t);const pub=await store.upload(png),priv=await store.upload(png,{type:'authenticated'});
 const app=express();store.register(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const origin=`http://127.0.0.1:${server.address().port}`;
 const get=(url,options)=>fetch(origin+url.replace('https://media.example',''),options);
 const response=await get(pub.secure_url,{headers:{Range:'bytes=0-7'}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png.subarray(0,8));assert.equal((await get(pub.secure_url,{method:'HEAD'})).headers.get('content-length'),String(png.length));
 assert.equal((await get(priv.secure_url)).status,403);const signed=store.resolve(priv.secure_url);assert.equal((await get(signed)).status,200);
 assert.equal((await get(signed.replace(/signature=./,'signature=f0'))).status,403);advance();assert.equal((await get(signed)).status,403);
 assert.equal(store.metadata('https://evil.example'+new URL(pub.secure_url).pathname),null);assert.equal(store.metadata(pub.secure_url.replace('/public/','/private/')),null);
 assert.equal((await get('/khalil-media/public/'+ 'a'.repeat(64)+'.png')).status,404);
});
test('legacy URLs map without DB writes, with private signatures stripped only for lookup',async t=>{
 const {store}=await fixture(t);const uploaded=await store.upload(png,{type:'authenticated'}),m=store.metadata(uploaded.public_id);
 const legacy='https://res.cloudinary.com/demo/image/authenticated/v123/khalil/picture.png';store.load().aliases[canonical(legacy)]=m.id;
 const signed='https://res.cloudinary.com/demo/image/authenticated/s--abcdef--/v456/khalil/picture.png';const out=store.rewrite({nested:[{url:signed}],date:new Date('2026-11-23')},{authorizePrivate:true});assert.match(out.nested[0].url,/media\.example\/khalil-media\/private\/.+signature=/);assert.equal(out.date,'2026-11-23T00:00:00.000Z');assert.equal(store.resolve('https://res.cloudinary.com/other/image/upload/file.png'),'https://res.cloudinary.com/other/image/upload/file.png');
});
test('filesystem deletion removes all aliases and survives a repeated retry',async t=>{
 const {store}=await fixture(t);const result=await store.upload(png);const m=store.metadata(result.public_id);store.load().aliases['legacy-key']=m.id;
 assert.equal((await store.remove(result.public_id)).result,'ok');assert.equal(store.metadata(result.secure_url),null);assert.equal(store.load().aliases['legacy-key'],undefined);assert.equal((await store.remove(result.public_id)).result,'not found');
});

test('public response rewriting cannot turn a private source address into an access grant',async t=>{
 const {store}=await fixture(t);const upload=await store.upload(png,{type:'authenticated'}),m=store.metadata(upload.public_id),legacy='https://res.cloudinary.com/demo/image/authenticated/v1/private.png';store.load().aliases[canonical(legacy)]=m.id;
 assert.equal(store.rewrite({url:legacy}).url,upload.secure_url);assert.equal(store.rewrite({url:legacy}).url.includes('signature='),false);
 const signed=store.resolve(legacy);assert.equal(store.rewrite({url:signed}).url,signed);assert.match(store.rewrite({url:legacy},{authorizePrivate:true}).url,/signature=/);
});
test('a manifest commit failure after unlink remains retryable and is persisted on retry',async t=>{
 const {store,directory}=await fixture(t);const upload=await store.upload(png),rename=fs.rename;
 fs.rename=async(from,to)=>{if(to===path.join(directory,'manifest.json'))throw Error('Simulated manifest disk failure');return rename(from,to);};
 try{await assert.rejects(store.remove(upload.public_id),/manifest disk failure/);assert.ok(store.metadata(upload.public_id),'metadata stays available for retry');}finally{fs.rename=rename;}
 assert.equal((await store.remove(upload.public_id)).result,'ok');const restored=createStore({directory,origin:'https://media.example',secret:'a-stable-test-secret'});assert.equal(restored.metadata(upload.public_id),null);assert.ok(!(await fs.readdir(directory)).some(name=>name.endsWith('.tmp')));
});
