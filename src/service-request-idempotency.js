const crypto = require('node:crypto');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function fingerprintSubmission(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(payload))).digest('hex');
}

function evaluateSubmissionReplay(existing, fingerprint) {
  if (!existing) return { kind: 'new' };
  if (existing.submissionHash !== fingerprint) return { kind: 'conflict' };
  return { kind: 'replay', item: existing };
}

function isSubmissionDuplicateKey(error) {
  return error?.code === 11000 && Boolean(error.keyPattern?.clientSubmissionId);
}

module.exports = { evaluateSubmissionReplay, fingerprintSubmission, isSubmissionDuplicateKey };
