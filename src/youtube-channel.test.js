const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createYouTubeChannelService,parseChannel}=require('./youtube-channel');

const KEY='AIzaSyEXAMPLE_YOUTUBE_API_KEY_1234567890',ID='UC'+'a'.repeat(22);
function harness(){
 let row=null,time=Date.UTC(2026,10,15),mode='ok',calls=[];
 const repository={load:async()=>structuredClone(row),save:async(value,revision)=>{assert.equal(revision,row?.revision??null);row={...structuredClone(value),revision:(revision||0)+1};return structuredClone(row);}};
 const options={repository,env:{SESSION_ENCRYPTION_KEY:'ab'.repeat(32)},now:()=>time,fetchImpl:async(url,init)=>{
  calls.push({url:String(url),headers:init.headers});
  if(mode==='network')throw Error(`private ${KEY}`);
  if(mode==='denied')return {ok:false,status:403,json:async()=>({error:{message:KEY}})};
  if(mode==='none')return {ok:true,json:async()=>({items:[]})};
  return {ok:true,json:async()=>({items:[{id:ID,snippet:{title:'DJ Khalil Nahhat',thumbnails:{high:{url:'https://yt3.example.com/a.jpg'}}},statistics:{subscriberCount:'1520',hiddenSubscriberCount:mode==='hidden'}}]})};
 }};
 return {service:createYouTubeChannelService(options),row:()=>row,calls:()=>calls,advance:ms=>{time+=ms;},mode:value=>{mode=value;}};
}

test('parseChannel accepts handles, links and ids and rejects everything else',()=>{
 assert.deepEqual(parseChannel('@djkhalilnahhat8943'),{handle:'djkhalilnahhat8943'});
 assert.deepEqual(parseChannel('https://www.youtube.com/@djkhalilnahhat8943'),{handle:'djkhalilnahhat8943'});
 assert.deepEqual(parseChannel(`youtube.com/channel/${ID}`),{channelId:ID});
 assert.deepEqual(parseChannel(ID),{channelId:ID});
 for(const bad of ['https://evil.example/@x','https://www.youtube.com/c/legacy','javascript:alert(1)','ab','https://www.youtube.com/watch?v=abc'])assert.throws(()=>parseChannel(bad),/Enter the channel/);
});

test('without an API key the channel is saved and public, with no figures',async()=>{
 const h=harness();
 assert.equal((await h.service.publicChannel()).configured,false);
 const saved=await h.service.save({channel:'@djkhalilnahhat8943',enabled:true});
 assert.equal(saved.hasApiKey,false);assert.equal(h.calls().length,0);
 const view=await h.service.publicChannel();
 assert.equal(view.url,'https://www.youtube.com/@djkhalilnahhat8943');assert.equal(view.subscribers,null);assert.equal(view.enabled,true);
});

test('an API key is verified, encrypted, sent in a header and never returned',async()=>{
 const h=harness();
 const saved=await h.service.save({channel:'@djkhalilnahhat8943',apiKey:KEY,enabled:true});
 assert.equal(saved.hasApiKey,true);assert.equal(saved.subscribers,1520);assert.equal(saved.title,'DJ Khalil Nahhat');
 assert.ok(h.row().secret&&!h.row().secret.includes(KEY));
 assert.equal(h.calls()[0].headers['x-goog-api-key'],KEY);assert.ok(!h.calls()[0].url.includes(KEY));assert.ok(h.calls()[0].url.includes('forHandle=%40djkhalilnahhat8943'));
 for(const view of [saved,await h.service.publicChannel(),await h.service.status()])assert.ok(!JSON.stringify(view).includes(KEY)&&!JSON.stringify(view).includes('secret'));
});

test('public figures refresh at most every 15 minutes and failures keep the last good data',async()=>{
 const h=harness();await h.service.save({channel:ID,apiKey:KEY,enabled:true});
 const before=h.calls().length;await h.service.publicChannel();assert.equal(h.calls().length,before);
 h.advance(16*60*1000);h.mode('network');
 const view=await h.service.publicChannel();
 assert.equal(view.subscribers,1520);assert.ok(!JSON.stringify(view).includes(KEY));
 assert.match((await h.service.status()).error,/could not be reached/i);
});

test('rejected keys, unknown channels and hidden counts are reported safely',async()=>{
 const h=harness();h.mode('denied');
 await assert.rejects(h.service.save({channel:'@djkhalilnahhat8943',apiKey:KEY,enabled:true}),e=>e.status===422&&!e.message.includes(KEY));
 assert.equal(h.row(),null);
 h.mode('none');await assert.rejects(h.service.save({channel:'@nobodyhere',apiKey:KEY,enabled:true}),e=>e.status===404);
 h.mode('hidden');const hidden=await h.service.save({channel:'@djkhalilnahhat8943',apiKey:KEY,enabled:true});
 assert.equal(hidden.subscribers,null);assert.equal(hidden.subscribersHidden,true);
});

test('disabled hides the public view and disconnect wipes the key and figures',async()=>{
 const h=harness();await h.service.save({channel:'@djkhalilnahhat8943',apiKey:KEY,enabled:true});
 await h.service.save({channel:'@djkhalilnahhat8943',enabled:false});
 assert.equal((await h.service.publicChannel()).enabled,false);assert.equal((await h.service.publicChannel()).url,'');
 const gone=await h.service.disconnect();
 assert.equal(gone.hasApiKey,false);assert.equal(h.row().secret,'');assert.equal(h.row().subscribers,null);
});

test('a missing encryption key refuses to store an API key',async()=>{
 const h=harness();const service=createYouTubeChannelService({repository:{load:async()=>null,save:async()=>{throw Error('should not save');}},env:{},fetchImpl:async()=>({ok:true,json:async()=>({items:[]})})});
 await assert.rejects(service.save({channel:'@djkhalilnahhat8943',apiKey:KEY,enabled:true}),e=>e.status===503);
 assert.equal(h.calls().length,0);
});
