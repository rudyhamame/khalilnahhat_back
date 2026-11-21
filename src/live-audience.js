const {isAdminUser}=require('./admin-role');
const AUDIENCES=['all','admins','clients','specific'];
// Who may see and watch the current live: everyone, admins only, any signed-in client (admins too), or chosen clients (admins too).
const liveVisibleTo=(config,user)=>{
 const audience=config?.audience||'all';
 if(audience==='all')return true;
 if(!user||user.isBlocked||user.isGuest)return false;// a guest can only watch a live that is open to everyone
 if(isAdminUser(user))return true;
 return audience==='clients'||(audience==='specific'&&(config.audienceUserIds||[]).map(String).includes(String(user._id)));
};
// Reads the audience a go-live request asked for; anything unknown falls back to everyone only for a missing value, never silently widens a bad one.
const audienceFromBody=body=>{
 const audience=AUDIENCES.includes(body?.audience)?body.audience:body?.audience===undefined?'all':'admins';
 const ids=audience==='specific'&&Array.isArray(body.audienceUserIds)?[...new Set(body.audienceUserIds.filter(id=>typeof id==='string'&&/^[a-f0-9]{24}$/i.test(id)))].slice(0,200):[];
 return {audience:audience==='specific'&&!ids.length?'admins':audience,audienceUserIds:ids};
};
module.exports={AUDIENCES,liveVisibleTo,audienceFromBody};
