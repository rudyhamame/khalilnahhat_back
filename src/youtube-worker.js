const http = require('http');
const fs = require('fs/promises');
const crypto = require('crypto');
const path = require('path');
const { convertYoutubeToWav, normalizeYoutubeUrl } = require('./youtube-audio');

function createYoutubeWorker({ key, convert, normalize = normalizeYoutubeUrl }) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('A private worker key is required.');
  let busy = false;
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const json = (status, body) => { request.resume(); response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    const presented = String(request.headers.authorization || '').replace(/^Bearer /, '');
    const expected = Buffer.from(key); const actual = Buffer.from(presented);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return json(401, { message: 'Worker authentication required.' });
    if (request.method === 'GET' && request.url === '/health') return json(200, { ok: true, mode: 'public', busy });
    if (request.method !== 'POST' || request.url !== '/convert') return json(404, { message: 'Not found.' });
    if (busy) return json(503, { code: 'YOUTUBE_BUSY', message: 'Another public video is converting.' });
    busy = true;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) return json(413, { message: 'Request too large.' });
        chunks.push(chunk);
      }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { message: 'Invalid request.' }); }
      const sourceUrl = normalize(body?.sourceUrl);
      if (!sourceUrl) return json(400, { message: 'Enter an individual public YouTube video link.' });
      const audio = await convert(sourceUrl);
      if (!audio?.buffer?.length || audio.buffer.length > 100 * 1024 * 1024) throw new Error('Invalid audio output.');
      response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.buffer.length });
      response.end(audio.buffer);
    } catch (error) {
      if (!response.destroyed && !response.headersSent) json(502, {
        code: error.code === 'YOUTUBE_PUBLIC_ACCESS_BLOCKED' ? error.code : 'YOUTUBE_CONVERSION_FAILED',
        message: error.code === 'YOUTUBE_PUBLIC_ACCESS_BLOCKED' ? 'YouTube blocked public access on the local connection.' : 'Public audio conversion failed. Check video availability and length.',
      });
    } finally { busy = false; }
  });
}

async function start() {
  const runtime = path.join(__dirname, '../.runtime');
  const key = (await fs.readFile(process.env.YOUTUBE_WORKER_KEY_FILE || path.join(runtime, 'worker.key'), 'utf8')).trim();
  const command = process.env.YT_DLP_PATH || path.join(runtime, 'yt-dlp/bin/yt-dlp');
  const server = createYoutubeWorker({ key, convert: url => convertYoutubeToWav(url, { localOnly: true, command }) });
  server.requestTimeout = 200000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.YOUTUBE_WORKER_PORT || 4311), '127.0.0.1', () => console.log('Public YouTube audio worker listening on loopback.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
if (require.main === module) start().catch(() => { console.error('Audio worker startup failed. Check runtime tools and private key file.'); process.exitCode = 1; });
module.exports = { createYoutubeWorker };
