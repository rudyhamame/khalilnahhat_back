const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const DEFAULT_LIMIT = 100 * 1024 * 1024;
function segmentSeconds(bytes, duration, limit = DEFAULT_LIMIT) {
 if (!(bytes > 0 && duration > 0 && limit > 0)) throw new Error('Invalid recording size or duration.');
 return Math.max(1, Math.floor(duration * limit * 0.75 / bytes));
}
async function durationOf(filename) {
 const {stdout} = await exec('ffprobe', ['-v','error','-show_entries','format=duration','-of','json',filename], {timeout:60000,maxBuffer:1024*1024});
 const duration = Number(JSON.parse(stdout).format?.duration);
 if (!(duration > 0)) throw new Error('Recording duration could not be read.');
 return duration;
}
async function prepareRecordingFiles(filename, directory, limit = DEFAULT_LIMIT) {
 const bytes = (await fs.stat(filename)).size;
 const duration = await durationOf(filename);
 if (bytes <= limit) return [{filename,bytes,duration}];
 let seconds = segmentSeconds(bytes, duration, limit);
 for (let attempt=0;attempt<6;attempt++) {
  const segmentDir = path.join(directory, `parts-${attempt}`); await fs.mkdir(segmentDir);
  await exec('ffmpeg', ['-hide_banner','-loglevel','error','-i',filename,'-map','0:v?','-map','0:a?',
   '-c','copy','-f','segment','-segment_time',String(seconds),'-reset_timestamps','1',path.join(segmentDir,'part-%03d.mp4')], {timeout:600000,maxBuffer:1024*1024});
  const files = (await fs.readdir(segmentDir)).filter(name=>/^part-\d+\.mp4$/.test(name)).sort();
  const parts=[];
  for (const file of files) { const filename=path.join(segmentDir,file); parts.push({filename,bytes:(await fs.stat(filename)).size}); }
  if (parts.length && parts.every(p=>p.bytes>0 && p.bytes<=limit)) {
   for (const part of parts) part.duration=await durationOf(part.filename);
   return parts;
  }
  await fs.rm(segmentDir,{recursive:true,force:true});
  if(seconds===1) break;
  seconds=Math.max(1,Math.floor(seconds/2));
 }
 throw new Error('Could not split recording within the video size limit. Original retained.');
}
function cloudAssetId(roomName, index, count) {
 // Final archive: the Cloudinary "Live" folder (B2 is only the temporary staging bucket LiveKit writes to).
 return `Live/${roomName}${count>1?`/part-${String(index+1).padStart(3,'0')}`:''}`;
}
module.exports={DEFAULT_LIMIT,segmentSeconds,prepareRecordingFiles,cloudAssetId};
