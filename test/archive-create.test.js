const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { createArchiveHandler } = require('../src/archive-create');
const { normalizeYoutubeUrl, isYoutubeUrl } = require('../src/youtube-audio');
const source = 'https://youtu.be/abcdefghijk';
const schema = z.object({
  title: z.string().min(1), category: z.string().min(1), audioUrl: z.string().default(''),
  youtubeUrl: z.string().default('').refine(value => !value || isYoutubeUrl(value)),
});
function fixture(overrides = {}) {
  const calls = [];
  const handler = createArchiveHandler({ schema,
    convert: async url => { calls.push(['convert', url]); return { buffer: Buffer.from('wav'), fileName: 'source.wav' }; },
    upload: async file => { assert.equal(file.mimetype, 'audio/wav'); return { public_id: 'audio/123', secure_url: 'https://media.example/audio.wav' }; },
    removeUpload: async id => calls.push(['remove', id]),
    create: async data => { calls.push(['create', data]); return data; }, serialize: data => data,
    ...overrides,
  });
  async function invoke(body = { title: 'Track', category: 'Original', youtubeUrl: source }) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body }, response);
    return response;
  }
  return { calls, invoke };
}
test('YouTube URLs are restricted to individual HTTP(S) videos and normalized', () => {
  for (const url of [source, 'https://music.youtube.com/watch?v=abcdefghijk&list=playlist', 'https://www.youtube.com/shorts/abcdefghijk']) {
    assert.equal(normalizeYoutubeUrl(url), 'https://www.youtube.com/watch?v=abcdefghijk');
  }
  for (const url of ['file://youtube.com/watch?v=abcdefghijk', 'https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://evil.youtube.com/watch?v=abcdefghijk', 'https://user@youtube.com/watch?v=abcdefghijk', 'https://youtube.com/playlist?list=123', 'https://youtu.be/invalid']) {
    assert.equal(isYoutubeUrl(url), false, url);
  }
});
test('converts and uploads audio before creating an archive record', async () => {
  const { calls, invoke } = fixture();
  const response = await invoke();
  assert.equal(response.statusCode, 201);
  assert.equal(calls[0][0], 'convert');
  assert.equal(response.body.item.audioUrl, 'https://media.example/audio.wav');
  assert.equal(response.body.item.audioPublicId, 'audio/123');
  assert.equal(response.body.item.audioOriginalName, 'Track.wav');
  assert.equal('youtubeUrl' in response.body.item, false);
});
test('invalid or conflicting sources never convert or save', async () => {
  const { calls, invoke } = fixture();
  for (const body of [
    { title: 'Track', category: 'Original', youtubeUrl: 'https://example.com/a' },
    { title: 'Track', category: 'Original', youtubeUrl: source, audioUrl: 'https://media.example/a.wav' },
    { title: '', category: 'Original', youtubeUrl: source },
  ]) assert.equal((await invoke(body)).statusCode, 400);
  assert.deepEqual(calls, []);
});
test('ordinary file-backed tracks keep the existing create flow', async () => {
  const { calls, invoke } = fixture();
  assert.equal((await invoke({ title: 'Track', category: 'Original', audioUrl: 'https://media.example/a.wav' })).statusCode, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'create');
});
test('failed conversion creates no archive record and permits a retry', async () => {
  let attempts = 0;
  const { calls, invoke } = fixture({ convert: async () => { attempts++; throw new Error('unavailable'); } });
  assert.equal((await invoke()).statusCode, 502);
  assert.equal((await invoke()).statusCode, 502);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, []);
});
test('failed database save removes the new upload', async () => {
  const { calls, invoke } = fixture({ create: async () => { throw new Error('database unavailable'); } });
  assert.equal((await invoke()).statusCode, 500);
  assert.deepEqual(calls.at(-1), ['remove', 'audio/123']);
});
test('concurrent conversions are bounded and become available after completion', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { invoke } = fixture({ convert: async () => { await gate; return { buffer: Buffer.from('wav'), fileName: 'source.wav' }; } });
  const pending = invoke();
  assert.equal((await invoke()).statusCode, 503);
  release();
  assert.equal((await pending).statusCode, 201);
  assert.equal((await invoke()).statusCode, 201);
});

test('converter uses a canonical single-video URL, reads WAV and removes temporary files', async (t) => {
  const fs = require('fs/promises');
  const path = require('path');
  const os = require('os');
  const { convertYoutubeToWav } = require('../src/youtube-audio');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-converter-test-'));
  const command = path.join(dir, 'downloader');
  const capture = path.join(dir, 'arguments.json');
  const previous = process.env.YT_DLP_PATH;
  const previousCookieFile = process.env.YT_DLP_COOKIES_FILE;
  process.env.YT_DLP_COOKIES_FILE = path.join(dir, 'missing-session.txt');
  await fs.writeFile(command, `#!/usr/bin/env node\nconst fs = require('fs'); const args = process.argv.slice(2); const output = args[args.indexOf('--output') + 1].replace('%(ext)s','wav'); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args, output})); fs.writeFileSync(output, Buffer.from('RIFF-test-audio'));\n`, { mode: 0o700 });
  process.env.YT_DLP_PATH = command;
  t.after(async () => {
    if (previousCookieFile === undefined) delete process.env.YT_DLP_COOKIES_FILE; else process.env.YT_DLP_COOKIES_FILE = previousCookieFile;
    if (previous === undefined) delete process.env.YT_DLP_PATH;
    else process.env.YT_DLP_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const audio = await convertYoutubeToWav(`${source}?list=ignored`);
  assert.equal(audio.buffer.toString(), 'RIFF-test-audio');
  const { args, output } = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.ok(args.includes('--no-cookies'));
  assert.ok(args.includes('--no-cookies-from-browser'));
  assert.ok(!args.includes('--cookies'));
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(args.includes('--no-playlist'), true);
  assert.equal(args[args.indexOf('--audio-format') + 1], 'wav');
  assert.equal(args[args.indexOf('--match-filter') + 1], 'duration <= 1800 & !is_live');
  await assert.rejects(fs.access(path.dirname(output)), { code: 'ENOENT' });
});

test('YouTube sign-in failures are explicit and never save an empty track', async () => {
  const { calls, invoke } = fixture({ convert: async () => { throw Object.assign(new Error('Sign in to confirm'), { code: 'YOUTUBE_AUTH_REQUIRED' }); } });
  const response = await invoke();
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, 'YOUTUBE_AUTH_REQUIRED');
  assert.match(response.body.message, /public download access/);
  assert.doesNotMatch(response.body.message, /Configure YouTube access|requires sign-in/);
  assert.deepEqual(calls, []);
});
test('missing audio source never creates a track', async () => {
  const { calls, invoke } = fixture();
  assert.equal((await invoke({ title: 'Track', category: 'Original' })).statusCode, 400);
  assert.deepEqual(calls, []);
});

test('public-access blocks never create an archive row or require connecting an account', async () => {
  const { calls, invoke } = fixture({ convert: async () => { throw Object.assign(new Error('Sign in to confirm you are not a bot'), { code: 'YOUTUBE_PUBLIC_ACCESS_BLOCKED' }); } });
  const response = await invoke();
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, 'YOUTUBE_PUBLIC_ACCESS_BLOCKED');
  assert.match(response.body.message, /No account was used/);
  assert.doesNotMatch(response.body.message, /Configure YouTube|requires sign-in/);
  assert.deepEqual(calls, []);
});

test('offline private audio worker preserves retry and creates no archive item', async () => {
  const { calls, invoke } = fixture({ convert: async () => { throw Object.assign(new Error('offline'), { code: 'YOUTUBE_WORKER_UNAVAILABLE' }); } });
  const response = await invoke();
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'YOUTUBE_WORKER_UNAVAILABLE');
  assert.match(response.body.message, /admin computer online/);
  assert.deepEqual(calls, []);
});
