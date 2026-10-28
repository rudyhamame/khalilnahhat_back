const {test}=require('node:test');const assert=require('node:assert/strict');
const {assertAcyclic,matches,norm}=require('../src/music-ontology/service');
const V=require('../src/music-ontology/validation');
const {migrationInput}=require('../src/music-ontology/migration');
test('controlled classifications, positive BPM, key notation and credit roles',()=>{
 const base={title:'Recording',recordingType:'MIX',workId:'work'};
 for(const type of ['MIX','REMIX','COVER','PRODUCTION'])assert.equal(V.recording.parse({...base,recordingType:type}).recordingType,type);
 for(const metadata of [{bpm:0},{bpm:-1},{key:'Camelot 8A'},{key:'H minor'}])assert.equal(V.recording.safeParse({...base,recordingMetadata:metadata}).success,false);
 assert.equal(V.recording.safeParse({...base,credits:[{artistId:'a'}]}).success,false);
 assert.equal(V.work.safeParse({title:'Music',type:'MUSIC',lyrics:{text:'No'}}).success,false);
 assert.equal(V.work.parse({title:'Song in progress',type:'SONG'}).type,'SONG');
});
test('metadata states distinguish empty, unknown, not applicable and specified',()=>{
 assert.deepEqual(V.metadataStates({bpm:null,key:'C major'},{bpm:'UNKNOWN'}),{bpm:'UNKNOWN',key:'SPECIFIED'});
 assert.equal(V.metadataStates({bpm:null},{bpm:'NOT_APPLICABLE'}).bpm,'NOT_APPLICABLE');
 assert.throws(()=>V.metadataStates({bpm:120},{bpm:'UNKNOWN'}));
 assert.throws(()=>V.metadataStates({bpm:null},{bpm:'SPECIFIED'}));
});
test('source derivations reject self reference and indirect cycles',()=>{
 assert.throws(()=>assertAcyclic('a',['a'],[]),/cycle/);
 assert.throws(()=>assertAcyclic('a',['b'],[{externalId:'b',sourceRecordingIds:['c']},{externalId:'c',sourceRecordingIds:['a']}]),/cycle/);
 assert.doesNotThrow(()=>assertAcyclic('a',['b','c'],[{externalId:'b',sourceRecordingIds:['c']}]));
});
test('canonical filters preserve scope, Song-only lyrics and combined unique results',()=>{
 const row={title:'Song remix',recordingType:'REMIX',recordingMetadata:{bpm:130,key:'D minor'},work:{type:'SONG',title:'Shared work',lyrics:{language:{id:'ar'},dialect:{id:'levant'},artistCredits:[{artistId:'lyricist'}],regions:[{id:'region'}],concepts:[{id:'love'}]},melody:{bpm:90,key:'C minor',rhythm:{id:'rhythm'},genres:[{id:'pop'}]}}};
 assert.equal(matches(row,{recordingType:'REMIX',language:'ar',dialect:'levant',region:'region',concept:'love',genre:'pop',bpmMin:'85',bpmMax:'100',lyricArtist:'lyricist'}),true);
 assert.equal(matches(row,{bpmMin:'120'}),false);
 assert.equal(matches(row,{bpmMin:'120',bpmScope:'recording',key:'D minor'}),true);
 assert.equal(matches({...row,work:{...row.work,type:'MUSIC',lyrics:null}},{language:'ar'}),false);
 assert.equal(matches({...row,recordingMetadata:{bpm:null}},{bpmMin:'1',bpmScope:'recording'}),false);
});
test('legacy mapping never invents work identity or canonical work BPM',()=>{
 const input=migrationInput({title:'Legacy',bpm:'120',musicalKey:'8A',lyricsLanguage:'Arabic',published:true,audioUrl:'uploaded'}, {workId:'reviewed',recordingType:'COVER'});
 assert.equal(input.workId,'reviewed');assert.equal(input.recordingMetadata.bpm,120);assert.equal(input.recordingMetadata.key,null);assert.equal(input.recordingMetadata.states.key,'UNKNOWN');assert.equal('lyrics' in input,false);
 assert.equal(norm('  A\u00a0  Name  '),'a name');
});

test('authoritative contract matches its synchronized checksum',()=>{const fs=require('fs'),crypto=require('crypto'),path=require('path');const file=path.join(__dirname,'../contracts/music-ontology.json');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),fs.readFileSync(file.replace('.json','.sha256'),'utf8').trim());});
