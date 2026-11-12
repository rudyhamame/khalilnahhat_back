const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { publicSongs, deliveryUrl } = require('./music-archive');

const CHANNELS = ['vocals', 'drums', 'bass', 'other'];
// Admin editor splits with the six-source model (adds guitar and piano); the public mixer keeps four channels.
const ADMIN_CHANNELS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const adminChannelPattern = ADMIN_CHANNELS.join('|');
const ROOT = process.env.STEM_CACHE_DIR ? path.resolve(process.env.STEM_CACHE_DIR) : path.resolve(__dirname, '..', '.runtime', 'stems');
const PYTHON = process.env.STEM_PYTHON || (process.env.NODE_ENV === 'production' ? '/opt/stems/bin/python' : path.resolve(__dirname, '..', '.runtime', 'stem-cpu', 'bin', 'python'));
const SCRIPT = path.resolve(__dirname, '../scripts/separate-stems.py');
async function separatorAvailable() {
  try { await Promise.all([fs.access(PYTHON),fs.access(SCRIPT)]); return true; } catch { return false; }
}
const jobs = new Map();
let activeJob = null;
let remoteCatalog;
let remoteCatalogTime = 0;
const keyFor = url => createHash('sha256').update(`htdemucs-v1:${url}`).digest('hex');
// Uploaded admin assets are content-addressed (…/khalil/assets/<profile>/<sha256>.<ext>): the same audio keeps one cache entry even if its delivery URL differs.
const assetHash = url => /\/khalil\/assets\/[^/]+\/([0-9a-f]{64})\.[a-z0-9]+$/i.exec((() => { try { return new URL(url).pathname; } catch { return ''; } })())?.[1]?.toLowerCase();
const legacyAssetKey = url => { const hash = assetHash(url); return hash ? createHash('sha256').update(`htdemucs-v1:asset:${hash}`).digest('hex') : keyFor(url); };
const assetKey = url => { const hash = assetHash(url); return createHash('sha256').update(hash ? `htdemucs_6s-v1:asset:${hash}` : `htdemucs_6s-v1:${url}`).digest('hex'); };
const localRequest = req => process.env.NODE_ENV !== 'production' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function validateSource(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com' && /\/video\/(upload|authenticated)\//.test(parsed.pathname); }
  catch { return false; }
}
async function resolveTrack(id, local) {
  const songs = process.env.STEM_WORKER_MODE==='1' ? [] : await publicSongs();
  const song = songs.find(row => row.externalId === id && row.audioUrl);
  if (song) return {id, audioUrl:deliveryUrl(song.audioUrl)};
  // Local development uses the same published library as the existing player.
  if (!local && process.env.STEM_WORKER_MODE!=='1') return null;
  if (!remoteCatalog || Date.now()-remoteCatalogTime > 60000) {
    const responses = await Promise.all(['music-archive','player/playlist'].map(route =>
      fetch(`https://api.djkhalilnahhat.ca/api/${route}`, {signal:AbortSignal.timeout(15000)})));
    if (!responses.some(response=>response.ok)) throw new Error('The published music library is unavailable.');
    const catalogs=await Promise.all(responses.map(response=>response.ok?response.json():{}));
    remoteCatalog=[...(catalogs[0].songs||[]),...(catalogs[1].enabled===false?[]:catalogs[1].items||[])];
    remoteCatalogTime = Date.now();
  }
  return remoteCatalog.find(row => row.id === id && row.audioUrl) || null;
}
async function download(url, destination) {
  if (!validateSource(url)) throw new Error('This recording source is not supported.');
  const response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error('Could not download the recording.');
  const file = await fs.open(destination, 'w');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 100*1024*1024) throw new Error('Choose a recording under 100 MB.');
      await file.writeFile(chunk);
    }
  } finally { await file.close(); }
}
function separate(input, directory, job, model = 'htdemucs') {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, input, directory, '--model', model],
      {env:{...process.env, PYTHONUNBUFFERED:'1'}, stdio:['ignore','pipe','pipe']});
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 30*60*1000);
    let output = '', errors = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const lines = output.split('\n'); output = lines.pop();
      for (const line of lines) { try { const value=JSON.parse(line); job.stage=value.stage; if(value.duration) job.duration=value.duration; if(Array.isArray(value.channels)) job.channels=value.channels; } catch { /* Python diagnostics. */ } }
    });
    child.stderr.on('data', chunk => {
      errors=(errors+chunk).slice(-4000);
      const progress=[...String(chunk).matchAll(/(\d+)%/g)].at(-1);
      if(progress) job.stage=`Separating channels (${progress[1]}%)`;
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code,signal) => { clearTimeout(timer); code===0 ? resolve() : reject(new Error(`Separator exited (${signal||code}): ${errors || 'No process diagnostics.'}`)); });
  });
}
// Saved channels live under the recording's content key (admin editor) or the older URL key; the player only ever reads them.
async function savedKey(url) {
  for (const key of [assetKey(url), legacyAssetKey(url), keyFor(url)]) if (await readManifest(key)) return key;
  return keyFor(url);
}
async function readManifest(key, channels = CHANNELS) {
  try {
    const saved=JSON.parse(await fs.readFile(path.join(ROOT,key,'ready.json'),'utf8'));
    // Admin results list the channels the model actually produced (4 when the six-source weights were unavailable).
    const list = channels === ADMIN_CHANNELS ? ADMIN_CHANNELS.filter(name => (saved.channels || CHANNELS).includes(name)) : channels;
    for (const name of list) await fs.access(path.join(ROOT,key,`${name}.flac`));
    return {...saved, channels:list};
  } catch { return null; }
}
// The four-channel mixer must still hear everything: fold guitar and piano into one "other" mix beside the pure stems.
function mixOther(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin','-y','-v','error','-i',path.join(directory,'other.flac'),'-i',path.join(directory,'guitar.flac'),'-i',path.join(directory,'piano.flac'),
      '-filter_complex','amix=inputs=3:normalize=0','-c:a','flac',path.join(directory,'other-mix.flac')],{stdio:['ignore','ignore','pipe']});
    let errors=''; child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(new Error(`ffmpeg exited (${code}): ${errors}`)));
  });
}
// Admin lookups prefer the six-source result and fall back to an older four-channel result of the same audio.
async function adminKey(url) {
  const key = assetKey(url);
  if (await readManifest(key, ADMIN_CHANNELS)) return key;
  const legacy = legacyAssetKey(url);
  return await readManifest(legacy, ADMIN_CHANNELS) ? legacy : key;
}
async function startJob(track, key, model = 'htdemucs') {
  const directory=path.join(ROOT,key), input=path.join(directory,'input.audio');
  const job={status:'processing',stage:'Downloading recording'};
  jobs.set(key,job); activeJob=key;
  try {
    await fs.access(PYTHON);
    await fs.mkdir(directory,{recursive:true});
    await download(track.audioUrl,input);
    await separate(input,directory,job,model);
    if(job.channels?.includes('guitar')&&job.channels.includes('piano')) await mixOther(directory);
    const manifest={duration:job.duration,sourceUrl:track.audioUrl,...(job.channels?{channels:job.channels}:{})};
    await fs.writeFile(path.join(directory,'ready.json'),JSON.stringify(manifest));
    Object.assign(job,{status:'ready',stage:'Ready'});
    await fs.unlink(input).catch(()=>{});
  } catch(error) {
    console.error('Stem separation failed:',error.message);
    Object.assign(job,{status:'error',stage:'Channel preparation failed. Original audio remains available.'});
  } finally { activeJob=null; }
}
// Forward a request to the stem worker and stream its answer back.
async function relay(req,res,target){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  let response;
  try {response=await fetch(target,{method:req.method,headers:{'User-Agent':'khalil-api-worker/1.0',Authorization:`Bearer ${process.env.STEM_WORKER_TOKEN||''}`,...(req.headers.range?{Range:req.headers.range}:{})},signal:controller.signal,redirect:'error'});} finally {clearTimeout(timer);}
  res.status(response.status);
  for(const name of ['content-type','content-length','content-range','accept-ranges','cache-control'])if(response.headers.has(name))res.set(name,response.headers.get(name));
  if(!response.body||req.method==='HEAD')return res.end();
  const stream=require('node:stream').Readable.fromWeb(response.body);res.on('close',()=>{controller.abort();stream.destroy();});stream.on('error',()=>res.destroy());stream.pipe(res);
}
// The public mixer reads the channels saved with the recording (its own storage); it never touches the separator.
async function savedPlayerStatus(id) {
  const song = (await publicSongs()).find(row => row.externalId === id && row.audioUrl);
  if (!song) return null;
  const channels = (song.stems?.channels || []).filter(channel => channel?.url && ADMIN_CHANNELS.includes(channel.name));
  const ready = CHANNELS.every(name => channels.some(channel => channel.name === name));
  return {status:ready?'ready':'unavailable',stage:ready?'Separated channels ready':'Channels are prepared when the recording is saved in the admin editor.',duration:song.stems?.duration??undefined,canSeparate:false,separatorAvailable:false,
    channels:ready?channels.map(channel=>({name:channel.name,url:deliveryUrl(channel.url)})):[]};
}
function registerStemSeparation(app,{requireAdmin}) {
  // Nothing here is permanent: an unsaved split is dropped after a day (saved ones live with their recording).
  if(process.env.STEM_WORKER_MODE==='1'||!process.env.STEM_WORKER_URL){
    const sweepCache=async()=>{try{for(const entry of await fs.readdir(ROOT,{withFileTypes:true})){if(!entry.isDirectory()||!/^[0-9a-f]{64}$/.test(entry.name)||[...jobs.keys()].includes(entry.name))continue;const stat=await fs.stat(path.join(ROOT,entry.name));if(Date.now()-stat.mtimeMs>24*3600*1000)await fs.rm(path.join(ROOT,entry.name),{recursive:true,force:true});}}catch{/* no cache yet */}};
    setInterval(sweepCache,3600*1000).unref();sweepCache();
  }
  if(process.env.STEM_WORKER_URL){
    const base=new URL(process.env.STEM_WORKER_URL);
    if(base.protocol!=='https:')throw new Error('STEM_WORKER_URL must use HTTPS.');
    app.use('/api/player/stems',async(req,res)=>{
      if(req.method==='POST')return res.status(410).json({message:'Channels are prepared when the recording is saved in the admin editor.'});
      if(!['GET','HEAD'].includes(req.method))return res.sendStatus(405);
      const match=req.path.match(/^\/([^/]+)$/);
      if(!match)return res.sendStatus(404);
      try{const value=await savedPlayerStatus(decodeURIComponent(match[1]));if(!value)return res.status(404).json({message:'This published recording is unavailable.'});res.set('Cache-Control','no-store').json(value);}
      catch(error){console.error('Player stems:',error.name);res.status(503).json({message:'Channels are temporarily unavailable. Original audio remains available.'});}
    });
    // Admin: split an uploaded recording (by its Cloudinary URL), before it is saved or published.
    app.use('/api/admin/stems',requireAdmin,async(req,res)=>{
      try {
        if(!['GET','POST','HEAD','DELETE'].includes(req.method))return res.sendStatus(405);
        const match=req.path.match(new RegExp(`^/?(?:audio/(${adminChannelPattern}))?$`)),url=deliveryUrl(String(req.query.url||'')); // uploads are private (authenticated) Cloudinary assets: the worker needs the signed link
        if(!match||(req.method==='POST'||req.method==='DELETE')&&match[1]||!validateSource(url))return res.status(400).json({message:'Choose a supported audio recording.'});
        const target=new URL(`/api/admin/stems${match[1]?`/audio/${match[1]}`:''}`,base);target.searchParams.set('url',url);
        await relay(req,res,target);
      } catch(error){console.error('Stem worker:',error.name);if(!res.headersSent)res.status(503).json({message:'Channel processing is temporarily unavailable. Original audio remains available.'});}
    });
    return;
  }
  // The player never splits audio. Channels are produced once, in the admin editor, and saved with the recording.
  const PLAYER_NOTE='Channels are prepared when the recording is saved in the admin editor.';
  app.get('/api/player/stems/:id',async(req,res)=>{
    const value=await savedPlayerStatus(req.params.id);
    if(!value)return res.status(404).json({message:'This published recording is unavailable.'});
    res.set('Cache-Control','no-store').json(value);
  });
  app.post('/api/player/stems/:id',(_req,res)=>res.status(410).json({message:PLAYER_NOTE}));
  app.get('/api/player/stems/:id/audio/:channel',async(req,res)=>{
    if(!CHANNELS.includes(req.params.channel)) return res.status(404).end();
    const track=await resolveTrack(req.params.id,localRequest(req));
    if(!track) return res.status(404).end();
    const key=await savedKey(track.audioUrl);
    if(!await readManifest(key)) return res.status(404).end();
    // Results from the six-source model fold guitar and piano into the mixer's "other" channel.
    const mixed=req.params.channel==='other'&&await fs.access(path.join(ROOT,key,'other-mix.flac')).then(()=>true,()=>false);
    res.set('Cache-Control','private, max-age=300').sendFile(path.join(ROOT,key,mixed?'other-mix.flac':`${req.params.channel}.flac`),{dotfiles:'allow'});
  });
  // Admin: split any uploaded recording by URL (no publication needed). The worker trusts its bearer token instead of an admin session.
  const adminOnly=(req,res,next)=>process.env.STEM_WORKER_MODE==='1'?next():requireAdmin(req,res,next);
  const adminSource=(req,res)=>{const url=String(req.query.url||'');if(validateSource(url))return url;res.status(400).json({message:'Choose a supported audio recording.'});return null;};
  app.delete('/api/admin/stems',adminOnly,async(req,res)=>{
    const url=adminSource(req,res);if(!url)return;
    if([assetKey(url),legacyAssetKey(url),keyFor(url)].some(key=>jobs.get(key)?.status==='processing'))return res.status(409).json({message:'This recording is still separating.'});
    for(const key of new Set([assetKey(url),legacyAssetKey(url),keyFor(url)]))await fs.rm(path.join(ROOT,key),{recursive:true,force:true});
    res.sendStatus(204);
  });
  app.get('/api/admin/stems',adminOnly,async(req,res)=>{
    const url=adminSource(req,res);if(!url)return;
    const key=await adminKey(url),manifest=await readManifest(key,ADMIN_CHANNELS),job=jobs.get(key),ready=Boolean(manifest),available=await separatorAvailable();
    res.set('Cache-Control','no-store').json({status:ready?'ready':job?.status||(available?'idle':'unavailable'),stage:ready?'Separated channels ready':job?.stage||(available?'':'The server audio separator is not installed.'),
      duration:manifest?.duration,canSeparate:available,separatorAvailable:available,
      partial:ready&&manifest.channels.length<ADMIN_CHANNELS.length,channels:ready?manifest.channels.map(name=>({name,url:`/api/admin/stems/audio/${name}?url=${encodeURIComponent(url)}`})):[]});
  });
  app.post('/api/admin/stems',adminOnly,async(req,res)=>{
    const url=adminSource(req,res);if(!url)return;
    const key=assetKey(url);
    const done=await readManifest(await adminKey(url),ADMIN_CHANNELS);
    // A four-channel fallback result may be re-run once the six-source model is available (?upgrade=1).
    if(done&&!(req.query.upgrade==='1'&&done.channels.length<ADMIN_CHANNELS.length))return res.json({status:'ready'});
    if(done)await fs.rm(path.join(ROOT,key,'ready.json'),{force:true});
    if(jobs.get(key)?.status==='processing')return res.status(202).json({status:'processing'});
    if(!await separatorAvailable())return res.status(503).json({message:'The server audio separator is not installed.'});
    if(activeJob)return res.status(409).json({message:'Another recording is separating. Try again in a few minutes.'});
    activeJob=key;
    void startJob({audioUrl:url},key,'htdemucs_6s');
    res.status(202).json({status:'processing'});
  });
  app.get('/api/admin/stems/audio/:channel',adminOnly,async(req,res)=>{
    if(!ADMIN_CHANNELS.includes(req.params.channel))return res.status(404).end();
    const url=adminSource(req,res);if(!url)return;
    const key=await adminKey(url);
    const ready=await readManifest(key,ADMIN_CHANNELS);
    if(!ready||!ready.channels.includes(req.params.channel))return res.status(404).end();
    res.set('Cache-Control','private, max-age=300').sendFile(path.join(ROOT,key,`${req.params.channel}.flac`),{dotfiles:'allow'});
  });
  app.use('/api/admin/stems',(error,_req,res,_next)=>{console.error('Admin stem endpoint failed:',error.message);res.set('Cache-Control','no-store').status(503).json({message:'The audio separator is temporarily unavailable. Please try again.'});});
  app.use('/api/player/stems',(error,_req,res,_next)=>{
    console.error('Stem endpoint failed:',error.message);
    res.set('Cache-Control','no-store').status(503).json({message:'The audio separator is temporarily unavailable. Please try again.'});
  });
}
module.exports={registerStemSeparation,validateSource,keyFor,assetKey,legacyAssetKey,CHANNELS,ADMIN_CHANNELS};
