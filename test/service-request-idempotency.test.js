const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSubmissionReplay, fingerprintSubmission, isSubmissionDuplicateKey } = require('../src/service-request-idempotency');

test('submission fingerprints ignore object key order but change when booking details change',()=>{
  const first={order:{event:{eventDate:'2027-06-01',venue:{name:'Hall'}},services:['dj']},items:[{serviceId:'dj',quantity:1}],voucherCode:''};
  const reordered={voucherCode:'',items:[{quantity:1,serviceId:'dj'}],order:{services:['dj'],event:{venue:{name:'Hall'},eventDate:'2027-06-01'}}};
  assert.equal(fingerprintSubmission(first),fingerprintSubmission(reordered));
  assert.notEqual(fingerprintSubmission(first),fingerprintSubmission({...first,order:{...first.order,event:{...first.order.event,eventDate:'2027-06-02'}}}));
});

test('matching retries replay the original request; changed payloads conflict',()=>{
  const saved={id:'request-1',submissionHash:fingerprintSubmission({eventDate:'2027-06-01'})};
  assert.equal(evaluateSubmissionReplay(saved,fingerprintSubmission({eventDate:'2027-06-01'})).kind,'replay');
  assert.equal(evaluateSubmissionReplay(saved,fingerprintSubmission({eventDate:'2027-06-02'})).kind,'conflict');
  assert.equal(evaluateSubmissionReplay(null,'hash').kind,'new');
});

test('only a duplicate idempotency index collision is classified as a retry race',()=>{
  assert.equal(isSubmissionDuplicateKey({code:11000,keyPattern:{clientSubmissionId:1}}),true);
  assert.equal(isSubmissionDuplicateKey({code:11000,keyPattern:{externalId:1}}),false);
  assert.equal(isSubmissionDuplicateKey(new Error('database unavailable')),false);
});
