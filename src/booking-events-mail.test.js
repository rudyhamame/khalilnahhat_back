const assert = require('node:assert'), { test } = require('node:test');
const { notifyBooking } = require('./booking-events-mail');
const { catalog, validate } = require('./notification-emails');

const sr = { customerName: 'Alex', customerEmail: 'alex@example.com', externalId: 'ECHO-1', requestNumber: 'ECHO-1', event: { eventDate: '2099-01-01', startTime: '18:00', endTime: '23:00' } };
const rule = (id) => ({ ...catalog.find((item) => item.id === id), enabled: true, revision: 0 });

test('every journey email has a valid template (known variables, essential parts present)', () => {
  const events = catalog.filter((event) => event.id.startsWith('booking-'));
  assert.ok(events.length >= 20);
  for (const event of events) {
    assert.doesNotThrow(() => validate(event.id, { revision: 0, enabled: true, subject: event.subject, body: event.body, imageUrl: '', leadHours: null }), event.id);
  }
});

test('notifyBooking: customer emails go to the client, admin emails to the admin address, disabled ones are skipped, failures never throw', async () => {
  const sent = [];
  const send = async (payload) => { sent.push(payload); return { sent: true }; };
  const notifications = { get: async (id) => rule(id) };
  await notifyBooking(sr, 'booking-quote-accepted', {}, { notifications, send });
  assert.equal(sent[0].to[0].email, 'alex@example.com');
  assert.match(sent[0].subject, /Quote accepted/);
  assert.deepEqual(sent[0].tags, ['booking-quote-accepted']);
  await notifyBooking(sr, 'booking-changes-requested-admin', { message: 'Add a speaker' }, { notifications, send });
  assert.notEqual(sent[1].to[0].email, 'alex@example.com');
  assert.match(sent[1].textContent, /Add a speaker/);
  const off = await notifyBooking(sr, 'booking-cancelled', {}, { notifications: { get: async (id) => ({ ...rule(id), enabled: false }) }, send });
  assert.equal(off.disabled, true);
  assert.equal(sent.length, 2);
  const failed = await notifyBooking(sr, 'booking-cancelled', {}, { notifications, send: async () => { throw new Error('mail down'); } });
  assert.equal(failed.sent, false);
});
