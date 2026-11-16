// Free reframing: crops a clip to a goal's shape (9:16 or 16:9) with ffmpeg, following a face path measured in the editor (no paid AI).
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises');
const path=require('node:path');
const exec=promisify(execFile);
const FFMPEG=process.env.FFMPEG_PATH||'ffmpeg',FFPROBE=process.env.FFPROBE_PATH||'ffprobe';
const MAX_BYTES=95*1024*1024; // Cloudinary's upload cap is 100 MB per file
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// track: [[seconds from clip start, frame x (0..1-w)]...] -> one ffmpeg expression for the crop's x in pixels, linear between points, at most ~1 point per second.
function xExpression(track,w,iw){
 const points=[];
 for(const [t,x] of [...track].filter(p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1])).sort((a,b)=>a[0]-b[0])){
  const last=points.at(-1);
  if(last&&t-last[0]<1)continue;
  points.push([Math.max(0,t),clamp(x,0,1-w)*iw]);
 }
 if(!points.length)return null;
 let expr=points[0][1].toFixed(1);
 for(let i=0;i<points.length-1;i++){
  const [t0,x0]=points[i],[t1,x1]=points[i+1],dx=x1-x0;
  if(Math.abs(dx)<.5)continue;
  expr+=`+(${dx.toFixed(1)})*clip((t-${t0.toFixed(2)})/${Math.max(.05,t1-t0).toFixed(2)},0,1)`;
 }
 return expr;
}

async function probeSize(url){
 const {stdout}=await exec(FFPROBE,['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',url],{timeout:120000,maxBuffer:1024*1024});
 const stream=JSON.parse(stdout).streams?.[0];
 if(!(stream?.width>0&&stream?.height>0))throw new Error('The video size could not be read.');
 return {iw:stream.width,ih:stream.height};
}

// frame: {x,y,w} as fractions of the picture (w = width). ratio: crop width/height. start/end in seconds of the part.
async function renderCrop({inputUrl,start,end,frame,ratio,track,outFile,workDir}){
 const {iw,ih}=await probeSize(inputUrl);
 const cw=Math.floor(clamp(frame.w,.05,1)*iw/2)*2;
 const ch=Math.min(Math.floor(cw/ratio/2)*2,Math.floor(ih/2)*2);
 const widthFraction=cw/iw;
 const cy=Math.round(clamp(frame.y*ih,0,ih-ch));
 const staticX=Math.round(clamp(frame.x,0,1-widthFraction)*iw);
 const expr=xExpression(track||[],widthFraction,iw);
 const [outW,outH]=ratio<1?[1080,1920]:[1920,1080];
 const filter=`crop=${cw}:${ch}:'${expr?`clip(${expr},0,${iw-cw})`:staticX}':${cy},scale=${outW}:${outH}:flags=lanczos,setsar=1`;
 const script=path.join(workDir,'filter.txt');await fs.writeFile(script,filter);
 await exec(FFMPEG,['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(start),'-i',inputUrl,'-t',String(end-start),'-filter_script:v',script,
  '-c:v','libx264','-preset','veryfast','-crf','22','-maxrate','4M','-bufsize','8M','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',outFile],{timeout:30*60*1000,maxBuffer:1024*1024});
 const stat=await fs.stat(outFile);
 if(!stat.size)throw new Error('The render was empty.');
 if(stat.size>MAX_BYTES)throw new Error('The render is larger than the 100 MB storage limit. Pick a shorter range.');
 return {bytes:stat.size,width:outW,height:outH,duration:end-start};
}
module.exports={renderCrop,xExpression};
