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

function describeRequest(request){
 const internal=describe(request.status),availability=require('./booking-availability').availabilityFor(request);
 if(!TABLE[request.status]||request.status===STATUS.CANCELLED)return {...internal,clientStatus:null,canDiscussAvailability:false};
 const paid=(request.payments||[]).some(p=>!p.voided&&(p.amountCents||0)>0);
 const stage=internal.isBooked?'booked':paid?'deposit_paid':internal.showsPrices?'quote_ready':availability.status==='unavailable'?'unavailable':availability.status==='available'?'available':'requested';
 const display=contract.clientStages[stage];
 const path=contract.clientPath.map(key=>key==='available'&&stage==='unavailable'?'unavailable':key).map(key=>({status:key,...contract.clientStages[key]}));
 return {...internal,...display,clientStatus:stage,path,canDiscussAvailability:stage==='unavailable'&&internal.repriceable&&!(request.payments||[]).some(p=>!p.voided)};
}
// The REAL booking status: one stored key on the booking (requested, available, unavailable, quote_ready, deposit_paid, booked, cancelled), derived from the lifecycle status, availability and payments.
const bookingStatusOf=request=>request.status===STATUS.CANCELLED?'cancelled':(describeRequest(request).clientStatus||'');
module.exports = { STATUS, STATUSES, PATH, PATH_STEPS, rule, statusesWhere, describe, describeRequest, bookingStatusOf };
