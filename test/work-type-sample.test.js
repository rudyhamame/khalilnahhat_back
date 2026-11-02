const {test}=require('node:test');const assert=require('node:assert/strict');
const {sampleFor,sampleProblem,SAMPLE_SECONDS}=require('../src/music-ontology/service');
const row={id:'r1',title:'Summer Mix',recordingType:'MIX',audioUrl:'https://cdn/x.mp3',publicationStatus:'PUBLISHED',archivalStatus:'ACTIVE',audio:{durationSeconds:600}};
const type={id:'MIX',sample:{recordingId:'r1',startSec:120}};
test('a work type sample is one minute of a recording of that type',()=>{
 assert.equal(SAMPLE_SECONDS,60);
 assert.deepEqual(sampleFor(type,row),{recordingId:'r1',title:'Summer Mix',startSec:120,durationSec:60,audioUrl:'https://cdn/x.mp3'});
 assert.equal(sampleFor({id:'MIX',sample:null},row),null,'no stored sample');
 assert.equal(sampleFor(type,undefined),null,'recording was deleted');
 assert.equal(sampleFor(type,{...row,recordingType:'REMIX'}),null,'recording changed to another work type');
 assert.equal(sampleFor(type,{...row,audioUrl:''}),null,'recording lost its audio');
});
test('visitors only get samples of published, active recordings; admins see every stored sample',()=>{
 assert.equal(sampleFor(type,{...row,publicationStatus:'DRAFT'}),null);
 assert.equal(sampleFor(type,{...row,archivalStatus:'ARCHIVED'}),null);
 assert.equal(sampleFor(type,{...row,publicationStatus:'DRAFT'},true).recordingId,'r1');
});
test('saving a sample checks the recording type, audio and start time',()=>{
 assert.equal(sampleProblem('MIX',row,120),null);
 assert.equal(sampleProblem('MIX',row,0),null);
 assert.match(sampleProblem('REMIX',row,0),/recording of this work type/);
 assert.match(sampleProblem('MIX',{...row,audioUrl:''},0),/no audio/);
 assert.match(sampleProblem('MIX',row,600),/after the end/);
 assert.equal(sampleProblem('MIX',{...row,audio:{durationSeconds:null}},9999),null,'unknown length is accepted');
});
