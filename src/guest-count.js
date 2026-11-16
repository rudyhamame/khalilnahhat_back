// A client who states "120 guests" must never lose that number to a model that forgot to return it.
// Only an exact whole number next to a guest word counts; ranges ("100-150", "about 100 to 120") are left to the model.
const WORD='(?:guests?|people|persons|attendees|adults)';
function explicitGuestCount(text){
 const s=String(text||'').toLowerCase().replace(/,/g,'');
 if(new RegExp(`\\d+\\s*(?:-|–|to|or)\\s*\\d+\\s*${WORD}`).test(s))return null;
 const found=[...s.matchAll(new RegExp(`\\b(\\d{1,5})\\s*${WORD}\\b`,'g'))].map(match=>Number(match[1])).filter(n=>n>0);
 return found.length===1?found[0]:null;
}
function withGuestCount(parsed,message,order){
 const count=explicitGuestCount(message);
 if(!count||!Array.isArray(parsed?.orderPatch)||parsed.orderPatch.some(item=>item.path==='event.guestCount'))return parsed;
 if(String(order?.['event.guestCount']??'')===String(count))return parsed;
 return {...parsed,orderPatch:[...parsed.orderPatch,{path:'event.guestCount',value:String(count)}]};
}
module.exports={explicitGuestCount,withGuestCount};
