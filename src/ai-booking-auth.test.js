const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAiBookingAuth } = require('./ai-booking-auth');
const TOKEN = 'a'.repeat(64); // sessions are 64 hex characters
async function check(options = {}, authorization = `Bearer ${TOKEN}`) {
  let code, body, advanced = false;
  const req = { headers: authorization === null ? {} : { authorization } };
  const res = { status(value) { code = value; return this; }, json(value) { body = value; return this; } };
  await createAiBookingAuth({ localAuth: async () => null, ...options })(req, res, () => { advanced = true; });
  return { code, body, advanced, user: req.authUser };
}
test('recognizes local sessions, never calling anything external', async () => {
  const result = await check({ localAuth: async () => ({ id: 'local-user' }), fetchImpl: () => { throw Error('must not call'); } });
  assert.equal(result.advanced, true); assert.equal(result.user.id, 'local-user');
});
test('rejects absent, malformed, expired and blocked sessions, and fails closed when the check itself fails', async () => {
  assert.equal((await check({}, null)).code, 401);
  assert.equal((await check({}, '')).code, 401);
  assert.equal((await check({}, 'Bearer unit-session')).code, 401); // not a real session token: never forwarded anywhere
  assert.equal((await check({})).code, 401); // valid shape, unknown session
  assert.equal((await check({ localAuth: async () => ({ id: 'x', isBlocked: true }) })).code, 403);
  assert.equal((await check({ localAuth: async () => { throw Error('database down'); } })).code, 503);
});
test('optional sign-in lets a visitor continue as a guest, but a sent sign-in must still be valid', async () => {
  const guest = await check({ optional: true }, null);
  assert.equal(guest.advanced, true); assert.equal(guest.user, null);
  const wrong = await check({ optional: true }, 'Bearer nope');
  assert.equal(wrong.advanced, false); assert.equal(wrong.code, 401);
  const signedIn = await check({ optional: true, localAuth: async () => ({ id: 'client' }) });
  assert.equal(signedIn.advanced, true); assert.equal(signedIn.user.id, 'client');
});
