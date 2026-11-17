const test = require('node:test');
const assert = require('node:assert/strict');
const journey = require('./booking-journey');
const { summarize, createJourneyLoader } = require('./booking-journey-summary');
const { createBookingData } = require('./ai-booking-data');

// A request exactly as the dashboard's serializer sends it, including personal details the AI must never receive.
const serialized = (status, extra = {}) => ({
  id: 'req-1', requestNumber: 'ECHO-1', status, journey: journey.describe(status),
  customerName: 'Private Person', customerEmail: 'private@example.invalid', customerUsername: 'private',
  event: { eventType: 'wedding', eventDate: '2099-06-20', startTime: '18:00', endTime: '23:00' },
  order: { customer: { phone: '555-0100' }, event: { guestCount: 120 } },
  items: [{ name: 'DJ Khalil', quantity: 1, unitPrice: 900 }], currency: 'CAD',
  total: 1000, deposit: 300, balance: 700, expiresAt: '2099-01-01T00:00:00.000Z', depositPaidCents: 0, changeRequest: '', planning: null, ...extra,
});

test('the summary carries the journey facts and the event, and nothing personal', () => {
  const text = JSON.stringify(summarize(serialized('quoted')));
  assert.doesNotMatch(text, /private@example|Private Person|555-0100|customerEmail|customerName/);
  const summary = summarize(serialized('quoted'));
  assert.equal(summary.journey.label, 'Quote ready');
  assert.equal(summary.journey.awaitingClient, true);
  assert.equal(summary.journey.isBooked, false);
  assert.equal(summary.event.date, '2099-06-20');
  assert.equal(summary.event.guestCount, 120);
});

test('prices appear exactly when the dashboard would show them', () => {
  for (const status of journey.STATUSES) {
    const summary = summarize(serialized(status));
    assert.equal(summary.quote !== null, journey.rule(status).showsPrices, status);
  }
  assert.deepEqual(summarize(serialized('quoted')).quote, { currency: 'CAD', total: 1000, deposit: 300, balance: 700, validUntil: '2099-01-01T00:00:00.000Z' });
});

test('a date counts as reserved only for a booked request', () => {
  for (const status of journey.STATUSES) assert.equal(summarize(serialized(status)).journey.isBooked, status === journey.STATUS.CONFIRMED, status);
});

test('the loader can only ask for the signed-in owner’s requests', async () => {
  const asked = [];
  const Model = { find(query) { asked.push(query); return { sort: () => ({ limit: async () => [{ row: 1 }] }) }; } };
  const load = createJourneyLoader({ Model, serialize: () => serialized('pending') });
  assert.equal((await load('user-7')).length, 1);
  assert.deepEqual(asked, [{ userId: 'user-7' }]);
  assert.deepEqual(await load(''), []);
  assert.deepEqual(await load(null), []);
  assert.equal(asked.length, 1, 'no owner means no query at all');
});

test('booking data includes the owner’s journey and passes the owner through; failure is reported, not guessed', async () => {
  const seen = [];
  const base = { loadVouchers:async()=>({available:[],selected:null}), loadAvailability: async () => ({}), loadCatalog: async () => [], loadEquipment: async () => [], loadPrices: async () => [] };
  const year = new Date().getUTCFullYear();
  const ok = await createBookingData({ ...base, loadJourney: async owner => { seen.push(owner); return [{ id: 'req-1' }]; } })(year, { owner: 'user-7' });
  assert.deepEqual(seen, ['user-7']);
  assert.deepEqual(ok.journey, { status: 'ready', data: [{ id: 'req-1' }] });
  const failed = await createBookingData({ ...base, loadJourney: async () => { throw new Error('db down'); } })(year, { owner: 'user-7' });
  assert.deepEqual(failed.journey, { status: 'unavailable', data: null });
  assert.equal(failed.reserved, false);
});
