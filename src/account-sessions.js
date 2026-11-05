const {createHash}=require('node:crypto');
const {createSessionToken}=require('./security');

// One independently rotated slot per administrator client. Client labels never grant a role.
function sessionField(user,request,isAdminUser) {
 return isAdminUser(user)&&String(request.headers?.['x-echo-client']||'').toLowerCase()==='android'?'androidSessionToken':'sessionToken';
}
async function issueSession(user,request,isAdminUser) {
 const token=createSessionToken();user[sessionField(user,request,isAdminUser)]=token;
 if(isAdminUser(user))user.lastLoginAt=new Date();
 await user.save();return token;
}
function sessionQuery(token) {return {$or:[{sessionToken:token},{androidSessionToken:token}]};}
function sessionActor(user,token) {return {...(user.toObject?user.toObject():user),id:String(user._id||user.id),sessionToken:token};}
function selectSession(user,token,binding) {
 if(!user||user.isBlocked)return null;
 const tokens=[user.sessionToken,user.androidSessionToken].filter(Boolean);
 return tokens.find(value=>token?value===token:binding?createHash('sha256').update(value).digest('hex')===binding:true)||null;
}
async function revokeSession(User,user,token) {
 // Conditional field updates cannot clear a replacement login or the other client session.
 const field=user.androidSessionToken===token?'androidSessionToken':'sessionToken';
 await User.updateOne({_id:user._id,[field]:token},{$set:{[field]:''}});
}
module.exports={sessionField,issueSession,sessionQuery,sessionActor,selectSession,revokeSession};
