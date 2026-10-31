// Media relay control plane. Live media is forwarded over WebRTC; no encoder runs here.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = '/data', RECORDINGS = '/recordings';
const ORIGIN = process.env.PUBLIC_ORIGIN;
const TOKEN = process.env.CONTROL_TOKEN;
if (!TOKEN || TOKEN.length < 40 || !/^https:\/\/[^/]+$/.test(ORIGIN || '')) throw new Error('Relay configuration missing');
const sessions = new Map();
const idPattern = /^khalil-obs-[a-f0-9-]{36}$/;
const segmentPattern = /^[0-9_-]+\.mp4$/;
const recordingDirectory = row => path.join(RECORDINGS, 'live', row.id);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, data) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
async function body(req) {
 let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('Request too large'); }
 return raw ? JSON.parse(raw) : {};
}
let writes = Promise.resolve();
function persist(row) {
 const next = writes.catch(()=>{}).then(async()=>{
 const file = path.join(ROOT, `${row.id}.json`);
 await fs.writeFile(`${file}.tmp`, JSON.stringify(row), {mode:0o600}); await fs.rename(`${file}.tmp`, file);
 }); writes=next; return next;
}
async function mtx(route, method='GET', data) {
 const response = await fetch(`http://127.0.0.1:19997/v3/${route}`, {method, signal:AbortSignal.timeout(10000), headers:{'Content-Type':'application/json'}, body:data === undefined ? undefined : JSON.stringify(data)});
 if (response.status === 404) return null;
 if (!response.ok) throw new Error(`Media relay API ${response.status}`);
 return response.status === 200 ? response.json() : {};
}
function view(row) {
 return {id:row.id, state:row.state, saveRecording:row.saveRecording!==false, error:row.error || '', expiresAt:row.expiresAt, endedAt:row.endedAt,
  playbackUrl:`${ORIGIN}/live/${row.id}/whep`,
  segments:Object.values(row.segments).filter(segment=>!segment.acknowledged).map(({id,duration,bytes})=>({id,duration,bytes}))};
}
async function stop(row, reason='') {
 // Revoke publishing and playback before disconnecting the sender. Keep retrying deletion on failure.
 row.state='ending'; if(reason)row.error=reason; await persist(row);
 await mtx(`config/paths/delete/live/${row.id}`, 'DELETE');
 row.state='ended'; row.endedAt=Date.now(); await persist(row);
}
async function status(row) {
 if(row.state === 'ended') {
  if(Date.now()-row.endedAt>5000) {
   let recovered=false;
   for(const name of await fs.readdir(recordingDirectory(row)).catch(()=>[])) {
    if(segmentPattern.test(name) && !row.segments[name]) { row.segments[name]={id:name,bytes:(await fs.stat(path.join(recordingDirectory(row),name))).size,duration:0};recovered=true; }
   }
   if(recovered)await persist(row);
  }
  return view(row);
 }
 if(row.state === 'ending') { await stop(row); return view(row); }
 const stream = await mtx(`paths/get/live/${row.id}`);
 if(stream?.online || stream?.ready) {
  const codecs = stream.tracks || stream.tracks2?.map(track=>track.codec) || [];
  const profile=stream.tracks2?.find(track=>track.codec==='H264')?.codecProps?.profile;
  if(!codecs.includes('H264') || codecs.some(codec=>!['H264','Opus'].includes(codec)) || (profile && !/baseline/i.test(profile))) {
   await stop(row,'Use H.264 video (no B-frames) and Opus audio in OBS. This relay does not transcode.'); return view(row);
  }
  if(row.state !== 'live') { row.state='live'; await persist(row); }
 } else if(row.state === 'live' || Date.now() > row.expiresAt) await stop(row);
 return view(row);
}
async function storageBytes() {
 let bytes=0;
 for(const row of sessions.values()) for(const entry of await fs.readdir(recordingDirectory(row),{withFileTypes:true}).catch(()=>[])) {
  if(entry.isFile())bytes+=(await fs.stat(path.join(recordingDirectory(row),entry.name))).size;
 }
 return bytes;
}
let sweeping = false;
async function sweep() {
 if(sweeping)return; sweeping=true;
 try {
  const full = await storageBytes() > 2*1024*1024*1024;
  for(const row of sessions.values()) {
   try {
    if(full && row.saveRecording!==false && !['ended','ending'].includes(row.state))await stop(row,'Recording storage is full. Save or clear recordings before another broadcast.');
    else await status(row);
   }catch { console.error('Relay status retry pending'); }
  }
 } finally { sweeping=false; }
}
async function start() {
 await fs.mkdir(ROOT,{recursive:true,mode:0o700}); await fs.mkdir(RECORDINGS,{recursive:true,mode:0o700});
 for(const name of await fs.readdir(ROOT)) {
  if(!/^khalil-obs-[a-f0-9-]{36}\.json$/.test(name))continue;
  const row=JSON.parse(await fs.readFile(path.join(ROOT,name),'utf8')); sessions.set(row.id,row);
 }
 // A restart revokes active keys. Closed files retained on disk are recovered below.
 for(const row of sessions.values()) {
  if(row.state !== 'ended')await stop(row).catch(()=>{row.state='ending';});
  const files=await fs.readdir(recordingDirectory(row)).catch(()=>[]);
  for(const name of files.filter(name=>segmentPattern.test(name))) {
   if(!row.segments[name])row.segments[name]={id:name,bytes:(await fs.stat(path.join(recordingDirectory(row),name))).size,duration:0};
  }
  await persist(row);
 }
 http.createServer(async(req,res)=>{
  try {
   const url=new URL(req.url,'http://localhost');
   if(url.pathname === '/internal/auth' && req.method === 'POST') {
    const data=await body(req); const row=sessions.get(data.path?.replace(/^live\//,''));
    const active=row && ['waiting','live'].includes(row.state);
    const query=new URLSearchParams(data.query || '');
    const valid=active && ((data.action==='read' && data.protocol==='webrtc') ||
     (data.action==='publish' && data.protocol==='webrtc' && (row.state==='live' || Date.now()<row.expiresAt) && equal(data.password || query.get('pass'),row.publishToken)));
    return json(res,valid?200:403,{});
   }
   const hook=url.pathname.match(/^\/internal\/segments\/live\/(khalil-obs-[a-f0-9-]{36})\/([0-9_-]+\.mp4)$/);
   if(hook && req.method==='POST') {
    const row=sessions.get(hook[1]); if(!row)return json(res,404,{});
    const data=await body(req); const filename=path.join(recordingDirectory(row),hook[2]);
    const bytes=(await fs.stat(filename)).size;
    if(!row.segments[hook[2]])row.segments[hook[2]]={id:hook[2],duration:Number(data.duration)||0,bytes};
    await persist(row); return json(res,200,{});
   }
   if(!url.pathname.startsWith('/control/') || !equal(req.headers.authorization,`Bearer ${TOKEN}`))return json(res,401,{});
   if(url.pathname==='/control/health' && req.method==='GET') {
    const config=await mtx('config/global/get');
    if(config.hls || config.rtmp || !config.webrtc)throw new Error('Incorrect media transport');
    return json(res,200,{ok:true,transport:'webrtc',transcoding:false,liveRemux:false});
   }
   if(url.pathname==='/control/sessions' && req.method==='POST') {
    const data=await body(req); if(!idPattern.test(data.id) || !/^[a-f0-9]{64}$/.test(data.publishToken || ''))return json(res,400,{});
    if(data.saveRecording!==undefined && typeof data.saveRecording!=='boolean')return json(res,400,{});
    const saveRecording=data.saveRecording!==false;
    if([...sessions.values()].some(row=>row.state!=='ended'))return json(res,409,{message:'Another OBS connection is active.'});
    if(sessions.has(data.id))return json(res,409,{message:'This OBS connection already exists.'});
    if(saveRecording && await storageBytes() > 1024*1024*1024)return json(res,507,{message:'Save pending recordings before preparing another OBS connection.'});
    const row={id:data.id,publishToken:data.publishToken,saveRecording,state:'waiting',expiresAt:Date.now()+120000,segments:{}};
    sessions.set(row.id,row); await persist(row);
    try {await mtx(`config/paths/add/live/${row.id}`,'POST',{source:'publisher',overridePublisher:false,record:saveRecording,recordPath:'/recordings/%path/%Y-%m-%d_%H-%M-%S-%f'});}
    catch(error){await stop(row).catch(()=>{});throw error;}
    return json(res,201,{...view(row),server:`${ORIGIN}/live/${row.id}/whip`,streamKey:`echo:${row.publishToken}`});
   }
   const match=url.pathname.match(/^\/control\/sessions\/(khalil-obs-[a-f0-9-]{36})(?:\/segments\/([0-9_-]+\.mp4))?$/);
   const row=match && sessions.get(match[1]); if(!row)return json(res,404,{});
   if(match[2]) {
    const segment=row.segments[match[2]]; if(!segment || segment.acknowledged)return json(res,404,{});
    const filename=path.join(recordingDirectory(row),segment.id);
    if(req.method==='GET') {
     const handle=await fs.open(filename,'r');res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':(await handle.stat()).size,'Cache-Control':'no-store'});
     const stream=handle.createReadStream();stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
    }
    if(req.method==='DELETE') {
     // The API acknowledges only after the archive upload is persisted.
     await fs.rm(filename,{force:true}); segment.acknowledged=true;await persist(row);return json(res,200,{acknowledged:true});
    }
   }
   if(req.method==='GET')return json(res,200,await status(row));
   if(req.method==='DELETE'){await stop(row);return json(res,200,view(row));}
   return json(res,405,{});
  }catch {if(!res.headersSent)json(res,503,{message:'OVH streaming relay is temporarily unavailable.'});else res.destroy();}
 }).listen(18991,'127.0.0.1');
 setInterval(()=>sweep().catch(()=>{}),5000).unref();
}
start().catch(()=>{console.error('Relay startup failed');process.exit(1);});
