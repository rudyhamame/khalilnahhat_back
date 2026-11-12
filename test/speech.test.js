const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerSpeechRelay } = require('../src/speech-relay');
const { toFloat } = require('../src/speech-worker');

test('PCM bytes become floats in [-1, 1]', () => {
  const buf = Buffer.alloc(4); buf.writeInt16LE(16384, 0); buf.writeInt16LE(-32768, 2);
  assert.deepEqual([...toFloat(buf)], [0.5, -1]);
});

test('the relay forwards one clip to the worker with the token and refuses bad uploads', async () => {
  const calls = [];
  const app = express();
  registerSpeechRelay(app, {
    requireAdmin: (req, res, next) => (req.headers['x-admin'] ? next() : res.sendStatus(401)),
    env: { STEM_WORKER_URL: 'https://worker.test', STEM_WORKER_TOKEN: 't'.repeat(32) },
    fetchImpl: async (url, options) => { calls.push({ url: String(url), auth: options.headers.Authorization, size: options.body.length }); return new Response(JSON.stringify({ ranked: [{ code: 'ar', probability: 0.9 }] }), { status: 200 }); },
  });
  const server = app.listen(0), base = `http://127.0.0.1:${server.address().port}/api/admin/music-archive/speech/language`;
  try {
    const post = (headers, body) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body });
    assert.equal((await post({}, Buffer.alloc(4000))).status, 401);
    assert.equal((await post({ 'x-admin': '1' }, Buffer.alloc(10))).status, 400);
    const ok = await post({ 'x-admin': '1' }, Buffer.alloc(4000));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ranked[0].code, 'ar');
    assert.deepEqual(calls, [{ url: 'https://worker.test/api/admin/speech/language', auth: `Bearer ${'t'.repeat(32)}`, size: 4000 }]);
  } finally { server.close(); }
});

test('worker load: idle is fine, busy CPU, low memory or a running split asks to retry later', () => {
  const { snapshot } = require('../src/worker-load');
  assert.equal(snapshot({ load: 0.3, cpus: 2, free: 2000 }).busy, false);
  assert.match(snapshot({ load: 3, cpus: 2, free: 2000 }).reason, /CPU is busy/);
  assert.match(snapshot({ load: 0.1, cpus: 2, free: 200 }).reason, /memory is low/);
  assert.match(snapshot({ separating: true, load: 0.1, cpus: 2, free: 2000 }).reason, /split into channels/);
});
