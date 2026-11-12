const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { publicSongs, deliveryUrl } = require('./music-archive');

const CHANNELS = ['vocals', 'drums', 'bass', 'other'];
const ROOT = process.env.STEM_CACHE_DIR ? path.resolve(process.env.STEM_CACHE_DIR) : path.resolve(__dirname, '..', '.runtime', 'stems');
const PYTHON = process.env.STEM_PYTHON || (process.env.NODE_ENV === 'production' ? '/opt/stems/bin/python' : path.resolve(__dirname, '..', '.runtime', 'stem-cpu', 'bin', 'python'));
const SCRIPT = path.resolve(__dirname, '../scripts/separate-stems.py');
const automaticEnabled = () => process.env.STEM_AUTOMATIC_ENABLED === '1';
async function separatorAvailable() {
  try { await Promise.all([fs.access(PYTHON),fs.access(SCRIPT)]); return true; } catch { return false; }
}
const jobs = new Map();
let activeJob = null;
let remoteCatalog;
let remoteCatalogTime = 0;
const keyFor = url => createHash('sha256').update(`htdemucs-v1:${url}`).digest('hex');
// Uploaded admin assets are content-addressed (…/khalil/assets/<profile>/<sha256>.<ext>): the same audio keeps one cache entry even if its delivery URL differs.
const assetKey = url => {
  const hash = /\/khalil\/assets\/[^/]+\/([0-9a-f]{64})\.[a-z0-9]+$/i.exec((() => { try { return new URL(url).pathname; } catch { return ''; } })())?.[1];
  return hash ? createHash('sha256').update(`htdemucs-v1:asset:${hash.toLowerCase()}`).digest('hex') : keyFor(url);
};
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
function separate(input, directory, job) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, input, directory],
      {env:{...process.env, PYTHONUNBUFFERED:'1'}, stdio:['ignore','pipe','pipe']});
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 30*60*1000);
    let output = '', errors = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const lines = output.split('\n'); output = lines.pop();
      for (const line of lines) { try { const value=JSON.parse(line); job.stage=value.stage; if(value.duration) job.duration=value.duration; } catch { /* Python diagnostics. */ } }
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
async function readManifest(key) {
  try {
    const saved=JSON.parse(await fs.readFile(path.join(ROOT,key,'ready.json'),'utf8'));
    for (const name of CHANNELS) await fs.access(path.join(ROOT,key,`${name}.flac`));
    return saved;
  } catch { return null; }
}
async function startJob(track, key) {
  const directory=path.join(ROOT,key), input=path.join(directory,'input.audio');
  const job={status:'processing',stage:'Downloading recording'};
  jobs.set(key,job); activeJob=key;
  try {
    await fs.access(PYTHON);
    await fs.mkdir(directory,{recursive:true});
    await download(track.audioUrl,input);
    await separate(input,directory,job);
    const manifest={duration:job.duration,sourceUrl:track.audioUrl};
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
function registerStemSeparation(app,{requireAdmin}) {
  if(process.env.STEM_WORKER_URL){
    const base=new URL(process.env.STEM_WORKER_URL);
    if(base.protocol!=='https:')throw new Error('STEM_WORKER_URL must use HTTPS.');
    app.use('/api/player/stems',async(req,res)=>{
      try {
        if(!['GET','POST','HEAD'].includes(req.method))return res.sendStatus(405);
        const match=req.path.match(/^\/([^/]+)(?:\/audio\/(vocals|drums|bass|other))?$/);
        if(!match||req.method==='POST'&&match[2])return res.sendStatus(404);
        const track=await resolveTrack(decodeURIComponent(match[1]),false);
        if(!track||!validateSource(track.audioUrl))return res.status(404).json({message:'This published recording is unavailable.'});
        await relay(req,res,new URL(`/api/player/stems/${encodeURIComponent(match[1])}${match[2]?`/audio/${match[2]}`:''}`,base));
      } catch(error){console.error('Stem worker:',error.name);if(!res.headersSent)res.status(503).json({message:'Channel processing is temporarily unavailable. Original audio remains available.'});}
    });
    // Admin: split an uploaded recording (by its Cloudinary URL), before it is saved or published.
    app.use('/api/admin/stems',requireAdmin,async(req,res)=>{
      try {
        if(!['GET','POST','HEAD'].includes(req.method))return res.sendStatus(405);
        const match=req.path.match(/^\/?(?:audio\/(vocals|drums|bass|other))?$/),url=String(req.query.url||'');
        if(!match||req.method==='POST'&&match[1]||!validateSource(url))return res.status(400).json({message:'Choose a supported audio recording.'});
        const target=new URL(`/api/admin/stems${match[1]?`/audio/${match[1]}`:''}`,base);target.searchParams.set('url',url);
        await relay(req,res,target);
      } catch(error){console.error('Stem worker:',error.name);if(!res.headersSent)res.status(503).json({message:'Channel processing is temporarily unavailable. Original audio remains available.'});}
    });
    return;
  }
  const authorize = (req,res,next) => localRequest(req)||automaticEnabled() ? next() : requireAdmin(req,res,next);
  app.get('/api/player/stems/:id',async(req,res)=>{
    const track=await resolveTrack(req.params.id,localRequest(req));
    if(!track || !validateSource(track.audioUrl)) return res.status(404).json({message:'This published recording is unavailable.'});
    const key=keyFor(track.audioUrl), manifest=await readManifest(key), job=jobs.get(key);
    const ready=Boolean(manifest),available=await separatorAvailable();
    const canSeparate=available&&(localRequest(req)||automaticEnabled());
    const unavailableStage=!available?'The server audio separator is not installed.':!canSeparate?'Automatic channel preparation is not enabled on the server.':'';
    res.set('Cache-Control','no-store').json({status:ready?'ready':job?.status||(canSeparate?'idle':'unavailable'),stage:ready?'Separated channels ready':job?.stage||unavailableStage,
      duration:manifest?.duration,canSeparate,separatorAvailable:available,
      channels:ready?CHANNELS.map(name=>({name,url:`/api/player/stems/${encodeURIComponent(track.id||track.externalId||req.params.id)}/audio/${name}`})):[]});
  });
  app.post('/api/player/stems/:id',authorize,async(req,res)=>{
    const track=await resolveTrack(req.params.id,localRequest(req));
    if(!track || !validateSource(track.audioUrl)) return res.status(404).json({message:'Choose a published recording.'});
    const key=keyFor(track.audioUrl);
    if(await readManifest(key)) return res.json({status:'ready'});
    if(jobs.get(key)?.status==='processing') return res.status(202).json({status:'processing'});
    if(!await separatorAvailable()) return res.status(503).json({message:'The server audio separator is not installed.'});
    if(activeJob) return res.status(409).json({message:'Another recording is separating. This recording will retry automatically.'});
    // Reserve synchronously before starting asynchronous download/inference.
    activeJob=key;
    void startJob(track,key);
    res.status(202).json({status:'processing'});
  });
  app.get('/api/player/stems/:id/audio/:channel',async(req,res)=>{
    if(!CHANNELS.includes(req.params.channel)) return res.status(404).end();
    const track=await resolveTrack(req.params.id,localRequest(req));
    if(!track) return res.status(404).end();
    const key=keyFor(track.audioUrl);
    if(!await readManifest(key)) return res.status(404).end();
    res.set('Cache-Control','private, max-age=300').sendFile(path.join(ROOT,key,`${req.params.channel}.flac`),{dotfiles:'allow'});
  });
  // Admin: split any uploaded recording by URL (no publication needed). The worker trusts its bearer token instead of an admin session.
  const adminOnly=(req,res,next)=>process.env.STEM_WORKER_MODE==='1'?next():requireAdmin(req,res,next);
  const adminSource=(req,res)=>{const url=String(req.query.url||'');if(validateSource(url))return url;res.status(400).json({message:'Choose a supported audio recording.'});return null;};
  app.get('/api/admin/stems',adminOnly,async(req,res)=>{
    const url=adminSource(req,res);if(!url)return;
    const key=assetKey(url),manifest=await readManifest(key),job=jobs.get(key),ready=Boolean(manifest),available=await separatorAvailable();
    res.set('Cache-Control','no-store').json({status:ready?'ready':job?.status||(available?'idle':'unavailable'),stage:ready?'Separated channels ready':job?.stage||(available?'':'The server audio separator is not installed.'),
      duration:manifest?.duration,canSeparate:available,separatorAvailable:available,
      channels:ready?CHANNELS.map(name=>({name,url:`/api/admin/stems/audio/${name}?url=${encodeURIComponent(url)}`})):[]});
  });
  app.post('/api/admin/stems',adminOnly,async(req,res)=>{
    const url=adminSource(req,res);if(!url)return;
    const key=assetKey(url);
    if(await readManifest(key))return res.json({status:'ready'});
    if(jobs.get(key)?.status==='processing')return res.status(202).json({status:'processing'});
    if(!await separatorAvailable())return res.status(503).json({message:'The server audio separator is not installed.'});
    if(activeJob)return res.status(409).json({message:'Another recording is separating. Try again in a few minutes.'});
    activeJob=key;
    void startJob({audioUrl:url},key);
    res.status(202).json({status:'processing'});
  });
  app.get('/api/admin/stems/audio/:channel',adminOnly,async(req,res)=>{
    if(!CHANNELS.includes(req.params.channel))return res.status(404).end();
    const url=adminSource(req,res);if(!url)return;
    const key=assetKey(url);
    if(!await readManifest(key))return res.status(404).end();
    res.set('Cache-Control','private, max-age=300').sendFile(path.join(ROOT,key,`${req.params.channel}.flac`),{dotfiles:'allow'});
  });
  app.use('/api/admin/stems',(error,_req,res,_next)=>{console.error('Admin stem endpoint failed:',error.message);res.set('Cache-Control','no-store').status(503).json({message:'The audio separator is temporarily unavailable. Please try again.'});});
  app.use('/api/player/stems',(error,_req,res,_next)=>{
    console.error('Stem endpoint failed:',error.message);
    res.set('Cache-Control','no-store').status(503).json({message:'The audio separator is temporarily unavailable. Please try again.'});
  });
}
module.exports={registerStemSeparation,validateSource,keyFor,assetKey,CHANNELS};
