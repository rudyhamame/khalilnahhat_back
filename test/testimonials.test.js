const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerContent, Testimonial } = require('../src/content');

test('testimonial replies validate, persist server timestamps and require admin middleware', async (t) => {
  const routes = {};
  const admin = () => {};
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map((method) => [method, (path, ...handlers) => { routes[`${method} ${path}`] = handlers; }]));
  registerContent(app, admin);
  const handlers = routes['patch /api/content/testimonials/:id'];
  assert.equal(handlers[0], admin);
  let saved;
  t.mock.method(Testimonial, 'findByIdAndUpdate', async (id, update, options) => {
    saved = { id, update, options };
    return { id, toObject: () => ({ name: 'Client', text: 'Wonderful evening', ...update.$set }) };
  });
  const call = async (body) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers[1]({ params: { id: 'review-one' }, body }, res);
    return res;
  };
  const result = await call({ reply: ' Thank you! ', repliedAt: '2000-01-01' });
  assert.equal(result.body.item.reply, 'Thank you!');
  assert.ok(saved.update.$set.repliedAt instanceof Date);
  assert.equal(saved.options.runValidators, true);
  await call({ isPublished: false });
  assert.equal(Object.hasOwn(saved.update.$set, 'repliedAt'), false);
  await call({ reply: '' });
  assert.equal(saved.update.$set.repliedAt, null);
  assert.equal((await call({ reply: 'x'.repeat(2001) })).code, 400);
  assert.equal((await call({ reply: { text: 'invalid' } })).code, 400);
  assert.equal((await call({ reply: { $set: 'invalid' } })).code, 400);
  assert.equal(routes['post /api/content/testimonials'][0], admin);
});

test('public testimonials return only published reviews with saved responses', async (t) => {
  const routes = {};
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map((method) => [method, (path, ...handlers) => { routes[`${method} ${path}`] = handlers; }]));
  registerContent(app, () => {});
  let query;
  t.mock.method(Testimonial, 'find', (filter) => { query = filter; return { sort: async () => [{ id: 'one', toObject: () => ({ name: 'Client', text: 'Review', reply: 'Thank you', isPublished: true }) }] }; });
  const res = { json(body) { this.body = body; } };
  await routes['get /api/content/testimonials'][0]({}, res);
  assert.deepEqual(query, { isPublished: true });
  assert.equal(res.body.items[0].reply, 'Thank you');
});
