const mongoose=require('mongoose');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const net=require('node:net');const {spawn}=require('node:child_process');const express=require('express');
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'khalil-ontology-browser-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dir,'--replSet','ontologyBrowser','--logpath',path.join(dir,'mongo.log')],{stdio:'ignore'});
 const stop=async()=>{await mongoose.disconnect();mongo.kill('SIGTERM');await new Promise(resolve=>mongo.exitCode!==null?resolve():mongo.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});};
 try{
 let direct;for(let i=0;i<40;i++){try{direct=await mongoose.createConnection(`mongodb://127.0.0.1:${port}`,{directConnection:true,serverSelectionTimeoutMS:400}).asPromise();break;}catch{await new Promise(r=>setTimeout(r,100));}}
 if(!direct)throw Error('Disposable MongoDB failed to start');
 await direct.db.admin().command({replSetInitiate:{_id:'ontologyBrowser',members:[{_id:0,host:`127.0.0.1:${port}`}]}});await direct.close();
 await mongoose.connect(`mongodb://127.0.0.1:${port}/?replicaSet=ontologyBrowser`,{dbName:'browser_qa',serverSelectionTimeoutMS:20000});
 process.env.MUSIC_ARCHIVE_STORAGE_DIR=path.join(dir,'media');
 const M=require('../../src/music-ontology/models');const {ArchiveItem}=require('../../src/models');const archive=require('../../src/music-archive');
 await Promise.all([...Object.values(M).filter(m=>m?.init),ArchiveItem].map(m=>m.init()));
 const service=archive.ontologyService();
 const language=await service.saveVocabulary({kind:'language',name:'Arabic',isoCode:'ar'},null,'qa');
 const genre=await service.saveVocabulary({kind:'genre',name:'Arabic Pop'},null,'qa');
 const artist=await service.saveVocabulary({kind:'artist',name:'Khalil'},null,'qa');
 const song=await service.saveWork({title:'Evening Song',type:'SONG',melody:{bpm:100,key:'D minor',genreIds:[genre.externalId]},lyrics:{languageId:language.externalId,artistCredits:[{artistId:artist.externalId,role:'VOCALIST'}],conceptIds:[]}},null,'qa');
 const instrument=await service.saveVocabulary({kind:'instrument',name:'Piano'},null,'qa');
 const music=await service.saveWork({title:'Night Instrumental',type:'MUSIC',melody:{bpm:120,key:'A minor',instrumentIds:[instrument.externalId],musicianCredits:[{artistId:artist.externalId,role:'PERFORMER'}]}},null,'qa');
 const samples=22050*20,buffer=Buffer.alloc(44+samples*2);buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(22050,24);buffer.writeUInt32LE(44100,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)buffer.writeInt16LE(Math.round(Math.sin(i/22050*440*Math.PI*2)*1000),44+i*2);
 const asset=await require('../../src/music-archive-files').saveLocalFile({buffer,mimetype:'audio/wav',originalname:'qa-tone.wav'});
 const ids=[];for(const type of ['MIX','REMIX','COVER','PRODUCTION'])ids.push(await service.saveRecording({title:`${type} · Evening collection`,recordingType:type,workId:type==='MIX'?music:song,audioUrl:asset.url,durationSeconds:20,publicationStatus:'PUBLISHED',recordingMetadata:{bpm:type==='REMIX'?128:null},credits:[{artistId:artist.externalId,role:'PRODUCER'}],...(type==='REMIX'?{sourceRecordingIds:[ids[0]]}:{})},null,'qa'));
 const app=express();app.use(express.json());const auth=(req,res,next)=>req.headers.authorization==='Bearer qa-admin'?next():res.status(401).json({message:'Unauthorized'});
 archive.registerMusicArchive(app,{requireAdmin:auth,requireCloudinary:false,useCloudinary:false});
 app.get('/api/player/playlist',(_req,res)=>res.json({items:[],enabled:false}));
 app.get('/api/player/stems/:id',(_req,res)=>res.status(404).json({message:'No stems'}));
 app.use((_req,res)=>res.status(404).json({message:'Not found'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 return {origin:`http://127.0.0.1:${server.address().port}`,ids,song,music,artist:artist.externalId,language:language.externalId,service,stop:async()=>{await new Promise(r=>server.close(r));await stop();}};
 }catch(e){await stop();throw e;}
}
module.exports={fixture};
