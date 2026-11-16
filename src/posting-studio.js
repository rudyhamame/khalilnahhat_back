const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const multer=require('multer');
const exec=promisify(execFile);
async function convertPostingVideo(input,output,{signal}={}){
 await exec(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-i',input,'-map','0:v:0','-map','0:a:0?','-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2','-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',output],{signal,timeout:15*60*1000,maxBuffer:1024*1024});
}
function registerPostingStudio(app,{requireAdmin,convert=convertPostingVideo}){
 let active=0;
 const upload=multer({storage:multer.diskStorage({destination:(req,file,cb)=>cb(null,req.postingDirectory),filename:(req,file,cb)=>cb(null,'source')}),limits:{fileSize:512*1024*1024,files:1,fields:0}}).single('video');
 app.post('/api/admin/posting-studio/mp4',requireAdmin,async(req,res)=>{
  if(active>=2)return res.status(429).json({message:'Two posting exports are being prepared. Try again shortly.'});
  active++;let directory;const controller=new AbortController();const cancel=()=>controller.abort();res.on('close',cancel);
  try{
   directory=await fs.mkdtemp(path.join(os.tmpdir(),'echo-posting-'));req.postingDirectory=directory;
   await new Promise((resolve,reject)=>upload(req,res,error=>error?reject(error):resolve()));
   if(!req.file)return res.status(400).json({message:'Choose a video to export.'});
   const output=path.join(directory,'posting-studio.mp4');await convert(req.file.path,output,{signal:controller.signal});
   res.set('Cache-Control','no-store');
   await new Promise((resolve,reject)=>res.download(output,'posting-studio.mp4',error=>error?reject(error):resolve()));
  }catch(error){
   if(!res.headersSent&&!res.destroyed)res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({message:error.code==='LIMIT_FILE_SIZE'?'The video exceeds the 512 MB export limit. Choose a shorter clip.':'The MP4 could not be prepared. Retry with a shorter video.'});
  }finally{res.off('close',cancel);active--;if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
 });
}
module.exports={registerPostingStudio,convertPostingVideo};
