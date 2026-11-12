// How busy the OVH server is, so heavy worker processes can ask the admin to try again later.
const os=require('node:os'),fs=require('node:fs');
const MAX_LOAD_PER_CPU=Number(process.env.WORKER_MAX_LOAD_PER_CPU||1.2),MIN_FREE_MB=Number(process.env.WORKER_MIN_FREE_MB||600);
const freeMb=(read=()=>fs.readFileSync('/proc/meminfo','utf8'))=>{try{return Math.round(Number(/MemAvailable:\s+(\d+)/.exec(read())[1])/1024);}catch{return Math.round(os.freemem()/1048576);}};
// A channel split is running while its Python process exists (found without touching the stem code).
const separationRunning=()=>{try{return fs.readdirSync('/proc').some(pid=>/^\d+$/.test(pid)&&(()=>{try{return fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').some(arg=>arg.endsWith('/separate-stems.py'));}catch{return false;}})());}catch{return false;}};
// ponytail: host load average and MemAvailable (containers see the host's); tune with WORKER_MAX_LOAD_PER_CPU / WORKER_MIN_FREE_MB.
function snapshot({separating=false,load=os.loadavg()[0],cpus=os.cpus().length||1,free=freeMb()}={}){
 const perCpu=load/cpus,reasons=[];
 if(separating)reasons.push('another recording is being split into channels');
 if(perCpu>=MAX_LOAD_PER_CPU)reasons.push(`the CPU is busy (load ${load.toFixed(1)} on ${cpus} cores)`);
 if(free<MIN_FREE_MB)reasons.push(`memory is low (${free} MB free)`);
 return {busy:reasons.length>0,reason:reasons.length?`The OVH server is busy: ${reasons.join(' and ')}.`:'',load:Number(load.toFixed(2)),cpus,freeMb:free,separating};
}
module.exports={snapshot,freeMb,separationRunning};
