const {test}=require('node:test');const assert=require('node:assert/strict');
const {assertAcyclic,matches,norm}=require('../src/music-ontology/service');
const V=require('../src/music-ontology/validation');
const {migrationInput}=require('../src/music-ontology/migration');
test('controlled classifications, positive BPM, key notation and credit roles',()=>{
 const base={title:'Recording',workType:'MIX',workId:'work'};
 for(const type of ['MIX','REMIX','COVER','PRODUCTION'])assert.equal(V.recording.parse({...base,workType:type}).workType,type);
 for(const metadata of [{bpms:[0]},{bpms:[-1]},{keys:['Camelot 8A']},{keys:['H minor']}])assert.equal(V.recording.safeParse({...base,atoms:[{id:'a',name:'A',sound:metadata}]}).success,false);
 assert.equal(V.recording.safeParse({...base,atoms:[{id:'a',name:'A',sound:{musicianCredits:[{instrumentId:'x'}]}}]}).success,false);
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
 const row={title:'Song remix',workType:'REMIX',recordingMetadata:{bpm:130,key:'D minor'},work:{type:'SONG',title:'Shared work',lyrics:{language:{id:'ar'},dialect:{id:'levant'},artistCredits:[{artistId:'singer'}],regions:[{id:'region'}]},melody:{bpm:90,key:'C minor',rhythm:{id:'rhythm'},genres:[{id:'pop'}]}}};
 assert.equal(matches(row,{workType:'REMIX',language:'ar',dialect:'levant',region:'region',genre:'pop',bpmMin:'85',bpmMax:'100'}),true);
 assert.equal(matches(row,{bpmMin:'120'}),false);
 assert.equal(matches(row,{bpmMin:'120',bpmScope:'recording',key:'D minor'}),true);
 assert.equal(matches({...row,work:{...row.work,type:'MUSIC',lyrics:null}},{language:'ar'}),false);
 assert.equal(matches({...row,recordingMetadata:{bpm:null}},{bpmMin:'1',bpmScope:'recording'}),false);
});
test('legacy mapping never invents work identity or canonical work BPM',()=>{
 const input=migrationInput({title:'Legacy',bpm:'120',musicalKey:'8A',lyricsLanguage:'Arabic',published:true,audioUrl:'uploaded'}, {workId:'reviewed',workType:'COVER'});
 assert.equal(input.workId,'reviewed');assert.equal('recordingMetadata' in input,false);assert.equal('lyrics' in input,false);
 assert.equal(norm('  A\u00a0  Name  '),'a name');
});

test('authoritative contract matches its synchronized checksum',()=>{const fs=require('fs'),crypto=require('crypto'),path=require('path');const file=path.join(__dirname,'../contracts/music-ontology.json');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),fs.readFileSync(file.replace('.json','.sha256'),'utf8').trim());});

test('Music instruments and musicians use identities and performance roles',()=>{const m=V.melody.parse({key:'A minor',instrumentIds:['piano'],musicianCredits:[{artistId:'person',role:'PERFORMER'}]});assert.equal(m.key,'A minor');assert.deepEqual(m.instrumentIds,['piano']);assert.equal(m.musicianCredits[0].role,'PERFORMER');assert.equal(V.melody.safeParse({musicianCredits:[{artistId:'person',role:'LYRICIST'}]}).success,false);assert.equal(V.melody.safeParse({instrumentIds:['piano','piano']}).success,false);const r={work:{type:'MUSIC',melody:{instruments:[{id:'piano'}],musicianCredits:[{artistId:'person'}],key:'A minor'}}};assert.equal(matches(r,{instrument:'piano',musician:'person',key:'A minor'}),true);assert.equal(matches(r,{instrument:'violin'}),false);});
test('recordings accept recording-level credits as lists',()=>{
  const {recording}=require('../src/music-ontology/validation');
  const base={title:'Mix',workType:'mix',atoms:[{id:'a1',name:'Atom',releaseYear:null}]};
  const ok=recording.safeParse({...base,recordingCredits:{vocalists:[{artistId:'v1'}],musicians:[]}});
  assert.equal(ok.success,true,JSON.stringify(ok.error?.issues?.slice(0,2)));
  assert.equal('recordingCredits' in ok.data,false);
});
