const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteBooking } = require('./quote-lifecycle');

const deps = (log) => ({
  EventBooking: { deleteOne: async (filter) => log.push(['eventBooking', filter]) },
  Meeting: { updateMany: async (filter, patch) => log.push(['meeting', filter, patch.status]) },
  remove: async (filter) => { log.push(['remove', filter]); return { cloudinaryCleanupPending: false }; },
});

test('deleting a booking frees its date and equipment, releases its call and removes it', async () => {
  const log = [];
  const result = await deleteBooking({ externalId: 'ECHO-1', payments: [{ voided: true }] }, deps(log));
  assert.deepEqual(result, { deleted: true, cloudinaryCleanupPending: false });
  assert.deepEqual(log, [['eventBooking', { requestId: 'ECHO-1' }], ['meeting', { bookingRequestId: 'ECHO-1' }, 'open'], ['remove', { externalId: 'ECHO-1' }]]);
});

test('a booking with a recorded payment is refused and nothing is touched', async () => {
  const log = [];
  await assert.rejects(() => deleteBooking({ externalId: 'ECHO-2', payments: [{ voided: false, amountCents: 5000 }] }, deps(log)), (error) => error.status === 409 && /Void them first/.test(error.message));
  assert.deepEqual(log, []);
});
