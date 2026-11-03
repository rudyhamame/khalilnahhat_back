const test=require('node:test');
const assert=require('node:assert/strict');
const {createTranslator}=require('../src/ai-voice-alibaba');
test('voice context replaces older draft snapshots instead of truncating newer edits',()=>{
 const translator=createTranslator({instructions:'BASE',tools:[],voice:'Tina'});
 const context=text=>translator.toUpstream({type:'conversation.item.create',item:{type:'message',content:[{text}]}})[0].session.instructions;
 context('old date 2026-11-01 '+'.'.repeat(7000));
 const updated=context('current date 2026-11-14');
 assert.match(updated,/2026-11-14/);assert.doesNotMatch(updated,/2026-11-01/);
 const large=context('draft '+'.'.repeat(8000)+' latest guest count 200');assert.match(large,/latest guest count 200/);
});
test('a live snapshot arriving during the greeting survives restoration to listening',()=>{
 const translator=createTranslator({instructions:'BASE',tools:[],voice:'Tina'});
 translator.open();translator.toClient({type:'session.updated'});
 translator.toUpstream({type:'response.create',response:{instructions:'GREET'}});
 translator.toClient({type:'session.updated'});translator.drain();
 assert.deepEqual(translator.toUpstream({type:'conversation.item.create',item:{type:'message',content:[{text:'LATEST AVAILABILITY'}]}}),[]);
 translator.toClient({type:'response.created',response:{id:'opening'}});translator.toClient({type:'response.done',response:{id:'opening'}});
 const restore=translator.drain().find(event=>event.type==='session.update');
 assert.match(restore.session.instructions,/LATEST AVAILABILITY/);assert.equal(restore.session.turn_detection.type,'server_vad');
});
