// Backend owns this contract. Usage: node scripts/sync-android-booking-contracts.cjs [--check] [AndroidStudioProjects directory]
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const args=process.argv.slice(2),check=args.includes('--check');
const root=path.resolve(args.find(value=>!value.startsWith('--'))||path.join(os.homedir(),'AndroidStudioProjects'));
const source=fs.readFileSync(path.join(__dirname,'../contracts/booking-journey.json'),'utf8');
let failed=false;
for(const app of ['EchoDJ','EchoClient']){
 const target=path.join(root,app,'app/src/main/assets/contracts/booking-journey.json');
 if(check){
  if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==source){console.error(`${app}: booking contract differs from backend`);failed=true;}
  else console.log(`${app}: booking contract in sync`);
 }else{
  if(!fs.existsSync(path.join(root,app,'app/build.gradle.kts')))throw Error(`Android project not found: ${app}`);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);console.log(`${app}: copied booking contract`);
 }
}
if(failed)process.exitCode=1;
