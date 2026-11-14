const {randomUUID}=require('node:crypto');
const STALE_MS=10*60*1000;
function audioFields(item){return {audioUrl:item.audioUrl||'',audioPublicId:item.audioPublicId||'',audioOriginalName:item.audioOriginalName||'',audioPreparation:item.audioPreparation||'',audioConversionStartedAt:item.audioConversionStartedAt||null,audioError:item.audioError||''};}
function registerLiveRequestAudio(app,{requireAdmin,LiveRequest,LiveSession,convert,upload,serialize,logger=console}){
 const running=new Set();let claiming=false;
 const attach=item=>LiveSession.updateMany({requestExternalId:item.externalId},{$set:audioFields(item)});
 const process=async item=>{
  try{
   const result=await convert(item.sourceUrl);
   const asset=await upload({buffer:result.buffer,originalname:result.fileName,mimetype:'audio/wav'});
   const audioUrl=asset.secure_url||asset.url;
   if(!audioUrl)throw new Error('The audio upload did not return a download URL.');
   const saved=await LiveRequest.findOneAndUpdate({_id:item._id,audioConversionLease:item.audioConversionLease},{$set:{audioUrl,audioPublicId:asset.public_id||'',audioOriginalName:result.fileName,audioPreparation:'raw',audioError:''}},{new:true});
   if(saved)await attach(saved);
  }catch(error){
   const message=error.code==='YOUTUBE_SESSION_EXPIRED'?'The saved YouTube session expired. Reconnect it in Admin → YouTube.':error.code==='YOUTUBE_SESSION_UNAVAILABLE'?'The saved YouTube session could not be read. Check the YouTube connection.':error.code==='YOUTUBE_PUBLIC_ACCESS_BLOCKED'?'YouTube blocked access to this video. Connect or refresh the YouTube session in Admin → YouTube, then retry.':error.code==='YOUTUBE_BUSY'?'The converter is busy. Retry shortly.':'Audio conversion failed. Retry or use another source.';
   const saved=await LiveRequest.findOneAndUpdate({_id:item._id,audioConversionLease:item.audioConversionLease},{$set:{audioPreparation:'failed',audioError:message}},{new:true});
   if(saved)await attach(saved);
   logger.warn('Audience request audio conversion failed:',error.code||error.message);
  }
 };
 app.post('/api/live-requests/:id/to-wav',requireAdmin,async(request,response)=>{
  const item=await LiveRequest.findOne({externalId:request.params.id});
  if(!item)return response.status(404).json({message:'Audience request not found.'});
  if(item.sourcePlatform!=='youtube'||!item.sourceUrl)return response.status(400).json({message:'This request does not contain a YouTube source URL.'});
  if(item.audioUrl){item.audioPreparation='raw';item.audioError='';await item.save();await attach(item);return response.json({item:serialize(item)});}
  if(item.audioPreparation==='converting'&&new Date(item.audioConversionStartedAt).getTime()>Date.now()-STALE_MS)return response.status(202).json({item:serialize(item)});
  if(running.size||claiming)return response.status(429).json({message:'The audio converter is busy. Retry when the current conversion finishes.'});
  claiming=true;
  try{
  const claimed=await LiveRequest.findOneAndUpdate({_id:item._id,audioUrl:{$in:['',null]},$or:[{audioPreparation:{$ne:'converting'}},{audioConversionStartedAt:{$lt:new Date(Date.now()-STALE_MS)}},{audioConversionStartedAt:null}]},{$set:{audioPreparation:'converting',audioError:'',audioConversionStartedAt:new Date(),audioConversionLease:randomUUID()}},{new:true});
  if(!claimed)return response.status(409).json({message:'Conversion changed. Refresh the request and try again.'});
  await attach(claimed);
  const job=process(claimed).catch(error=>logger.warn('Could not save audio conversion status:',error.message));running.add(job);void job.finally(()=>running.delete(job));
  return response.status(202).json({item:serialize(claimed)});
  }finally{claiming=false;}
 });
 return {idle:()=>Promise.all([...running])};
}
module.exports={registerLiveRequestAudio,audioFields,STALE_MS};
