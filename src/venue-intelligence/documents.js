const https=require('node:https');
const dns=require('node:dns/promises');
const net=require('node:net');
const {mkdtemp,writeFile,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const cheerio=require('cheerio');
const robotsParser=require('robots-parser');
const ua='KhalilVenueResearch/1.0';
function publicIp(ip){if(net.isIP(ip)===6)return !(/^(::|fc|fd|fe[89ab]|ff|2001:db8)/i.test(ip)||ip.includes('.'));if(net.isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);}
async function pinnedRead(input,{lookup=dns.lookup,limit=8*1024*1024,redirects=3}={}){
 const url=new URL(input);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('Only public HTTPS documents can be retrieved.');
 const host=url.hostname.replace(/^\[|\]$/g,'');const addresses=await lookup(host,{all:true});if(!addresses.length||addresses.some(a=>!publicIp(a.address)))throw new Error('Private or reserved source address is blocked.');const address=addresses[0];
 const result=await new Promise((resolve,reject)=>{const request=https.get(url,{autoSelectFamily:false,headers:{'User-Agent':ua,'Accept':'text/html,application/pdf,text/plain'},lookup:(_host,_options,done)=>done(null,address.address,address.family),timeout:12000},response=>{const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>limit){response.destroy(new Error('Source document exceeds retrieval limit.'));return;}chunks.push(chunk);});response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,buffer:Buffer.concat(chunks),url:url.href}));});request.on('timeout',()=>request.destroy(new Error('Source retrieval timed out.')));request.on('error',reject);});
 if([301,302,303,307,308].includes(result.status)){if(!redirects||!result.headers.location)throw new Error('Source redirect limit reached.');return pinnedRead(new URL(result.headers.location,url).href,{lookup,limit,redirects:redirects-1});}
 if(result.status<200||result.status>=300)throw new Error(`Source returned HTTP ${result.status}.`);return result;
}
function createDocumentReader({read=pinnedRead}={}){
 const robots=new Map(),queues=new Map(),lastReads=new Map();
 const scheduledRead=(url,delay=1000,options={})=>{const origin=new URL(url).origin;const work=(queues.get(origin)||Promise.resolve()).catch(()=>{}).then(async()=>{const remaining=delay-(Date.now()-(lastReads.get(origin)||0));if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));lastReads.set(origin,Date.now());return read(url,options);});queues.set(origin,work);return work;};
 return async input=>{
  const url=new URL(input);let policy=robots.get(url.origin);
  if(!policy){try{const result=await scheduledRead(url.origin+'/robots.txt',1000,{limit:128000});policy=robotsParser(url.origin+'/robots.txt',result.buffer.toString());robots.set(url.origin,policy);}catch(error){if(!/HTTP 404|HTTP 410/.test(error.message))throw new Error('Source crawling permission could not be checked.');policy=robotsParser(url.origin+'/robots.txt','');robots.set(url.origin,policy);}}
  if(policy.isDisallowed(url.href,ua))throw new Error('Source disallows automated retrieval.');
  const crawlDelay=policy.getCrawlDelay(ua)||0;if(crawlDelay>30)throw new Error('Source requires a crawl delay outside this interactive research window.');
  const response=await scheduledRead(url.href,Math.max(1000,crawlDelay*1000));
  if(new URL(response.url).origin!==url.origin)throw new Error('Cross-site source redirects require a separately checked URL.');
  if(/noai|noarchive/i.test(response.headers['x-robots-tag']||''))throw new Error('Source restricts automated reuse.');
  let text,title,links=[];const contentType=response.headers['content-type']||'';
  if(contentType.includes('application/pdf')){
   const dir=await mkdtemp(path.join(tmpdir(),'khalil-venue-'));try{await writeFile(path.join(dir,'source.pdf'),response.buffer);await promisify(execFile)('pdftotext',['-layout','-f','1','-l','12',path.join(dir,'source.pdf'),path.join(dir,'source.txt')],{timeout:12000,maxBuffer:128000});text=await readFile(path.join(dir,'source.txt'),'utf8');title=decodeURIComponent(url.pathname.split('/').at(-1));}catch(error){throw new Error(error.code==='ENOENT'?'PDF extraction requires poppler-utils on the API server.':'This PDF could not be read; scanned plans require calibrated manual review.');}finally{await rm(dir,{recursive:true,force:true});}
  }else if(contentType.includes('html')){const $=cheerio.load(response.buffer.toString());if(/noai|noarchive/i.test($('meta[name=robots]').attr('content')||''))throw new Error('Source restricts automated reuse.');title=$('title').text();$('script,style,noscript,nav,iframe,form').remove();links=$('a[href]').map((_i,a)=>{try{return {url:new URL($(a).attr('href'),response.url).href,label:$(a).text().trim().slice(0,100)};}catch{return null;}}).get().filter(Boolean).slice(0,200);text=$('body').text();}
  else if(contentType.includes('text/plain')){text=response.buffer.toString();title=url.hostname;}else throw new Error('Source is not an HTML, text or PDF document.');
  if(robots.size>100){const first=robots.keys().next().value;robots.delete(first);queues.delete(first);lastReads.delete(first);}
  return {retrievalMethod:contentType.includes('application/pdf')?'PDF text, first 12 pages; image-only plans require calibrated manual review':'HTML/text extraction',url:response.url,title:(title||url.hostname).trim().slice(0,200),publisher:url.hostname,text:text.replace(/\s+/g,' ').trim().slice(0,30000),links};
 };
}
module.exports={publicIp,pinnedRead,createDocumentReader};
