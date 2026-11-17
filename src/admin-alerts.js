const mongoose=require('mongoose');
// Admin phone alerts. Each kind is a per-admin toggle; payloads are generic (no customer data).
const KINDS={booking:['New booking','A client sent a booking request.'],signup:['New account','A new guest created an account.'],visit:['Website visit','Someone is visiting the website.'],email:['New email','A new email arrived.']};
const DEFAULTS={booking:true,signup:true,visit:false,email:true};
const Pref=mongoose.models.EchoAdminAlertPref||mongoose.model('EchoAdminAlertPref',new mongoose.Schema({_id:String,kinds:{type:Object,default:{}}},{minimize:false}));
let sender=null;const lastVisit={at:0};
const setSender=fn=>{sender=fn;};
const prefs=async owner=>({...DEFAULTS,...((await Pref.findById(owner).lean())?.kinds||{})});
const enabled=async(owner,kind)=>(await prefs(owner))[kind]===true;
// Fire-and-forget: an alert failure must never break the business request that triggered it.
const alert=kind=>{if(!sender||!KINDS[kind])return;Promise.resolve(sender(kind,...KINDS[kind])).catch(()=>{});};
function register(app,{requireAdmin,base='/api/admin/alerts'}){
 app.get(base,requireAdmin,async(req,res)=>res.json({kinds:await prefs(String(req.user._id||req.user.id))}));
 app.put(base,requireAdmin,async(req,res)=>{const kinds={};for(const k of Object.keys(KINDS))if(typeof req.body?.[k]==='boolean')kinds[`kinds.${k}`]=req.body[k];
  const owner=String(req.user._id||req.user.id);await Pref.updateOne({_id:owner},{$set:kinds},{upsert:true});res.json({kinds:await prefs(owner)});});
 // Public beacon; the site sends it once per browser session. Pushes are collapsed to one per minute.
 app.post('/api/visit',(_req,res)=>{if(Date.now()-lastVisit.at>60000){lastVisit.at=Date.now();alert('visit');}res.status(204).end();});
}
module.exports={alert,register,setSender,enabled,KINDS};
