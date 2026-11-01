const windows=new Map();
function consumeLiveQuota(user,count=1,clock=Date.now) {
 const now=clock(),key=String(user);let quota=windows.get(key);
 if(!quota||now-quota.start>=60000){quota={start:now,count:0};windows.set(key,quota);}
 if(windows.size>10000)for(const [id,value] of windows)if(now-value.start>=60000)windows.delete(id);
 if(quota.count+count>5)return false;quota.count+=count;return true;
}
module.exports={consumeLiveQuota};
