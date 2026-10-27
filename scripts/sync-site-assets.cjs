/* Upload public website media to Cloudinary. Credentials stay in the environment.
 * node scripts/sync-site-assets.cjs FRONTEND_ROOT [GENERATED_MODEL_DIRECTORY]
 * Generated media is registered under /echo/models/ using its filename.
 * Intermediate -unjoined, -blender and -welded GLBs are excluded.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cloudinary=require('cloudinary').v2;
const root=path.resolve(process.argv[2]||path.join(__dirname,'../../khalil-front'));
const generated=process.argv[3]&&path.resolve(process.argv[3]);
const manifestPath=path.join(root,'design/cloudinary-assets-manifest.json');
const manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):{};
const before=structuredClone(manifest);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const media=/\.(webp|png|jpe?g|svg|wav|mp3|mp4|glb|gltf|blend|woff2?)$/i;
const files=[...walk(root+'/public').filter(f=>media.test(f)).map(file=>({file,key:file.slice((root+'/public').length)})),...walk(root+'/src/assets').filter(f=>media.test(f)).map(file=>({file,key:'/src-assets'+file.slice((root+'/src/assets').length)}))];
if(generated){
 for(const file of walk(generated).filter(file=>media.test(file)&&!/(?:-unjoined|-blender|-welded)\.glb$/i.test(file))){
  files.push({file,key:'/echo/models/'+path.basename(file)});
 }
}
(async()=>{
 if(!process.env.CLOUDINARY_URL&&!(process.env.CLOUDINARY_CLOUD_NAME&&process.env.CLOUDINARY_API_KEY&&process.env.CLOUDINARY_API_SECRET))throw Error('Set CLOUDINARY_URL or the three CLOUDINARY_* credential variables.');
 cloudinary.config(process.env.CLOUDINARY_URL?process.env.CLOUDINARY_URL:{cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET,secure:true});
 for(let {file,key} of files){
  if(key==='/echo/models/echo-assistant-v1.glb'&&fs.statSync(file).size>10*1024*1024){
   const optimized=generated&&path.join(generated,'echo-assistant-cloudinary.glb');
   if(optimized&&fs.existsSync(optimized))file=optimized;
   else if(manifest[key]){console.log('Retaining registered optimized avatar');continue;}
   else throw Error('Supply a size-optimized avatar GLB in GENERATED_MODEL_DIRECTORY.');
  }
  const sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(manifest[key]?.sha256===sha256)continue;
  const resource_type=key==='/icons.svg'||/\.(glb|gltf|blend|woff2?)$/i.test(file)?'raw':/\.(wav|mp3|mp4)$/i.test(file)?'video':'image';
  const public_id='khalil/site-assets/'+sha256.slice(0,12)+key.replace(resource_type==='raw'?/$^/:/\.[^.]+$/,'');
  const result=await cloudinary.uploader.upload(file,{resource_type,public_id,overwrite:false,unique_filename:false});
  manifest[key]={url:result.secure_url,publicId:result.public_id,resourceType:result.resource_type,bytes:result.bytes,sha256};
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  console.log('Uploaded',key);
 }
 // Refresh existing static URL references when an asset changes; dynamic callers use cloudAsset().
 for(const file of [root+'/index.html',...walk(root+'/src').filter(f=>/\.(js|jsx|css)$/.test(f)&&!f.includes('.test.'))]){
  let text=fs.readFileSync(file,'utf8'),next=text;
  for(const [key,old] of Object.entries(before))if(manifest[key]?.url!==old.url)next=next.replaceAll(old.url,manifest[key].url);
  if(next!==text)fs.writeFileSync(file,next);
 }
 fs.writeFileSync(root+'/src/data/cloudinaryAssets.json',JSON.stringify(Object.fromEntries(Object.entries(manifest).map(([key,value])=>[key,value.url])),null,2)+'\n');
 console.log('Cloudinary assets registered:',Object.keys(manifest).length);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
