// Backend owns the Booking Tree and journey. Copy all compatibility assets together; --check never writes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const args=process.argv.slice(2),check=args.includes('--check');
const root=path.resolve(args.find(value=>!value.startsWith('--'))||path.join(os.homedir(),'AndroidStudioProjects'));
const tree=fs.readFileSync(path.join(__dirname,'../contracts/booking-atoms.json'),'utf8');
const schema=JSON.stringify(JSON.parse(tree).order,null,1)+'\n';
const journey=fs.readFileSync(path.join(__dirname,'../contracts/booking-journey.json'),'utf8');
let failed=false;
for(const app of ['EchoDJ','EchoClient']){
 const assets=path.join(root,app,'app/src/main/assets');
 const outputs=[['contracts/booking-atoms.json',tree],['contracts/booking-journey.json',journey],...(app==='EchoDJ'?[['contracts/event-order.json',schema]]:[['booking-atoms.json',tree],['eventOrderContract.json',schema]])];
 if(!fs.existsSync(path.join(root,app,'app/build.gradle.kts')))throw Error(`Android project not found: ${app}`);
 for(const [name,source] of outputs){const target=path.join(assets,name);
  if(check){if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==source){console.error(`${app}: ${name} differs from the Booking Tree`);failed=true;}}
  else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);}
 }
 console.log(`${app}: Booking Tree ${check?'checked':'copied'}`);
}
if(failed)process.exitCode=1;
