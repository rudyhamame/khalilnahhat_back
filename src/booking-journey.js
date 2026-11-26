// The ONE place that says what each booking-request status means. The data lives in contracts/booking-journey.json;
// this module only loads it and answers questions. Every other file asks this module; none may repeat a status list
// or compare against a lifecycle status literal (src/booking-journey.test.js fails the build if one does).
const contract = require('../contracts/booking-journey.json');

const STATUSES = Object.freeze(Object.keys(contract.statuses));
const STATUS = Object.freeze(Object.fromEntries(STATUSES.map(status => [status.toUpperCase(), status])));

// Unknown or missing status: every fact closed, so nothing is allowed by accident.
const CLOSED = Object.freeze({
  ...Object.fromEntries(Object.keys(contract.facts).map(fact => [fact, false])),
  label: '', labelAr: '', step: null, clientNext: 'none', adminNext: 'none',
});

const TABLE = Object.freeze(Object.fromEntries(STATUSES.map(status => {
  const { facts, label, labelAr, step, clientNext, adminNext } = contract.statuses[status];
  return [status, Object.freeze({ ...CLOSED, ...Object.fromEntries(facts.map(fact => [fact, true])), label, labelAr, step, clientNext, adminNext })];
})));

// The path a healthy booking follows. `draft` exists only in the client's browser, before a request is submitted.
const PATH = Object.freeze(['draft', ...contract.path]);
const PATH_STEPS = Object.freeze(contract.path.map(status => Object.freeze({ status, label: TABLE[status].label, labelAr: TABLE[status].labelAr })));

const rule = status => TABLE[status] || CLOSED;
const statusesWhere = fact => STATUSES.filter(status => TABLE[status][fact] === true);
// What the API sends with each request so no client re-derives these facts.
const describe = status => ({ status, ...rule(status), path: PATH_STEPS });

// The steps beside the main path: the client's two parallel decisions after the quote, and a cancellation by the client at ANY step.
function branchesOf(request,stage){
 const stages=contract.clientStages,decisions=contract.branches.decisions.stages;
 const paid=(request.payments||[]).some(p=>!p.voided&&(p.amountCents||0)>0),booked=Boolean(request.acceptedAt)||paid||rule(request.status).isBooked;
 // A decision belongs to the quote: it only counts while a quote is out (or the booking moved past it), so a quote withdrawn by a step back shows no stale decision.
 const quoteOut=rule(request.status).showsPrices||paid||booked||request.status===STATUS.CANCELLED;
 const reached={quote_accepted:booked||request.status===STATUS.ACCEPTED,best_offer_requested:quoteOut&&(Boolean(request.changeRequestedAt)||request.status===STATUS.CHANGES_REQUESTED)};
 const cancelled=request.status===STATUS.CANCELLED&&request.declinedBy==='client';
 return {after:contract.branches.decisions.after,decisions:decisions.map(key=>({status:key,...stages[key],reached:Boolean(reached[key])})),
  cancelled:cancelled?{status:contract.branches.cancel.stage,...stages[contract.branches.cancel.stage],afterStage:({modified:'requested',unavailable:'available'})[request.cancelledAtStage||stage]||request.cancelledAtStage||stage||'requested'}:null};
}
function describeRequest(request){
 const internal=describe(request.status),availability=require('./booking-availability').availabilityFor(request);
 if(!TABLE[request.status]||request.status===STATUS.CANCELLED)return {...internal,clientStatus:null,canDiscussAvailability:false,clientCancellable:false,branches:TABLE[request.status]?branchesOf(request,''):null,...(request.declinedBy==='client'?{path:contract.clientPath.map(key=>({status:key,...contract.clientStages[key]}))}:{})};
 const paid=(request.payments||[]).some(p=>!p.voided&&(p.amountCents||0)>0);
 let stage=internal.isBooked?'booked':paid?'deposit_paid':internal.showsPrices?'quote_ready':availability.status==='unavailable'?'unavailable':availability.status==='available'?'available':'requested';
 // Any client edit puts the booking in "Booking modified" until the team acts on it again (confirms availability or sends a quote); never once paid or booked.
 const lastAdminAction=Math.max(0,...[request.availabilityAcceptedAt,request.availabilityUnavailableAt,request.quotedAt].map(d=>d?new Date(d).getTime():0));
 let previous=null,previousKey=null; // the status the booking had before the client's edit replaced it, so the app can still show it
 if(request.modifiedAt&&!paid&&!internal.isBooked&&new Date(request.modifiedAt).getTime()>lastAdminAction){previous=contract.clientStages[stage];previousKey=stage;stage='modified';}
 const display=contract.clientStages[stage];
 const path=contract.clientPath.map(key=>key==='available'&&stage==='unavailable'?'unavailable':key==='requested'&&stage==='modified'?'modified':key).map(key=>({status:key,...contract.clientStages[key]}));
 return {...internal,...display,clientCancellable:internal.cancellable&&request.status!==STATUS.EXPIRED,clientStatus:stage,previousClientStatus:previousKey,previousLabel:previous?.label||null,previousLabelAr:previous?.labelAr||null,path,branches:branchesOf(request,stage),canDiscussAvailability:stage==='unavailable'&&internal.repriceable&&!(request.payments||[]).some(p=>!p.voided)};
}
// The REAL booking status: one stored key on the booking (requested, available, unavailable, quote_ready, deposit_paid, booked, cancelled), derived from the lifecycle status, availability and payments.
const bookingStatusOf=request=>request.status===STATUS.CANCELLED?'cancelled':(describeRequest(request).clientStatus||'');
module.exports = { STATUS, STATUSES, PATH, PATH_STEPS, rule, statusesWhere, describe, describeRequest, bookingStatusOf };
