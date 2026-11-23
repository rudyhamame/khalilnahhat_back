const test = require('node:test');
const assert = require('node:assert/strict');
const { createDistance, haversineKm } = require('./admin-distance');

test('straight-line distance is right and symmetric', () => {
  const toronto = { latitude: 43.6532, longitude: -79.3832 }, ottawa = { latitude: 45.4215, longitude: -75.6972 };
  assert.ok(Math.abs(haversineKm(toronto, ottawa) - 352) < 6);
  assert.equal(haversineKm(toronto, toronto), 0);
  assert.ok(Math.abs(haversineKm(toronto, ottawa) - haversineKm(ottawa, toronto)) < 1e-9);
});

test('an address is looked up once and then served from the cache', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => [{ lat: '43.7', lon: '-79.4', display_name: 'Somewhere, Toronto' }] }; };
  const distance = createDistance({ fetchImpl, wait: async () => {} });
  const first = await distance.geocode('155 Consumers Road, Toronto');
  const second = await distance.geocode('  155 consumers road,  Toronto ');
  assert.deepEqual([first.latitude, first.longitude], [43.7, -79.4]);
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test('an unknown address gives null, and the road distance falls back to the straight line', async () => {
  const fetchImpl = async (url) => String(url).includes('nominatim') ? { ok: true, json: async () => [] } : { ok: false };
  const distance = createDistance({ fetchImpl, wait: async () => {} });
  assert.equal(await distance.geocode('nowhere at all'), null);
  const result = await distance.between({ latitude: 43.65, longitude: -79.38 }, { latitude: 43.7, longitude: -79.4 });
  assert.equal(result.driving, false);
  assert.ok(result.km > 5 && result.km < 7);
});

test('the venue uses its saved map pin before any lookup', async () => {
  const distance = createDistance({ fetchImpl: async () => { throw new Error('no lookup expected'); }, wait: async () => {} });
  assert.deepEqual(await distance.venuePoint({ event: { venue: { latitude: 43.7, longitude: -79.4, name: 'Hall' } } }), { latitude: 43.7, longitude: -79.4 });
});

test('a place search returns clean suggestions and is cached', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => [{ display_name: 'Lara\'s Restaurant, Toronto', lat: '43.77', lon: '-79.5' }, { display_name: '', lat: '1', lon: '2' }, { display_name: 'Bad', lat: 'x', lon: '2' }] }; };
  const distance = createDistance({ fetchImpl, wait: async () => {} });
  const first = await distance.search('lara restaurant');
  assert.deepEqual(first, [{ label: "Lara's Restaurant, Toronto", latitude: 43.77, longitude: -79.5 }]);
  assert.equal(await distance.search(' Lara  restaurant '), first);
  assert.equal(calls, 1);
});
