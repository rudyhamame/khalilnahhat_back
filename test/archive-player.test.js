const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validatePlaylistSelection,isCloudinaryAudio,playlistInput}=require('../src/archive-player');
const rows=[{externalId:'a',title:'A',audioUrl:'https://res.cloudinary.com/echo/video/upload/a.mp3'},{externalId:'b',title:'B',audioUrl:'https://res.cloudinary.com/echo/video/upload/b.mp3'}];
test('playlist accepts selected uploaded music and preserves administrator order',()=>assert.equal(validatePlaylistSelection(['b','a'],rows,'echo'),''));
test('playlist refuses missing, duplicate, external or another account audio',()=>{
 assert.match(validatePlaylistSelection(['missing'],rows,'echo'),/no longer exists/);
 assert.match(validatePlaylistSelection(['a','a'],rows,'echo'),/once/);
 assert.match(validatePlaylistSelection(['a'],[{...rows[0],audioUrl:'https://example.com/a.mp3'}],'echo'),/Upload/);
 assert.match(validatePlaylistSelection(['a'],rows,'another-cloud'),/Upload/);
});
test('Cloudinary URL validation forbids HTTP, lookalike hosts and image resources',()=>{
 for(const url of ['http://res.cloudinary.com/echo/video/a.mp3','https://res.cloudinary.com.evil.example/echo/video/a.mp3','https://res.cloudinary.com/echo/image/upload/a.jpg'])assert.equal(isCloudinaryAudio(url,'echo'),false);
});
test('playlist payload is bounded and does not accept arbitrary track URLs',()=>{
 assert.equal(playlistInput.safeParse({enabled:true,archiveIds:['a'],audioUrl:'https://evil.example'}).success,false);
 assert.equal(playlistInput.safeParse({enabled:true,archiveIds:Array.from({length:101},(_,i)=>String(i))}).success,false);
});
