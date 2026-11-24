// Single-instance, disk-backed media storage. The manifest also maps legacy URLs
// without rewriting database records, so provider rollback keeps its originals.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {createHash,createHmac,timingSafeEqual,randomUUID}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const PREFIX='/khalil-media/';
const enabled=()=>process.env.MEDIA_STORAGE_PROVIDER==='vps';
function canonical(value){
 try{
  const u=new URL(value);
  if(u.hostname==='api.cloudinary.com'&&u.pathname.endsWith('/download')){
   const p=u.pathname.split('/');return `${p[2]}/${p[3]}/${u.searchParams.get('type')||'authenticated'}/${u.searchParams.get('public_id')}${u.searchParams.get('format')?'.'+u.searchParams.get('format'):''}`;
  }
  if(u.hostname!=='res.cloudinary.com')return null;
  return decodeURIComponent(u.pathname.slice(1)).split('/').filter(p=>!/^s--[\w-]+--$/.test(p)&&!/^v\d+$/.test(p)).join('/');
 }catch{return null;}
}
const suffix=m=>`${m.id}.${m.ext}`;
function createStore({directory,origin,secret,quotaBytes=5*1024**3,reserveBytes=3*1024**3,now=Date.now}={}){
 directory=path.resolve(directory||process.env.MEDIA_STORAGE_DIR||'/app/.runtime/media-store');
 origin=(origin||process.env.MEDIA_PUBLIC_ORIGIN||'').replace(/\/$/,'');
 secret=secret||process.env.MEDIA_SIGNING_KEY;
 const manifestPath=path.join(directory,'manifest.json'),objects=path.join(directory,'objects');
 let manifest,queue=Promise.resolve();
 function load(){
  if(!manifest){manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):{version:1,assets:{},aliases:{}};
   if(manifest.version!==1)throw Error('Unsupported media manifest');
  }return manifest;
 }
 function metadata(value){
  if(typeof value!=='string')return null;
  const m=load();
  if(value.startsWith('vps/'))return m.assets[value.slice(4).split('.')[0]]||null;
  if(!value.startsWith(origin+PREFIX)&&!value.startsWith('https://res.cloudinary.com/')&&!value.startsWith('https://api.cloudinary.com/'))return null;
  const key=canonical(value);
  if(key&&m.aliases[key])return m.assets[m.aliases[key]];
  try{const u=new URL(value);if(u.origin!==origin||!u.pathname.startsWith(PREFIX))return null;const match=u.pathname.match(/^\/khalil-media\/(public|private)\/([a-f0-9]{64})\.([a-z0-9]{1,12})$/);const a=match&&m.assets[match[2]];return a&&a.ext===match[3]&&(a.delivery==='upload'?'public':'private')===match[1]?a:null;}catch{return null;}
 }
 function location(m){return `${origin}${PREFIX}${m.delivery==='upload'?'public':'private'}/${suffix(m)}`;}
 const sign=(p,e)=>{if(!secret)throw Error('Media signing key is not configured');return createHmac('sha256',secret).update(`${p}:${e}`).digest('hex');};
 function urlFor(m,{attachment=false,ttl=7200}={}){
  const url=location(m);if(m.delivery==='upload')return url;
  const expires=Math.floor(now()/1000)+ttl;return `${url}?expires=${expires}&signature=${sign(new URL(url).pathname,expires)}${attachment?'&download=1':''}`;
 }
 function resolve(value){const m=metadata(value);return m?urlFor(m):value;}
 function rewrite(value,{authorizePrivate=false}={}){return JSON.parse(JSON.stringify(value,(_key,item)=>{
  if(typeof item!=='string')return item;const m=metadata(item);if(!m)return item;
  if(m.delivery==='upload')return location(m);
  if(authorizePrivate)return urlFor(m);
  // Only explicit authorized serializers may mint a private link. Merely placing
  // a private source URL in a public response must never grant access to it.
  try{const u=new URL(item);if(u.origin===origin&&u.searchParams.has('signature'))return item;}catch{}
  return location(m);
 }));}
 async function syncDirectory(name){const handle=await fsp.open(name,'r');try{await handle.sync();}finally{await handle.close();}}
 async function persist(){
  const temp=manifestPath+'.'+randomUUID()+'.tmp';let handle;
  try{handle=await fsp.open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(load()));await handle.sync();await handle.close();handle=null;await fsp.rename(temp,manifestPath);await syncDirectory(directory);}
  finally{if(handle)await handle.close().catch(()=>{});await fsp.unlink(temp).catch(()=>{});}
 }
 async function upload(input,options={}){
  // Serialize admission and commits: this storage directory belongs to one API instance.
  const task=queue.then(async()=>{
   if(!origin||!secret)throw Object.assign(Error('Media storage is not configured'),{status:503});
   await fsp.mkdir(objects,{recursive:true,mode:0o700});
   const data=Buffer.isBuffer(input)?input:await fsp.readFile(input);
   if(!data.length||data.length>200*1024**2)throw Object.assign(Error('Choose a file under 200 MB.'),{status:413});
   const type=options.resource_type||'image',delivery=options.type||'upload',hash=createHash('sha256').update(data).digest('hex');
   const id=createHash('sha256').update(`${type}:${delivery}:${hash}`).digest('hex');
   let m=load().assets[id];
   if(!m){
    const usage=Object.values(load().assets).reduce((sum,a)=>sum+a.bytes,0),disk=await fsp.statfs(directory);
    if(usage+data.length>quotaBytes||disk.bavail*disk.bsize-data.length<reserveBytes)throw Object.assign(Error('Media storage is full. Remove unused files or contact the administrator.'),{status:507});
    const info=await identify(data,options);
    m={id,ext:info.ext,mime:info.mime,bytes:data.length,sha256:hash,resourceType:type,delivery,publicId:`vps/${id}.${info.ext}`,duration:info.duration||0};
    await (async()=>{const file=await fsp.open(path.join(objects,suffix(m)),'wx',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}await syncDirectory(objects);})().catch(async e=>{if(e.code!=='EEXIST')throw e;const old=await fsp.readFile(path.join(objects,suffix(m)));if(createHash('sha256').update(old).digest('hex')!==hash)throw Error('Stored media checksum mismatch');});
    load().assets[id]=m;try{await persist();}catch(e){delete load().assets[id];throw e;}
   }
   return {secure_url:location(m),url:location(m),public_id:m.publicId,resource_type:m.resourceType,type:m.delivery,bytes:m.bytes,format:m.ext,duration:m.duration};
  });queue=task.catch(()=>{});return task;
 }
 async function identify(data,options){
  const head=data.subarray(0,1000),text=head.toString('utf8').trim();
  if(head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {ext:'png',mime:'image/png'};
  if(head[0]===255&&head[1]===216&&head[2]===255)return {ext:'jpg',mime:'image/jpeg'};
  if(/^GIF8[79]a/.test(head.toString('ascii')))return {ext:'gif',mime:'image/gif'};
  if(head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP')return {ext:'webp',mime:'image/webp'};
  if(/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text))return {ext:'svg',mime:'image/svg+xml'};
  if(head.toString('ascii',0,2)==='BM')return {ext:'bmp',mime:'image/bmp'};
  if(head.toString('hex',0,4)==='49492a00'||head.toString('hex',0,4)==='4d4d002a')return {ext:'tiff',mime:'image/tiff'};
  if(head.toString('ascii',4,8)==='ftyp'&&/avif|avis/.test(head.toString('ascii',8,32)))return {ext:'avif',mime:'image/avif'};
  if(head.toString('ascii',4,8)==='ftyp'&&/heic|heix|mif1/.test(head.toString('ascii',8,32)))return {ext:'heic',mime:'image/heic'};
  if(head.toString('ascii',0,4)==='glTF')return {ext:'glb',mime:'model/gltf-binary'};
  if(head.toString('ascii',0,5)==='%PDF-')return {ext:'pdf',mime:'application/pdf'};
  if(options.resource_type==='video'){
   const temp=path.join(directory,randomUUID()+'.probe');await fsp.writeFile(temp,data,{mode:0o600});
   try{
    const result=await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_format','-show_streams','-of','json',temp],{timeout:20000,maxBuffer:1024*1024});
    const probe=JSON.parse(result.stdout),format=probe.format?.format_name||'',video=probe.streams?.some(s=>s.codec_type==='video'&&!s.disposition?.attached_pic);
    const ext=/wav/.test(format)?'wav':/mp3/.test(format)?'mp3':/flac/.test(format)?'flac':/ogg/.test(format)?'ogg':/webm|matroska/.test(format)?'webm':/aac/.test(format)?'aac':/mov|mp4/.test(format)?(video?'mp4':'m4a'):null;
    if(!ext)throw Error('Unsupported media format');
    return {ext,mime:video?`video/${ext==='webm'?'webm':'mp4'}`:({mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',flac:'audio/flac',ogg:'audio/ogg',webm:'audio/webm',aac:'audio/aac'})[ext],duration:Number(probe.format?.duration)||0};
   }finally{await fsp.unlink(temp).catch(()=>{});}
  }
  const ext=/\.([a-z0-9]{1,12})$/i.exec(options.public_id||'')?.[1]?.toLowerCase();
  if(options.resource_type==='raw'&&ext)return {ext,mime:({'txt':'text/plain',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',woff2:'font/woff2',woff:'font/woff'})[ext]||'application/octet-stream'};
  throw Object.assign(Error('This media format is not supported by local storage.'),{status:400});
 }
 async function remove(publicId){
  const task=queue.then(async()=>{const m=metadata(publicId);if(!m)return {result:'not found'};if(m.pinned)throw Error('Site assets are owned by the deployed frontend');
   await fsp.unlink(path.join(objects,suffix(m))).catch(e=>{if(e.code!=='ENOENT')throw e;});await syncDirectory(objects);
   const aliases=Object.entries(load().aliases).filter(([,id])=>id===m.id);delete load().assets[m.id];for(const [alias]of aliases)delete load().aliases[alias];
   try{await persist();}catch(error){load().assets[m.id]=m;for(const [alias,id]of aliases)load().aliases[alias]=id;throw error;}
   return {result:'ok'};
  });queue=task.catch(()=>{});return task;
 }
 function register(app){
  load();if(!origin||!secret)throw Error('Media storage configuration is incomplete');
  app.get(`${PREFIX}:policy/:file`,async(req,res,next)=>{
   const value=origin+req.path,m=metadata(value);if(!m)return res.sendStatus(404);
   if(m.delivery!=='upload'){
    const e=Number(req.query.expires),signature=req.query.signature;
    if(!Number.isInteger(e)||e<now()/1000||e>now()/1000+86400||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(sign(req.path,e))))return res.sendStatus(403);
   }
   res.set({'Content-Type':m.mime||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':m.delivery==='upload'?'public, max-age=31536000, immutable':'private, no-store','Cross-Origin-Resource-Policy':'cross-origin','Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'"});
   if(req.query.download==='1')res.attachment(suffix(m));
   res.sendFile(path.join(objects,suffix(m)),{acceptRanges:true,cacheControl:false,lastModified:true,dotfiles:'allow'},error=>{if(error&&!res.headersSent)next(error);});
  });
  app.use((req,res,next)=>{const json=res.json.bind(res);res.json=body=>json(rewrite(body,{authorizePrivate:Boolean(req.user?.isAdmin)}));next();});
 }
 return {load,metadata,location,urlFor,resolve,rewrite,upload,remove,register};
}
let instance;const store=()=>instance||(instance=createStore({quotaBytes:Number(process.env.MEDIA_QUOTA_BYTES)||5*1024**3,reserveBytes:Number(process.env.MEDIA_RESERVE_BYTES)||3*1024**3}));
module.exports={enabled,canonical,createStore,store,resolve:value=>enabled()?store().resolve(value):value,isOwned:value=>enabled()&&Boolean(store().metadata(value)),isAudio:value=>enabled()&&store().metadata(value)?.resourceType==='video'};
