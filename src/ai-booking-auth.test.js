const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAiBookingAuth } = require('./ai-booking-auth');
async function check(options = {}, authorization = 'Bearer unit-session') {
  let code, body, advanced = false;
  const req = { headers: { authorization } };
  const res = { status(value) { code = value; return this; }, json(value) { body = value; return this; } };
  await createAiBookingAuth({ localAuth: async () => null, ...options })(req, res, () => { advanced = true; });
  return { code, body, advanced, user: req.authUser };
}
test('recognizes local sessions without an external check', async () => {
  const result = await check({ localAuth: async () => ({ id: 'local-user' }), fetchImpl: () => { throw Error('must not call'); } });
  assert.equal(result.advanced, true); assert.equal(result.user.id, 'local-user');
});
test('recognizes the existing Render session when it is absent locally', async () => {
  const result = await check({ fetchImpl: async (url, options) => {
    assert.equal(url, 'https://echo-khalil-api.onrender.com/api/auth/me');
    assert.equal(options.headers.Authorization, 'Bearer unit-session');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ user: { id: 'render-user', email: 'not-forwarded@example.test' } }));
  } });
  assert.equal(result.advanced, true); assert.deepEqual(result.user, { id: 'render-user' });
});
test('rejects expired or absent sessions and fails closed on upstream outages', async () => {
  assert.equal((await check({}, '')).code, 401);
  assert.equal((await check({ fetchImpl: async () => new Response(null, { status: 401 }) })).code, 401);
  assert.equal((await check({ fetchImpl: async () => new Response(null, { status: 500 }) })).code, 503);
  const malformed = await check({ fetchImpl: async () => new Response(JSON.stringify({ user: null })) });
  assert.equal(malformed.advanced, false); assert.equal(malformed.code, 401);
});
