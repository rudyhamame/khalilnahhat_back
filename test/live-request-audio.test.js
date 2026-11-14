const {test}=require('node:test');const assert=require('node:assert/strict');
const {registerLiveRequestAudio,audioFields}=require('../src/live-request-audio');
function harness({convert=async()=>({buffer:Buffer.from('wav'),fileName:'source.wav'}),upload=async()=>({secure_url:'https://res.cloudinary.com/test/video/upload/raw.wav',public_id:'raw'}),overrides={}}={}){
 const row={_id:'db-id',externalId:'request-id',sourcePlatform:'youtube',sourceUrl:'https://youtu.be/abcdefghijk',audioUrl:'',audioPreparation:'',...overrides,async save(){}};
 let handler,auth;const updates=[];let converts=0,uploads=0;
 const LiveRequest={async findOne(){return row;},async findOneAndUpdate(filter,update){if(filter.audioConversionLease&&filter.audioConversionLease!==row.audioConversionLease)return null;Object.assign(row,update.$set);return {...row};}};
 const service=registerLiveRequestAudio({post(path,middleware,fn){assert.equal(path,'/api/live-requests/:id/to-wav');auth=middleware;handler=fn;}},{requireAdmin:'admin-only',LiveRequest,LiveSession:{async updateMany(filter,update){assert.deepEqual(filter,{requestExternalId:'request-id'});updates.push(update.$set);}},convert:async url=>{converts++;return convert(url);},upload:async file=>{uploads++;assert.equal(file.mimetype,'audio/wav');return upload(file);},serialize:item=>({...item}),logger:{warn(){}}});
 const call=async()=>{const response={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({params:{id:'request-id'}},response);return response;};
 return {row,updates,service,call,get converts(){return converts;},get uploads(){return uploads;},get auth(){return auth;}};
}
test('conversion returns processing immediately then attaches raw WAV to the approved set list',async()=>{
 let finish;const h=harness({convert:()=>new Promise(resolve=>{finish=resolve;})});assert.equal(h.auth,'admin-only');
 const result=await h.call();assert.equal(result.code,202);assert.equal(result.body.item.audioPreparation,'converting');assert.equal(h.updates[0].audioPreparation,'converting');
 finish({buffer:Buffer.from('wav'),fileName:'raw.wav'});await h.service.idle();assert.equal(h.row.audioPreparation,'raw');assert.equal(h.updates.at(-1).audioUrl,h.row.audioUrl);assert.equal(h.updates.at(-1).audioPublicId,'raw');assert.equal(h.uploads,1);
});
test('duplicate clicks reuse an active conversion and ready audio is reused without another conversion',async()=>{
 let finish;const h=harness({convert:()=>new Promise(resolve=>{finish=resolve;})});await h.call();assert.equal((await h.call()).code,202);assert.equal(h.converts,1);
 finish({buffer:Buffer.from('wav'),fileName:'raw.wav'});await h.service.idle();assert.equal((await h.call()).code,200);assert.equal(h.converts,1);assert.equal(h.uploads,1);
});
test('blocked YouTube access persists a visible failure and is retryable',async()=>{
 let calls=0;const h=harness({convert:async()=>{if(!calls++)throw Object.assign(new Error('secret diagnostic'),{code:'YOUTUBE_PUBLIC_ACCESS_BLOCKED'});return {buffer:Buffer.from('wav'),fileName:'raw.wav'};}});await h.call();await h.service.idle();assert.equal(h.row.audioPreparation,'failed');assert.match(h.row.audioError,/YouTube blocked access/);assert.doesNotMatch(h.row.audioError,/secret/);assert.equal(h.updates.at(-1).audioPreparation,'failed');await h.call();await h.service.idle();assert.equal(h.row.audioPreparation,'raw');
});
test('old interrupted conversions can be reclaimed and non-YouTube requests cannot convert',async()=>{
 const h=harness({overrides:{audioPreparation:'converting',audioConversionStartedAt:new Date(0)}});assert.equal((await h.call()).code,202);await h.service.idle();assert.equal(h.row.audioPreparation,'raw');
 const other=harness({overrides:{sourcePlatform:'manual'}});assert.equal((await other.call()).code,400);assert.equal(other.converts,0);
});
test('audio metadata copied on approval includes the source file and preparation status',()=>{
 assert.deepEqual(audioFields({audioUrl:'url',audioPublicId:'id',audioOriginalName:'song.wav',audioPreparation:'raw'}),{audioUrl:'url',audioPublicId:'id',audioOriginalName:'song.wav',audioPreparation:'raw',audioError:'',audioConversionStartedAt:null});
});
