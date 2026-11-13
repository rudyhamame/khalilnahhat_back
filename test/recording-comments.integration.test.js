const test=require('node:test'),assert=require('node:assert/strict'),mongoose=require('mongoose'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
test('recording finalization snapshots comments with pause-aware timestamps and preview trims',{timeout:30000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'recording-comments-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const mongo=spawn('mongod',['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',directory,'--logpath',path.join(directory,'mongo.log')],{stdio:'ignore'});
 t.after(async()=>{await mongoose.disconnect();mongo.kill('SIGTERM');if(mongo.exitCode===null)await new Promise(resolve=>mongo.once('exit',resolve));await fs.rm(directory,{recursive:true,force:true});});
 for(let i=0;i<40;i++){try{await mongoose.connect(`mongodb://127.0.0.1:${port}/recording_comments_qa`,{serverSelectionTimeoutMS:200});break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 const {LiveRecording,registerLiveRecordings}=require('../src/live-recordings'),{LiveComment}=require('../src/live-comments'),{RecordingComment}=require('../src/recording-comments');
 await Promise.all([LiveRecording.init(),LiveComment.init(),RecordingComment.init()]);
 const start=Date.now()-40000,roomName='comments-test';
 const row=await LiveRecording.create({roomName,provider:'direct',status:'recording',direct:{count:1,bytes:1,state:'open'}});
 await LiveComment.create([{session:roomName,authorId:'member',name:'Guest',text:'First',createdAt:new Date(start+2000)},{session:roomName,authorId:'member',name:'Guest',text:'Paused',createdAt:new Date(start+15000)},{session:roomName,authorId:'member',name:'Guest',text:'After pause',createdAt:new Date(start+22000)}]);
 await require('../src/recording-jobs').recordingJobs(LiveRecording).run(row._id,lease=>require('../src/direct-recording').seal(lease,1,true,1,[{startMs:start,endMs:start+10000,offsetSec:0},{startMs:start+20000,endMs:start+30000,offsetSec:10}]));
 const stored=await LiveRecording.findById(row._id);assert.equal(stored.commentsCaptured,true);assert.equal(stored.recordingTimeline.length,2);
 assert.deepEqual((await RecordingComment.find({recordingId:row._id}).sort({atSec:1}).lean()).map(c=>c.atSec),[2,12]);
 // The archive is independent of the live-room comments after finalization.
 await LiveComment.deleteMany({session:roomName});
 await LiveRecording.updateOne({_id:row._id},{$set:{status:'ready',parts:[{publicId:'test',bytes:1,duration:20,trimStart:5,trimEnd:18}]}});
 const app=require('express')();registerLiveRecordings(app,(_req,_res,next)=>next(),{startWorker:false});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/live-recordings/${row._id}/comments?part=0`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.approximate,false);assert.deepEqual(data.items.map(c=>[c.text,c.atSec]),[['After pause',7]]);
});
