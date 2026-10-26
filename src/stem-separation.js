const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { publicSongs, deliveryUrl } = require('./music-archive');

const CHANNELS = ['vocals', 'drums', 'bass', 'other'];
const ROOT = path.resolve(__dirname, '..', '.runtime', 'stems');
const PYTHON = process.env.STEM_PYTHON || path.resolve(__dirname, '..', '.runtime', 'stem-cpu', 'bin', 'python');
const jobs = new Map();
let activeJob = null;
let remoteCatalog;
let remoteCatalogTime = 0;
const keyFor = url => createHash('sha256').update(`htdemucs-v1:${url}`).digest('hex');
const localRequest = req => process.env.NODE_ENV !== 'production' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function validateSource(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com' && /\/video\/(upload|authenticated)\//.test(parsed.pathname); }
  catch { return false; }
}
async function resolveTrack(id, local) {
  const songs = await publicSongs();
  const song = songs.find(row => row.externalId === id && row.audioUrl);
  if (song) return {id, audioUrl:deliveryUrl(song.audioUrl)};
  // Local development uses the same published library as the existing player.
  if (!local) return null;
  if (!remoteCatalog || Date.now()-remoteCatalogTime > 60000) {
    const responses = await Promise.all(['music-archive','player/playlist'].map(route =>
      fetch(`https://khalil-api.mctoshs.ca/api/${route}`, {signal:AbortSignal.timeout(15000)})));
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
    const child = spawn(PYTHON, [path.resolve(__dirname, '../scripts/separate-stems.py'), input, directory],
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
    child.on('close', code => { clearTimeout(timer); code===0 ? resolve() : reject(new Error(errors || 'Separation failed.')); });
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
    Object.assign(job,{status:'error',stage:'Separation failed. Check the local separator setup and try again.'});
  } finally { activeJob=null; }
}
function registerStemSeparation(app,{requireAdmin}) {
  const authorize = (req,res,next) => localRequest(req) ? next() : requireAdmin(req,res,next);
  app.get('/api/player/stems/:id',async(req,res)=>{
    const track=await resolveTrack(req.params.id,localRequest(req));
    if(!track || !validateSource(track.audioUrl)) return res.status(404).json({message:'This published recording is unavailable.'});
    const key=keyFor(track.audioUrl), manifest=await readManifest(key), job=jobs.get(key);
    const ready=Boolean(manifest);
    res.set('Cache-Control','no-store').json({status:ready?'ready':job?.status||'idle',stage:ready?'Separated channels ready':job?.stage||'',
      duration:manifest?.duration,canSeparate:localRequest(req),
      channels:ready?CHANNELS.map(name=>({name,url:`/api/player/stems/${encodeURIComponent(track.id||track.externalId||req.params.id)}/audio/${name}`})):[]});
  });
  app.post('/api/player/stems/:id',authorize,async(req,res)=>{
    const track=await resolveTrack(req.params.id,localRequest(req));
    if(!track || !validateSource(track.audioUrl)) return res.status(404).json({message:'Choose a published recording.'});
    const key=keyFor(track.audioUrl);
    if(await readManifest(key)) return res.json({status:'ready'});
    if(jobs.get(key)?.status==='processing') return res.status(202).json({status:'processing'});
    if(activeJob) return res.status(409).json({message:'Another recording is separating. Please try again when it finishes.'});
    try {await fs.access(PYTHON);} catch {return res.status(503).json({message:'The audio separator is not installed on this server yet.'});}
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
  app.use('/api/player/stems',(error,_req,res,_next)=>{
    console.error('Stem endpoint failed:',error.message);
    res.set('Cache-Control','no-store').status(503).json({message:'The audio separator is temporarily unavailable. Please try again.'});
  });
}
module.exports={registerStemSeparation,validateSource,keyFor,CHANNELS};
