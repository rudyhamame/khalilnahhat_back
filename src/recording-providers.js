const {createWriteStream}=require('node:fs');
const {pipeline}=require('node:stream/promises');
const {Readable}=require('node:stream');
const relay=require('./obs-relay-client');
const activeJob=job=>[0,1,2].includes(Number(job.status));
const terminalJob=job=>[3,4,5,6].includes(Number(job.status));
const missing=error=>error?.status===404||error?.code==='not_found'||error?.code===5;
const belongs=(key,room)=>typeof key==='string'&&key.startsWith(room+'/')&&!key.includes('..')&&key.endsWith('.mp4');
function liveKitSources(jobs,room){
 const rows=[];
 for(const job of jobs.filter(terminalJob).sort((a,b)=>Number(a.startedAt||0)-Number(b.startedAt||0))){
  const files=job.fileResults?.length?job.fileResults:job.result?.case==='file'?[job.result.value]:[];
  for(const file of files){if(!belongs(file.filename,room))throw new Error('Unexpected recording object');rows.push({key:`livekit:${job.egressId}:${file.filename}`,remote:file.filename});}
 }
 return rows;
}
function createRecordingProviders({store,bucket,egress,rooms,startCapture,clock=Date.now}){
 return {
  livekit:{
   async inspect(row,lease){
    const allJobs=await egress().listEgress({roomName:row.roomName});
    // Social-only egress is not evidence that a recording is running.
    const jobs=allJobs.filter(job=>job.egressId===row.egressId||job.fileResults?.length||job.result?.case==='file'||job.request?.value?.fileOutputs?.length);
    let participants=[];try{participants=await rooms().listParticipants(row.roomName);}catch(error){if(!missing(error))throw error;}
    const publisher=participants.find(p=>['khalil-broadcaster','khalil-obs'].includes(p.identity)&&p.tracks?.length);
    const active=jobs.some(activeJob);
    let starting=Boolean(publisher&&!active&&row.captureState==='starting'&&row.captureRequestedAt&&clock()-new Date(row.captureRequestedAt).getTime()<60000);
    if(publisher&&!active&&!starting&&(row.captureAttempts||0)<3){
     // Persist intent before the remote call. After a lost response, the next run
     // re-lists provider jobs before attempting another start.
     await lease.save({captureAttempts:(row.captureAttempts||0)+1,captureState:'starting',captureRequestedAt:new Date(clock())});
     await startCapture(row.roomName,publisher.identity);starting=true;
    }
    if(active)await lease.save({captureAttempts:0,captureRequestedAt:null});
    const sources=liveKitSources(jobs,row.roomName);
    // Legacy staging references remain recoverable even if the provider's job history aged out.
    if(row.objectKey&&belongs(row.objectKey,row.roomName)&&!sources.some(source=>source.remote===row.objectKey)&&!row.sources?.some(source=>source.remote===row.objectKey))sources.unshift({key:'legacy:'+row.objectKey,remote:row.objectKey});
    const recording=active||starting||Boolean(publisher);
    const failed=jobs.some(job=>[4,5,6].includes(Number(job.status)));
    const warning=failed?'Recording capture was interrupted. Saved parts may not cover the entire live stream.':publisher&&!active&&!starting?'Recording could not restart. Check the media provider; the live stream may continue without being saved.':'';
    let ended=false;
    if(!recording&&(jobs.length||clock()-new Date(row.createdAt).getTime()>300000)){
     if(!row.endObservedAt)await lease.save({endObservedAt:new Date(clock())});
     else ended=clock()-new Date(row.endObservedAt).getTime()>=15000;
    }else if(row.endObservedAt)await lease.save({endObservedAt:null});
    return {sources,active:recording,ended,captureState:active?'recording':starting?'starting':publisher?'failed':ended?'ended':'waiting',warning};
   },
   async download(row,source,filename){if(!belongs(source.remote,row.roomName))throw new Error('Invalid recording object');await pipeline(await store().getObject(bucket(),source.remote),createWriteStream(filename,{mode:0o600}),{signal:AbortSignal.timeout(600000)});},
   async remove(row,source){if(!belongs(source.remote,row.roomName))throw new Error('Invalid recording object');await store().removeObject(bucket(),source.remote);},
  },
  ovh:{
   async inspect(row){
    const state=await relay.request(relay.sessionRoute(row.roomName),{allowMissing:true});
    if(!state){const ended=clock()-new Date(row.createdAt).getTime()>=120000;return {sources:[],active:false,ended,captureState:ended?'ended':'waiting',warning:ended&&(row.parts?.length||row.sources?.length)?'The relay session is unavailable. Only the already saved parts can be confirmed.':''};}
    const sources=[...(state.segments||[])].sort((a,b)=>a.id.localeCompare(b.id)).map(segment=>{relay.segmentRoute(row.roomName,segment.id);return {key:'relay:'+segment.id,remote:segment.id,alreadySaved:row.relaySegments?.includes(segment.id)};});
    const ended=state.state==='ended'&&clock()-Number(state.endedAt)>=15000;
    return {sources,active:['live','ending'].includes(state.state),ended,captureState:ended?'ended':state.state==='live'?'recording':'waiting',warning:state.error||''};
   },
   async download(row,source,filename){
    const response=await relay.request(relay.segmentRoute(row.roomName,source.remote),{raw:true});
    const bytes=Number(response.headers.get('content-length'));
    if(!(bytes>0)||bytes>2*1024*1024*1024)throw new Error('Invalid recording size');
    await pipeline(Readable.fromWeb(response.body),createWriteStream(filename,{mode:0o600}),{signal:AbortSignal.timeout(600000)});
    const actual=await require('node:fs/promises').stat(filename);if(actual.size!==bytes)throw new Error('Incomplete recording download');
   },
   async remove(row,source){await relay.request(relay.segmentRoute(row.roomName,source.remote),{method:'DELETE',allowMissing:true});},
  },
 };
}
module.exports={createRecordingProviders,liveKitSources,activeJob};
