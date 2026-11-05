const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const run=promisify(execFile);
const formats={mp3:{extension:'mp3',mime:'audio/mpeg',codec:'libmp3lame',bitrate:'192k'},aac:{extension:'m4a',mime:'audio/mp4',codec:'aac',bitrate:'160k'}};
let active=0;
async function compressTrimmedAudio(file,format){
 const option=formats[format];if(!option)throw Object.assign(Error('Choose MP3 or AAC for trim export.'),{status:400});
 if(active>=2)throw Object.assign(Error('Audio compression is busy. Try again shortly.'),{status:503});
 active++;let directory;
 try{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'echo-trim-'));
  const input=path.join(directory,'input.wav'),output=path.join(directory,`trimmed.${option.extension}`);
  await fs.writeFile(input,file.buffer,{mode:0o600});
  await run(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-protocol_whitelist','file,pipe','-i',input,'-map','0:a:0','-vn','-map_metadata','-1','-c:a',option.codec,'-b:a',option.bitrate,'-ar','44100','-threads','1',...(format==='aac'?['-movflags','+faststart']:[]),output],{timeout:120000,maxBuffer:1024*1024});
  const stat=await fs.stat(output);if(!stat.size||stat.size>100*1024*1024)throw Error('Invalid compressed output');
  const buffer=await fs.readFile(output);
  return {...file,buffer,size:buffer.length,mimetype:option.mime,originalname:`trimmed.${option.extension}`};
 }catch(error){if(error.status)throw error;throw Object.assign(Error('The trimmed audio could not be compressed. Please try again.'),{status:502});}
 finally{active--;if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}
module.exports={compressTrimmedAudio};
