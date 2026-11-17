const ECHO_REEL_GOAL='echo-reel-9x16';
function isEchoReel(render){return Boolean(render&&render.goal===ECHO_REEL_GOAL&&render.status==='ready'&&render.publicId&&render.width>0&&render.height>0&&Math.abs(render.width/render.height-9/16)<.01);}
function publicReels(rows,videoUrl){
 return rows.filter(row=>!row.deletedAt&&row.test!==true).flatMap(row=>(row.renders||[]).filter(render=>render.echoPublished===true&&isEchoReel(render)).map(render=>({id:String(render._id),title:render.name||row.title||'Echo Reel',videoUrl:videoUrl(render),width:render.width,height:render.height,duration:render.duration||0,publishedAt:render.echoPublishedAt||render.createdAt}))).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt)).slice(0,100);
}
function registerEchoReels(app,{requireAdmin,Recording,serialize,videoUrl}){
 app.get('/api/reels',async(_req,res)=>{
  res.set('Cache-Control','no-store');
  try{const rows=await Recording.find({deletedAt:null,test:{$ne:true},renders:{$elemMatch:{goal:ECHO_REEL_GOAL,status:'ready',echoPublished:true}}}).select('title renders deletedAt').sort({updatedAt:-1}).limit(100).lean();res.json({items:publicReels(rows,videoUrl)});}
  catch{res.status(503).json({message:'Reels are temporarily unavailable. Please retry.'});}
 });
 app.post('/api/admin/live-recordings/:id/renders/:renderId/echo',requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(![req.params.id,req.params.renderId].every(id=>/^[a-f\d]{24}$/i.test(id))||typeof req.body?.published!=='boolean')return res.status(400).json({message:'Choose a valid render and publication state.'});
  try{
   const row=await Recording.findOne({_id:req.params.id,deletedAt:null}),render=row?.renders.id(req.params.renderId);
   if(!isEchoReel(render))return res.status(409).json({message:'Finish an Echo 9:16 render before publishing to Reels.'});
   const updated=await Recording.findOneAndUpdate({_id:req.params.id,deletedAt:null,renders:{$elemMatch:{_id:req.params.renderId,goal:ECHO_REEL_GOAL,status:'ready',publicId:render.publicId}}},{$set:{'renders.$.echoPublished':req.body.published,'renders.$.echoPublishedAt':req.body.published?new Date():null}},{new:true});
   if(!updated)return res.status(409).json({message:'This render changed. Refresh and try again.'});
   res.json({item:serialize(updated)});
  }catch{res.status(503).json({message:'Publication could not be saved. Refresh and retry.'});}
 });
}
module.exports={ECHO_REEL_GOAL,isEchoReel,publicReels,registerEchoReels};
