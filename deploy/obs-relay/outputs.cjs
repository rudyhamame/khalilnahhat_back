// Social outputs: one ffmpeg per platform reads the live OBS path over loopback RTSP and pushes RTMPS.
const {spawn}=require('node:child_process');
const platforms=['youtube','instagram','tiktok'];
const idPattern=/^khalil-obs-[a-f0-9-]{36}$/;
// YouTube: landscape, video copied (OBS already sends H.264), audio Opus -> AAC.
// Instagram/TikTok: centre-cropped 9:16 720x1280 re-encode. ponytail: fixed centre crop, add a pan value when needed.
function buildArgs(id,platform,url) {
 if(!idPattern.test(id)||!platforms.includes(platform))throw new Error('Invalid output');
 const input=['-hide_banner','-loglevel','error','-rtsp_transport','tcp','-i',`rtsp://127.0.0.1:8554/live/${id}`];
 const audio=['-c:a','aac','-b:a','128k','-ar','48000'];
 const video=platform==='youtube'?['-c:v','copy']:['-vf','crop=trunc(ih*9/32)*2:ih,scale=720:1280','-r','30','-c:v','libx264','-preset','veryfast','-profile:v','baseline','-g','60','-b:v','2500k','-maxrate','2500k','-bufsize','5000k'];
 return [...input,...video,...audio,'-f','flv',url];
}
function createOutputs({spawnProcess=spawn}={}) {
 const running=new Map(); // `${id}/${platform}` -> {state,child}
 const key=(id,platform)=>`${id}/${platform}`;
 return {
  start(id,platform,url) {
   const k=key(id,platform);if(running.get(k)?.child)throw Object.assign(new Error('already running'),{status:409});
   // Never log argv or stderr: they contain the stream key.
   const child=spawnProcess('ffmpeg',buildArgs(id,platform,url),{stdio:['ignore','ignore','ignore']});
   const entry={state:'starting',child};running.set(k,entry);
   const timer=setTimeout(()=>{if(entry.state==='starting')entry.state='running';},4000);
   child.on('error',()=>{clearTimeout(timer);entry.state='failed';entry.child=null;});
   child.on('exit',code=>{clearTimeout(timer);if(entry.state!=='stopped')entry.state=code===0?'ended':'failed';entry.child=null;});
  },
  stop(id,platform) {const entry=running.get(key(id,platform));if(!entry)return;entry.state='stopped';entry.child?.kill('SIGTERM');},
  stopAll(id) {for(const k of running.keys())if(k.startsWith(id+'/'))this.stop(id,k.split('/')[1]);},
  states(id) {const out={};for(const [k,entry] of running)if(k.startsWith(id+'/'))out[k.split('/')[1]]=entry.state;return out;},
 };
}
module.exports={buildArgs,createOutputs,platforms};
