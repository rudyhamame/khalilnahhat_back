const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {z}=require('zod');
const run=promisify(execFile);
const MAX_SECONDS=300,MAX_BYTES=5_000_000;
const activeUsers=new Set();
const fail=(status,message)=>Object.assign(Error(message),{status});

// Notes are processed before preview, never sent or persisted by this endpoint.
async function prepareVoiceNote(attachment,{signal}={}) {
  const prefix=`data:${attachment.mimeType};base64,`;
  if(!attachment.data.startsWith(prefix))throw fail(400,'Invalid voice note format.');
  const encoded=attachment.data.slice(prefix.length);
  if(!/^[A-Za-z\d+/]+={0,2}$/.test(encoded)||encoded.length%4!==0)throw fail(400,'Invalid voice note data.');
  const buffer=Buffer.from(encoded,'base64');
  if(!buffer.length||buffer.length>MAX_BYTES)throw fail(400,'Voice notes must be under 5 MB.');
  let directory;
  try {
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'echo-voice-'));
    const input=path.join(directory,'input');
    const aac=attachment.mimeType==='audio/mp4';
    const extension=aac?'m4a':attachment.mimeType==='audio/ogg'?'ogg':'webm';
    const mimeType=aac?'audio/mp4':extension==='ogg'?'audio/ogg':'audio/webm';
    const output=path.join(directory,`voice.${extension}`);
    await fs.writeFile(input,buffer,{mode:0o600});
    const command=process.env.FFMPEG_PATH||'ffmpeg';
    const common=['-hide_banner','-nostdin','-nostats','-y','-max_alloc','134217728','-protocol_whitelist','file,pipe','-threads','1','-i',input,'-map','0:a:0','-vn','-sn','-dn','-t',String(MAX_SECONDS+1),'-ac','1','-ar','48000','-filter_threads','1'];
    const options={timeout:45000,maxBuffer:1_000_000,signal,killSignal:'SIGKILL'};
    const prefilter='asetpts=PTS-STARTPTS,aformat=channel_layouts=mono,highpass=f=80';
    const {stderr,stdout}=await run(command,[...common,'-af',`${prefilter},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`,'-progress','pipe:1','-f','null','-'],options);
    const elapsed=[...stdout.matchAll(/out_time_us=(\d+)/g)].at(-1);
    if(!elapsed||Number(elapsed[1])<=0)throw fail(400,'The voice note has no playable audio.');
    if(Number(elapsed[1])/1e6>MAX_SECONDS+0.25)throw fail(400,'Voice notes can be up to 5 minutes. Record a shorter note.');
    const match=stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
    if(!match)throw Error('Loudness analysis unavailable');
    const measurement=JSON.parse(match[0]);
    const keys=['input_i','input_tp','input_lra','input_thresh','target_offset'];
    let normalization='';
    if(keys.every(key=>Number.isFinite(Number(measurement[key])))&&Number(measurement.input_i)>-45) {
      // Limit makeup gain to 12 dB, so a nearly silent recording does not become loud hiss.
      const target=Math.min(-16,Number(measurement.input_i)+12);
      const offset=target===-16?Number(measurement.target_offset):0;
      normalization=`,loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${Number(measurement.input_i)}:measured_TP=${Number(measurement.input_tp)}:measured_LRA=${Number(measurement.input_lra)}:measured_thresh=${Number(measurement.input_thresh)}:offset=${offset}:linear=true`;
    }
    await run(command,[...common,'-loglevel','error','-af',`${prefilter}${normalization},alimiter=limit=0.84:level=false:latency=true`,'-map_metadata','-1','-c:a',aac?'aac':'libopus','-b:a',aac?'64k':'48k',...(aac?['-movflags','+faststart']:['-application','voip','-vbr','on','-compression_level','10']),'-threads','1',output],options);
    const stat=await fs.stat(output);
    if(!stat.size||stat.size>MAX_BYTES)throw fail(400,'The processed voice note is too large. Record a shorter note.');
    const result=await fs.readFile(output);
    return {type:'audio',name:`Voice note.${extension}`,mimeType,data:`data:${mimeType};base64,${result.toString('base64')}`};
  } catch(error) {
    if(error.status)throw error;
    if(error.name==='AbortError')throw error;
    throw fail(502,'Voice note processing failed. Please record it again.');
  } finally {if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}
function registerEchoProjectChatAudio(app,{requireAdmin}) {
  const schema=z.object({attachment:z.object({type:z.literal('audio'),name:z.string().max(160),mimeType:z.enum(['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-wav']),data:z.string().max(6_700_100)}).strict()}).strict();
  app.post('/api/echo-project-chat/voice-note/prepare',requireAdmin,async(req,res)=>{
    const user=req.user||req.authUser,id=String(user?._id||user?.id||'');
    if(!id)return res.status(401).json({message:'Sign in to prepare a voice note.'});
    const parsed=schema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({message:'Choose a supported voice note under 5 MB.'});
    if(activeUsers.has(id)||activeUsers.size>=2)return res.status(429).json({message:'Voice note processing is busy. Please try again shortly.'});
    activeUsers.add(id);
    const controller=new AbortController();
    const close=()=>{if(!res.writableEnded)controller.abort();};res.on('close',close);
    try {const attachment=await prepareVoiceNote(parsed.data.attachment,{signal:controller.signal});if(!res.destroyed)res.set('Cache-Control','no-store').json({attachment});}
    catch(error){if(!res.destroyed)res.status(error.status||503).json({message:error.status?error.message:'Voice note processing is temporarily unavailable.'});}
    finally {activeUsers.delete(id);res.off('close',close);}
  });
}
module.exports={registerEchoProjectChatAudio,prepareVoiceNote};
