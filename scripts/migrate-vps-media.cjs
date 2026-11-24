// Download and verify a complete Cloudinary snapshot before switching delivery.
// No remote deletion or database mutation. Run with the backend's Cloudinary env.
require('dotenv').config({path:process.env.MIGRATION_ENV_FILE||'.env.production',quiet:true});
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const cloudinary=require('cloudinary').v2,{canonical}=require('../src/vps-media');
cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET,secure:true});
const target=process.argv[2];if(!target)throw Error('Pass a private destination directory');
const input=JSON.parse(fs.readFileSync('/tmp/khalil-cloudinary-inventory.json'));
const refs=JSON.parse(fs.readFileSync('/tmp/khalil-cloudinary-db-references.json')).urls;
const frontend=path.resolve('../khalil-front');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
for(const file of [...walk(frontend+'/src'),frontend+'/index.html',frontend+'/live-portrait.html'].filter(f=>!f.includes('.test.')&&/\.(jsx?|css|json|html)$/.test(f)&&fs.existsSync(f))){const text=fs.readFileSync(file,'utf8');refs.push(...text.matchAll(/https:\/\/res\.cloudinary\.com\/[^\s'"`<>)};]+/g).map(m=>m[0]));}
const plan=new Map();
for(const r of input){const key=canonical(r.secure_url);plan.set(key,{key,resourceType:r.resource_type,delivery:r.type,publicId:r.public_id,ext:r.format||path.extname(r.public_id).slice(1)||'bin',bytes:r.bytes,url:r.secure_url,original:true});}
for(const url of refs){const key=canonical(url);if(!key||plan.has(key))continue;const parts=key.split('/');if(parts[0]!==process.env.CLOUDINARY_CLOUD_NAME||!['upload','authenticated','private'].includes(parts[2]))continue;
 const original=input.find(r=>r.resource_type===parts[1]&&r.type===parts[2]&&(key.endsWith('/'+r.public_id+'.'+r.format)||key.endsWith('/'+r.public_id)));
 if(!original)continue;
 plan.set(key,{key,resourceType:original.resource_type,delivery:original.type,publicId:original.public_id,ext:path.extname(new URL(url).pathname).slice(1)||original.format||'bin',url,original:false});
}
(async()=>{
 await fsp.mkdir(path.join(target,'objects'),{recursive:true,mode:0o700});
 let manifest=fs.existsSync(path.join(target,'manifest.json'))?JSON.parse(fs.readFileSync(path.join(target,'manifest.json'))):{version:1,assets:{},aliases:{}};
 let completed=0,bytes=0;const pending=[...plan.values()];console.log(JSON.stringify({planned:pending.length,originalBytes:input.reduce((n,r)=>n+r.bytes,0)}));
 async function worker(){for(;;){const entry=pending.shift();if(!entry)return;const id=createHash('sha256').update(entry.key).digest('hex'),filename=path.join(target,'objects',id+'.'+entry.ext);
 if(manifest.assets[id]&&fs.existsSync(filename)){const data=await fsp.readFile(filename);if(createHash('sha256').update(data).digest('hex')===manifest.assets[id].sha256){completed++;bytes+=data.length;continue;}throw Error('Existing copy failed checksum');}
 let url=entry.url;if(entry.delivery!=='upload'&&entry.original)url=cloudinary.utils.private_download_url(entry.publicId,entry.resourceType==='raw'?'':entry.ext,{resource_type:entry.resourceType,type:entry.delivery,expires_at:Math.floor(Date.now()/1000)+7200,attachment:false});
 const response=await fetch(url,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error(`Download failed ${response.status}: ${entry.publicId}`);
 const hash=createHash('sha256'),part=filename+'.part';let size=0;const handle=await fsp.open(part,'w',0o600);
 try{for await(const chunk of response.body){size+=chunk.length;if(size>250*1024**2)throw Error('Migration file exceeds safety limit');hash.update(chunk);await handle.write(chunk);}await handle.sync();}finally{await handle.close();}
 if(entry.bytes&&size!==entry.bytes)throw Error('Original byte count mismatch: '+entry.publicId);
 const sha256=hash.digest('hex');await fsp.rename(part,filename);
 manifest.assets[id]={id,ext:entry.ext,bytes:size,sha256,mime:(response.headers.get('content-type')||'application/octet-stream').split(';')[0],delivery:entry.delivery,resourceType:entry.resourceType,publicId:entry.publicId,original:entry.original};manifest.aliases[entry.key]=id;
 // Originals may be requested without a version, signature, or explicit extension.
 if(entry.original){const plain=`${process.env.CLOUDINARY_CLOUD_NAME}/${entry.resourceType}/${entry.delivery}/${entry.publicId}`;manifest.aliases[plain]=id;manifest.aliases[plain+'.'+entry.ext]=id;}
 fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify(manifest),{mode:0o600});completed++;bytes+=size;if(completed%25===0)console.log(JSON.stringify({completed,bytes}));
 }}
 await Promise.all([worker(),worker(),worker()]);
 console.log(JSON.stringify({completed,bytes,assets:Object.keys(manifest.assets).length,aliases:Object.keys(manifest.aliases).length}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
