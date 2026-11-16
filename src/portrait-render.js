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

// points: [[seconds, value]...] -> ffmpeg expression, linear between points (about 1 point per 0.5 s kept).
function pathExpression(points,minGap=.5){
 const list=[];
 for(const [t,v] of [...points].filter(p=>p.every(Number.isFinite)).sort((a,b)=>a[0]-b[0])){const last=list.at(-1);if(last&&t-last[0]<minGap)continue;list.push([Math.max(0,t),v]);}
 if(!list.length)return {expr:'0',from:0,to:0};
 let expr=list[0][1].toFixed(1);
 for(let i=0;i<list.length-1;i++){const [t0,v0]=list[i],[t1,v1]=list[i+1],d=v1-v0;if(Math.abs(d)<.5)continue;expr+=`+(${d.toFixed(1)})*clip((t-${t0.toFixed(2)})/${Math.max(.05,t1-t0).toFixed(2)},0,1)`;}
 return {expr,from:list[0][0],to:list.at(-1)[0]};
}
const even=v=>Math.max(2,Math.floor(v/2)*2);
// blur: [{pts:[[t,x,y,w,h]...]}] normalised boxes (top-left, size) of people to hide; t in seconds from clip start. Returns the filter-graph lines that blur those regions.
function blurGraph(blur,iw,ih){
 const slots=(blur||[]).slice(0,6).map(slot=>({pts:(slot.pts||[]).filter(p=>p.length===5&&p.every(Number.isFinite)).slice(0,1500)})).filter(slot=>slot.pts.length);
 if(!slots.length)return null;
 const n=slots.length,lines=[];
 lines.push(`[0:v]split=2[base][raw]`,`[raw]boxblur=28:4[bl]`);
 if(n>1)lines.push(`[bl]split=${n}${slots.map((_,i)=>`[b${i}]`).join('')}`);
 let prev='base';
 slots.forEach((slot,i)=>{
  const W=Math.min(even(Math.max(...slot.pts.map(p=>p[3]))*iw),even(iw)),H=Math.min(even(Math.max(...slot.pts.map(p=>p[4]))*ih),even(ih));
  const X=pathExpression(slot.pts.map(p=>[p[0],(p[1]+p[3]/2)*iw-W/2])),Y=pathExpression(slot.pts.map(p=>[p[0],(p[2]+p[4]/2)*ih-H/2]));
  const x=`clip(${X.expr},0,${iw-W})`,y=`clip(${Y.expr},0,${ih-H})`,src=n>1?`b${i}`:'bl',last=i===n-1?'blurred':`o${i}`;
  lines.push(`[${src}]crop=${W}:${H}:'${x}':'${y}'[c${i}]`);
  lines.push(`[${prev}][c${i}]overlay=x='${x}':y='${y}':enable='between(t,${Math.max(0,X.from-.3).toFixed(2)},${(X.to+.6).toFixed(2)})'[${last}]`);
  prev=last;
 });
 return lines;
}

async function probeSize(url){
 const {stdout}=await exec(FFPROBE,['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',url],{timeout:120000,maxBuffer:1024*1024});
 const stream=JSON.parse(stdout).streams?.[0];
 if(!(stream?.width>0&&stream?.height>0))throw new Error('The video size could not be read.');
 return {iw:stream.width,ih:stream.height};
}

// frame: {x,y,w} as fractions of the picture (w = width). ratio: crop width/height. start/end in seconds of the part.
async function renderCrop({inputUrl,start,end,frame,ratio,track,blur,outFile,workDir}){
 const {iw,ih}=await probeSize(inputUrl);
 const cw=Math.floor(clamp(frame.w,.05,1)*iw/2)*2;
 const ch=Math.min(Math.floor(cw/ratio/2)*2,Math.floor(ih/2)*2);
 const widthFraction=cw/iw;
 const cy=Math.round(clamp(frame.y*ih,0,ih-ch));
 const staticX=Math.round(clamp(frame.x,0,1-widthFraction)*iw);
 const expr=xExpression(track||[],widthFraction,iw);
 const scale=Math.min(1080/Math.min(ratio,1),1920/Math.max(ratio,1));
 const [outW,outH]=[even(ratio*scale),even(scale)];
 const reframe=`crop=${cw}:${ch}:'${expr?`clip(${expr},0,${iw-cw})`:staticX}':${cy},scale=${outW}:${outH}:flags=lanczos,setsar=1`;
 const graph=blurGraph(blur,iw,ih),script=path.join(workDir,'filter.txt');
 // With blur: a full graph (blur the people, then reframe); without: the plain crop chain.
 await fs.writeFile(script,graph?`${graph.join(';\n')};\n[blurred]${reframe}[v]`:reframe);
 await exec(FFMPEG,['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(start),'-i',inputUrl,'-t',String(end-start),...(graph?['-filter_complex_script',script,'-map','[v]','-map','0:a?']:['-filter_script:v',script]),
  '-c:v','libx264','-preset','veryfast','-crf','22','-maxrate','4M','-bufsize','8M','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',outFile],{timeout:30*60*1000,maxBuffer:1024*1024});
 const stat=await fs.stat(outFile);
 if(!stat.size)throw new Error('The render was empty.');
 if(stat.size>MAX_BYTES)throw new Error('The render is larger than the 100 MB storage limit. Pick a shorter range.');
 return {bytes:stat.size,width:outW,height:outH,duration:end-start};
}
module.exports={renderCrop,xExpression,blurGraph};
