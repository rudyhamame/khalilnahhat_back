const mongoose=require('mongoose');
const {createHash}=require('node:crypto');
// A one-way deletion marker contains no owner ID, draft ID, order or transcript.
// It only prevents delayed requests from recreating data the client deleted.
const schema=new mongoose.Schema({_id:String},{versionKey:false});
const DeletedEventDraft=mongoose.models.DeletedEventDraft||mongoose.model('DeletedEventDraft',schema);
const key=(owner,draftId)=>createHash('sha256').update(JSON.stringify([String(owner),draftId])).digest('hex');
async function isDeleted(owner,draftId){return Boolean(await DeletedEventDraft.exists({_id:key(owner,draftId)}));}
async function retire(owner,draftId){try{await DeletedEventDraft.updateOne({_id:key(owner,draftId)},{$setOnInsert:{_id:key(owner,draftId)}},{upsert:true});}catch(error){if(error.code!==11000)throw error;}}
module.exports={isDeleted,retire};
