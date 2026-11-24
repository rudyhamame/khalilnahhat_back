const windowFor=sr=>{const event=sr.order?.event||{},legacy=sr.event||{};return {date:event.date||legacy.eventDate||'',startTime:event.startTime||legacy.startTime||'',endTime:event.endTime||legacy.endTime||'',timezone:event.timezone||legacy.timezone||'America/Toronto'};};
const windowKey=sr=>JSON.stringify(windowFor(sr));
function availabilityFor(sr){
 const current=!sr.availabilityWindow||sr.availabilityWindow===windowKey(sr);
 const status=current&&sr.availabilityAcceptedAt?'available':current&&sr.availabilityUnavailableAt?'unavailable':'pending';
 return {status,reason:status==='unavailable'?sr.availabilityReason||'':'',informedAt:status==='available'?sr.availabilityAcceptedAt:status==='unavailable'?sr.availabilityUnavailableAt:null};
}
function requireAvailability(sr){if(availabilityFor(sr).status!=='available')throw Object.assign(Error('Inform the customer of availability before publishing the quote.'),{status:409,code:'AVAILABILITY_REQUIRED'});}
module.exports={windowFor,windowKey,availabilityFor,requireAvailability};
