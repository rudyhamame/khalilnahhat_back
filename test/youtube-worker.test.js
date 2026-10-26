const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');
const { createYoutubeWorker } = require('../src/youtube-worker');
const { convertViaYoutubeWorker } = require('../src/youtube-worker-client');
const key = 'worker-test-credential-'.repeat(3);
const sourceUrl = 'https://youtu.be/abcdefghijk';
const wav = Buffer.alloc(64); wav.write('RIFF'); wav.write('WAVE', 8);
async function setup(t, convert) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-worker-test-'));
  const socketPath = path.join(dir, 'worker.sock'); const keyFile = path.join(dir, 'key');
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  const server = createYoutubeWorker({ key, convert });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  return { socketPath, keyFile, dir };
}
function raw(socketPath, { auth = key, body = { sourceUrl }, method = 'POST', route = '/convert' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method, headers: { Authorization: `Bearer ${auth}` } }, response => {
      const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => resolve({ code: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end(method === 'GET' ? undefined : JSON.stringify(body));
  });
}
test('worker authenticates before conversion; rejects non-YouTube and malformed requests', async t => {
  let calls = 0; const fixture = await setup(t, async () => { calls++; return { buffer: wav }; });
  assert.equal((await raw(fixture.socketPath, { auth: 'wrong' })).code, 401);
  assert.equal((await raw(fixture.socketPath, { body: { sourceUrl: 'http://127.0.0.1/private' } })).code, 400);
  assert.equal((await raw(fixture.socketPath, { body: null })).code, 400);
  assert.equal((await raw(fixture.socketPath, { body: { sourceUrl: 'x'.repeat(5000) } })).code, 413);
  assert.equal(calls, 0);
  const result = await convertViaYoutubeWorker(sourceUrl, fixture);
  assert.deepEqual(result.buffer, wav); assert.equal(calls, 1);
  assert.doesNotMatch((await raw(fixture.socketPath, { method: 'GET', route: '/health' })).body, new RegExp(key));
});
test('private worker bounds concurrency and recovers after a failed download', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let fail = true;
  const fixture = await setup(t, async () => { await gate; if (fail) throw Object.assign(new Error('private diagnostic'), { code: 'YOUTUBE_PUBLIC_ACCESS_BLOCKED' }); return { buffer: wav }; });
  const pending = raw(fixture.socketPath);
  for (let i=0; i<30; i++) {
    const health = JSON.parse((await raw(fixture.socketPath, { method: 'GET', route: '/health' })).body);
    if (health.busy) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await raw(fixture.socketPath)).code, 503);
  release(); const response = await pending;
  assert.equal(response.code, 502); assert.doesNotMatch(response.body, /private diagnostic/);
  fail = false; assert.deepEqual((await convertViaYoutubeWorker(sourceUrl, fixture)).buffer, wav);
});
test('worker client rejects offline, untrusted and malformed audio responses', async t => {
  const fixture = await setup(t, async () => ({ buffer: Buffer.from('not-a-wav') }));
  await assert.rejects(convertViaYoutubeWorker(sourceUrl, fixture), { code: 'YOUTUBE_WORKER_UNAVAILABLE' });
  await assert.rejects(convertViaYoutubeWorker(sourceUrl, { ...fixture, socketPath: path.join(fixture.dir, 'missing.sock') }), { code: 'YOUTUBE_WORKER_UNAVAILABLE' });
  await assert.rejects(convertViaYoutubeWorker(sourceUrl, { ...fixture, keyFile: path.join(fixture.dir, 'missing.key') }), { code: 'YOUTUBE_WORKER_UNAVAILABLE' });
});
test('worker client deadline bounds an unresponsive worker', async t => {
  const fixture = await setup(t, () => new Promise(() => {}));
  await assert.rejects(convertViaYoutubeWorker(sourceUrl, { ...fixture, timeout: 30 }), { code: 'YOUTUBE_WORKER_UNAVAILABLE' });
});
test('configured conversion uses the private worker instead of the hosted downloader or cookies', async t => {
  const fixture = await setup(t, async url => {
    assert.equal(url, 'https://www.youtube.com/watch?v=abcdefghijk');
    return { buffer: wav };
  });
  const names = ['YOUTUBE_WORKER_SOCKET', 'YOUTUBE_WORKER_KEY_FILE', 'YT_DLP_PATH', 'YT_DLP_COOKIES_FILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  process.env.YOUTUBE_WORKER_SOCKET = fixture.socketPath;
  process.env.YOUTUBE_WORKER_KEY_FILE = fixture.keyFile;
  process.env.YT_DLP_PATH = '/not/a/valid/downloader';
  process.env.YT_DLP_COOKIES_FILE = '/not/a/valid/cookie/file';
  const { convertYoutubeToWav } = require('../src/youtube-audio');
  assert.deepEqual((await convertYoutubeToWav(sourceUrl)).buffer, wav);
  process.env.YOUTUBE_WORKER_SOCKET = path.join(fixture.dir, 'offline.sock');
  await assert.rejects(convertYoutubeToWav(sourceUrl), { code: 'YOUTUBE_WORKER_UNAVAILABLE' });
});
