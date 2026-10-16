const test = require('node:test');
const assert = require('node:assert/strict');
const { eventSchema, normalizeQuoteItems, validDate } = require('../src/quote-validation');
const { isExpired, quoteTotals } = require('../src/quote-lifecycle');
const event = { eventType: 'wedding', eventDate: '2099-10-12', phone: '4165550100' };
test('event dates reject calendar rollover, past dates and malformed times', () => {
  assert.equal(validDate('2099-02-30'), false);
  assert.equal(eventSchema.safeParse({ ...event, eventDate: '2020-01-01' }).success, false);
  assert.equal(eventSchema.safeParse({ ...event, startTime: '25:00' }).success, false);
  assert.equal(eventSchema.safeParse(event).success, true);
});
test('all quotation details survive parsing', () => {
  const value = { ...event, setupRequirements: 'Load-in elevator', otherMusic: 'Dabke', djMc: 'Arabic MC', entrance: 'Entrance', customMix: 'Custom', announcements: 'Cake cutting' };
  const result = eventSchema.parse(value);
  for (const key of ['setupRequirements', 'otherMusic', 'djMc', 'entrance', 'customMix', 'announcements']) assert.equal(result[key], value[key]);
});
const catalog = [{ slug: 'uplights', name: 'Uplights', category: 'lighting', minQuantity: 10, isActive: true }];
test('quote equipment minimums and identity are enforced on the server', () => {
  const item = { serviceId: 'uplights', name: 'forged', category: 'forged', quantity: 10 };
  assert.deepEqual(normalizeQuoteItems([item], catalog), [{ serviceId: 'uplights', name: 'Uplights', category: 'lighting', quantity: 10 }]);
  assert.throws(() => normalizeQuoteItems([{ ...item, quantity: 1 }], catalog), /minimum/);
  assert.throws(() => normalizeQuoteItems([{ ...item, quantity: 10.5 }], catalog), /minimum/);
  assert.throws(() => normalizeQuoteItems([item], []), /no longer available/);
  assert.throws(() => normalizeQuoteItems([item, item], catalog), /only once/);
});
test('an accepted quote must still be valid before deposit recording', () => {
  const past = new Date(Date.now() - 1000);
  assert.equal(isExpired({ status: 'accepted', expiresAt: past }), true);
  assert.equal(isExpired({ status: 'confirmed', expiresAt: past }), false);
  assert.equal(isExpired({ status: 'accepted', expiresAt: new Date(Date.now() + 10000) }), false);
});
test('quote totals preserve quantities, tax and deposit limit', () => {
  assert.deepEqual(quoteTotals({ items: [{ unitPrice: 35, quantity: 10 }], taxPercent: 13, depositAmount: 100 }), { subtotal: 350, taxPercent: 13, tax: 45.5, total: 395.5, deposit: 100, balance: 295.5 });
});
