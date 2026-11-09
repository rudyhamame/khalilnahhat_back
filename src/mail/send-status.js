const {fail}=require('./validation');
async function sendStatus(store,owner,requestId){
 if(!store.sendStatus)throw fail(503,'Send status is unavailable. Update the mail service before retrying.');
 const row=await store.sendStatus(owner,requestId);
 if(!row)return {sendState:'not_submitted',sent:false};
 if(row.state==='sent')return {sendState:'sent',sent:true,messageId:String(row.messageId||row._id)};
 if(row.state==='failed')return {sendState:'not_sent',sent:false};
 return {sendState:row.state==='pending'?'pending':'uncertain',sent:false};
}
module.exports={sendStatus};
