// The AI administrator registry calls .strict() on the equipment schemas at server start; a wrapped schema (e.g. .transform) crashes the deploy.
const test = require('node:test');
const assert = require('node:assert/strict');
test('equipment save schemas stay plain object schemas', () => {
  const { createSchema, updateSchema } = require('./equipment');
  assert.equal(typeof createSchema.strict, 'function');
  assert.equal(typeof updateSchema.strict, 'function');
});
