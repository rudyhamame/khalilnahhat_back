const{test}=require('node:test');const assert=require('node:assert/strict');const {youtubeMetadata,songMetadataFields}=require('../src/youtube-metadata');
test('metadata keeps public song facts and excludes signed media URLs, headers and arbitrary fields',()=>{
 const result=youtubeMetadata({id:'abcdefghijk',title:'Official music title',track:'Song',artists:['Artist A','Artist B'],duration:243.7,album:'Album',channel:'Channel',thumbnail:'https://i.ytimg.com/example.jpg',webpage_url:'https://www.youtube.com/watch?v=abcdefghijk',channel_url:'javascript:secret',description:'x'.repeat(7000),tags:['tag'],view_count:0,url:'https://signed.example/SECRET',http_headers:{Cookie:'COOKIE_SECRET'},formats:[{url:'SECRET'}],cookies:'SECRET'});
 assert.equal(result.artist,'Artist A, Artist B');assert.equal(result.durationSec,243.7);assert.equal(result.viewCount,0);assert.equal(result.description.length,6000);assert.equal(result.channelUrl,'');assert.doesNotMatch(JSON.stringify(result),/SECRET|http_headers|formats|cookies/);
});
test('song metadata fills missing fields without overwriting an explicit song title or musical details',()=>{
 const metadata=youtubeMetadata({title:'Video title',track:'Song title',artist:'Artist',duration:244,language:'ar',thumbnail:'https://example.com/cover.jpg'});
 const fields=songMetadataFields({track:'Song request'},metadata);assert.equal(fields.track,'Song title');assert.equal(fields.duration,'4:04');assert.equal(fields.artist,'Artist');
 const kept=songMetadataFields({track:'Custom title',artist:'Custom artist',duration:'3:00',language:'en'},metadata);for(const field of['track','artist','duration','language'])assert.equal(field in kept,false);assert.equal('bpm' in kept,false);assert.equal('genre' in kept,false);
});
