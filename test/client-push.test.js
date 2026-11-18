const test = require('node:test');
const assert = require('node:assert/strict');
const { messageFor } = require('../src/client-push');

test('clients are only notified of admin-driven booking changes', () => {
  assert.equal(messageFor({ status: 'quoted' })[0], 'Your quote is ready');
  assert.equal(messageFor({ status: 'confirmed' })[0], 'Booking confirmed');
  assert.equal(messageFor({ status: 'cancelled', declinedBy: 'admin' })[0], 'Request declined');
  assert.equal(messageFor({ status: 'cancelled', declinedBy: 'client' }), null);
  assert.equal(messageFor({ status: 'accepted' }), null);
  assert.equal(messageFor({ status: 'changes_requested' }), null);
});

test('a status change on a saved booking notifies its owner, an unrelated edit does not', async () => {
  const mongoose = require('mongoose');
  const { watchSchema } = require('../src/client-push');
  const calls = [];
  const schema = new mongoose.Schema({ userId: String, status: String, note: String });
  watchSchema(schema, async (user, msg) => calls.push([user, msg.title]));
  const M = mongoose.model('PushProbe', schema);
  const doc = new M({ userId: 'u1', status: 'pending' }); doc.isNew = false; // no database: exercise the hooks directly
  doc.status = 'quoted';
  for (const fn of schema.s.hooks._pres.get('save')) fn.fn.call(doc, () => {});
  for (const fn of schema.s.hooks._posts.get('save')) fn.fn.call(doc, doc, () => {});
  assert.deepEqual(calls, [['u1', 'Your quote is ready']]);
});
