const {ADMIN_USERNAMES}=require('./default-data');

// Older isAdmin flags were advisory. Only an explicit, recorded grant (or the
// existing owner allowlist) authorizes administrator access.
function hasGrantedAdminRole(user){
  return Boolean(user&&user.isAdmin===true&&user.adminGrantedAt&&user.adminGrantedBy);
}
function isAdminUser(user){
  return Boolean(user)&&(ADMIN_USERNAMES.has(String(user.username||'').toLowerCase())||hasGrantedAdminRole(user));
}
module.exports={isAdminUser,hasGrantedAdminRole};
