const test = require('node:test'), assert = require('node:assert/strict');
const { parse } = require('./account-avatar');
const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
test('accepts a real JPEG data URL', () => assert.equal(parse(jpeg).type, 'image/jpeg'));
test('rejects wrong magic bytes, other types and oversized data', () => {
  assert.equal(parse('data:image/jpeg;base64,' + Buffer.from('not an image').toString('base64')), null);
  assert.equal(parse('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), null);
  assert.equal(parse('data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(151 * 1024)]).toString('base64')), null);
});
