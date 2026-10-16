const {test}=require('node:test');
const assert=require('node:assert/strict');
const {objectBelongsToRoom,view}=require('../src/live-recordings');
test('recordings accept only MP4 objects belonging to the exact room',()=>{
 assert.equal(objectBelongsToRoom('room/participant-2026.mp4','room'),true);
 for(const key of ['other/participant.mp4','room-evil/a.mp4','room/../other/a.mp4','room/a.json',null])assert.equal(objectBelongsToRoom(key,'room'),false);
});
test('archive responses expose status but no private storage identifiers',()=>{
 const result=view({_id:'123',title:'Live',status:'ready',publicId:'private/path',objectKey:'secret/object',delivery:'authenticated',bytes:100,error:''});
 assert.equal(result.status,'ready');assert.equal(result.publicId,undefined);assert.equal(result.objectKey,undefined);
});
