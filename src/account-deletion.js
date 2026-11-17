const {isAdminUser}=require('./admin-role');
function createAccountDeletion({User,EventDraft,Conversation,SimulationDraft,retire,assets}){
 return async user=>{
  if(user.isAdmin===true||isAdminUser(user))throw Object.assign(new Error('Administrator accounts cannot be deleted from the client dashboard.'),{status:403});
  const owner=String(user._id||user.id);
  const draft=await EventDraft.findById(owner).lean();
  const conversations=await Conversation.find({owner}).lean();
  // Record upload cleanup before removing references. Shared booking files stay referenced.
  const keys=await assets.prepare({draft,conversations});
  const ids=new Set([draft?.draftId,...conversations.map(item=>item._id)].filter(Boolean));
  for(const id of ids)await retire(owner,id);
  await EventDraft.deleteOne({_id:owner});
  await Conversation.deleteMany({owner});
  await SimulationDraft.deleteOne({_id:owner});
  // Removing the user invalidates every browser/mobile session and reset/verification token.
  const removed=await User.deleteOne({_id:user._id||user.id,isAdmin:{$ne:true}});
  if(removed.deletedCount!==1)throw Object.assign(new Error('Account deletion could not be confirmed. Please retry.'),{status:409});
  let pending=true;
  try{pending=(await assets.finish(keys)).pending;}catch{/* Cleanup intent was persisted before deletion. */}
  return {deleted:true,cloudinaryCleanupPending:pending};
 };
}
function registerAccountDeletion(app,{requireAuth,deleteAccount}){
 app.delete('/api/auth/account',requireAuth,async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(req.body?.confirmation!=='DELETE')return res.status(400).json({message:'Confirm that you want to permanently delete your account.'});
  if(req.authUser?.isAdmin===true||isAdminUser(req.authUser))return res.status(403).json({message:'Administrator accounts cannot be deleted from the client dashboard.'});
  try{return res.json(await deleteAccount(req.authUser));}
  catch(error){return res.status([403,409].includes(error.status)?error.status:503).json({message:error.status===403||error.status===409?error.message:'Your account could not be deleted. Please retry.'});}
 });
}
module.exports={createAccountDeletion,registerAccountDeletion};
