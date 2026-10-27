// Email login must identify exactly one account; never select an arbitrary duplicate.
async function findPasswordAccount(User, {email, username}) {
  if (email) {
    const escaped=email.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const users=await User.find({email:new RegExp(`^${escaped}$`,'i')}).limit(2);
    return users.length===1 ? users[0] : null;
  }
  return User.findOne({username:username.trim().toLowerCase()});
}
module.exports={findPasswordAccount};
