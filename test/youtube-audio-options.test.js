const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {convertYoutubeToWav}=require('../src/youtube-audio');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-options-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const command=path.join(dir,'fake-downloader'),log=path.join(dir,'args.json');await fs.writeFile(command,`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(args));const template=args[args.indexOf('--output')+1];fs.writeFileSync(template.replace('%(ext)s','wav'),Buffer.from('RIFFtestWAVE'));\n`,{mode:0o755});return {command,log};}
test('configured provider uses mweb and the private token endpoint while preserving raw audio limits',async t=>{
 const previous=process.env.YOUTUBE_PO_TOKEN_BASE_URL;process.env.YOUTUBE_PO_TOKEN_BASE_URL='http://youtube-pot:4416';t.after(()=>{if(previous===undefined)delete process.env.YOUTUBE_PO_TOKEN_BASE_URL;else process.env.YOUTUBE_PO_TOKEN_BASE_URL=previous;});
 const {command,log}=await fixture(t);const result=await convertYoutubeToWav('https://youtu.be/abcdefghijk',{localOnly:true,command});const args=JSON.parse(await fs.readFile(log));
 assert.ok(args.includes('youtube:player_client=mweb'));assert.ok(args.includes('youtubepot-bgutilhttp:base_url=http://youtube-pot:4416'));assert.ok(args.includes('--no-cookies'));assert.ok(args.includes('--no-cookies-from-browser'));assert.ok(args.includes('--no-playlist'));assert.equal(args[args.indexOf('--max-filesize')+1],'100M');assert.equal(args[args.indexOf('--audio-format')+1],'wav');assert.equal(args.at(-1),'https://www.youtube.com/watch?v=abcdefghijk');assert.doesNotMatch(args.join(' '),/normalize|loudnorm|volume=/);assert.equal(result.buffer.toString(),'RIFFtestWAVE');
});
test('without a provider configuration existing default clients remain available',async t=>{
 const previous=process.env.YOUTUBE_PO_TOKEN_BASE_URL;delete process.env.YOUTUBE_PO_TOKEN_BASE_URL;t.after(()=>{if(previous!==undefined)process.env.YOUTUBE_PO_TOKEN_BASE_URL=previous;});const {command,log}=await fixture(t);await convertYoutubeToWav('https://youtu.be/abcdefghijk',{localOnly:true,command});const args=JSON.parse(await fs.readFile(log));assert.equal(args.includes('--extractor-args'),false);
});
async function sessionFixture(t,{fail=false,expired=false}={}){
 const fixtureDir=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-session-options-'));t.after(()=>fs.rm(fixtureDir,{recursive:true,force:true}));
 const session=path.join(fixtureDir,'saved.txt'),log=path.join(fixtureDir,'capture.json'),command=path.join(fixtureDir,'downloader');
 const original=`# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t${expired?'1':'2147483647'}\tSAPISID\tdummy-test-session\n.example.com\tTRUE\t/\tTRUE\t2147483647\tprivate\tunrelated-test-cookie\n`;
 await fs.writeFile(session,original,{mode:0o600});
 await fs.writeFile(command,`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2),cookie=args[args.indexOf('--cookies')+1];fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args,mode:fs.statSync(cookie).mode&0o777,hasYoutube:fs.readFileSync(cookie,'utf8').includes('youtube.com'),hasOther:fs.readFileSync(cookie,'utf8').includes('example.com')}));${fail?"console.error('Fixture download failed');process.exit(1);":"const template=args[args.indexOf('--output')+1];fs.writeFileSync(template.replace('%(ext)s','wav'),Buffer.from('RIFFtestWAVE'));"}\n`,{mode:0o755});
 const previous=process.env.YT_DLP_COOKIES_FILE;process.env.YT_DLP_COOKIES_FILE=session;t.after(()=>{if(previous===undefined)delete process.env.YT_DLP_COOKIES_FILE;else process.env.YT_DLP_COOKIES_FILE=previous;});return{session,log,command,original};
}
test('authorized sessions use filtered private snapshots and never modify the saved credential',async t=>{
 const h=await sessionFixture(t);const result=await convertYoutubeToWav('https://youtu.be/abcdefghijk',{localOnly:true,command:h.command});const logged=JSON.parse(await fs.readFile(h.log));
 assert.equal(result.authenticationMode,'session');assert.equal(logged.mode,0o600);assert.equal(logged.hasYoutube,true);assert.equal(logged.hasOther,false);assert.equal(logged.args.includes('--no-cookies'),false);assert.ok(logged.args.includes('--no-cookies-from-browser'));
 const snapshot=logged.args[logged.args.indexOf('--cookies')+1];assert.notEqual(snapshot,h.session);await assert.rejects(fs.access(snapshot));assert.equal(await fs.readFile(h.session,'utf8'),h.original);
});
test('failed downloads remove their credential snapshot and leave the saved session untouched',async t=>{
 const h=await sessionFixture(t,{fail:true});await assert.rejects(convertYoutubeToWav('https://youtu.be/abcdefghijk',{localOnly:true,command:h.command}),/Fixture download failed/);const logged=JSON.parse(await fs.readFile(h.log));await assert.rejects(fs.access(logged.args[logged.args.indexOf('--cookies')+1]));assert.equal(await fs.readFile(h.session,'utf8'),h.original);
});
test('expired sessions fail clearly without passing credentials to the downloader',async t=>{
 const h=await sessionFixture(t,{expired:true});await assert.rejects(convertYoutubeToWav('https://youtu.be/abcdefghijk',{localOnly:true,command:h.command}),error=>error.code==='YOUTUBE_SESSION_EXPIRED'&&!error.message.includes('dummy-test-session'));await assert.rejects(fs.access(h.log));
});

test('a forbidden media download retries with Safari HLS using the private session and removes partial output', async t => {
 const h=await sessionFixture(t);const attempts=path.join(path.dirname(h.log),'attempts.json');
 await fs.writeFile(h.command,`#!/usr/bin/env node
 const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),template=args[args.indexOf('--output')+1],dir=path.dirname(template),cookie=args[args.indexOf('--cookies')+1];
 const log=${JSON.stringify(attempts)};const calls=fs.existsSync(log)?JSON.parse(fs.readFileSync(log)):[];calls.push({args,partialExists:fs.existsSync(path.join(dir,'partial.part')),cookieExists:fs.existsSync(cookie)});fs.writeFileSync(log,JSON.stringify(calls));
 if(calls.length===1){fs.writeFileSync(path.join(dir,'partial.part'),'incomplete');console.error('ERROR: unable to download video data: HTTP Error 403: Forbidden');process.exit(1);}
 if(!args.includes('youtube:player_client=web_safari'))process.exit(2);
 fs.writeFileSync(template.replace('%(ext)s','wav'),Buffer.from('RIFFtestWAVE'));
 `,{mode:0o755});
 const result=await convertYoutubeToWav('https://www.youtube.com/watch?v=IWKyykQBRKo&list=RDMMmk7OOfgdtcw&index=6',{localOnly:true,command:h.command});
 const calls=JSON.parse(await fs.readFile(attempts));assert.equal(calls.length,2);assert.equal(calls[1].partialExists,false);assert.equal(calls[1].cookieExists,true);assert.equal(calls[1].args.at(-1),'https://www.youtube.com/watch?v=IWKyykQBRKo');assert.ok(calls[1].args.includes('--no-playlist'));assert.equal(result.authenticationMode,'session');assert.equal(await fs.readFile(h.session,'utf8'),h.original);await assert.rejects(fs.access(calls[1].args[calls[1].args.indexOf('--cookies')+1]));
});

test('two forbidden download methods report the media failure and clean credentials; unrelated failures do not retry',async t=>{
 for(const message of ['ERROR: HTTP Error 403: Forbidden','ERROR: Video unavailable']){
  const h=await sessionFixture(t);const attempts=path.join(path.dirname(h.log),'attempts.json');
  await fs.writeFile(h.command,`#!/usr/bin/env node
 const fs=require('node:fs');const args=process.argv.slice(2);const log=${JSON.stringify(attempts)},calls=fs.existsSync(log)?JSON.parse(fs.readFileSync(log)):[];calls.push(args);fs.writeFileSync(log,JSON.stringify(calls));console.error(${JSON.stringify(message)});process.exit(1);
 `,{mode:0o755});
  await assert.rejects(convertYoutubeToWav('https://youtu.be/abcdefghijk',{localOnly:true,command:h.command}),error=>message.includes('403')?error.code==='YOUTUBE_MEDIA_FORBIDDEN':/Video unavailable/.test(error.message));
  const calls=JSON.parse(await fs.readFile(attempts));assert.equal(calls.length,message.includes('403')?2:1);await assert.rejects(fs.access(calls[0][calls[0].indexOf('--cookies')+1]));assert.equal(await fs.readFile(h.session,'utf8'),h.original);
 }
});
