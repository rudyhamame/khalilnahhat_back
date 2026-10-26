const http = require('http');
const fs = require('fs/promises');
const LIMIT = 100 * 1024 * 1024;
async function convertViaYoutubeWorker(sourceUrl, { socketPath, keyFile, timeout = 190000 }) {
  let key;
  try { key = (await fs.readFile(keyFile, 'utf8')).trim(); }
  catch { throw Object.assign(new Error('The private audio worker is not configured.'), { code: 'YOUTUBE_WORKER_UNAVAILABLE' }); }
  return new Promise((resolve, reject) => {
    const fail = error => reject(Object.assign(error, { code: error.code?.startsWith('YOUTUBE_') ? error.code : 'YOUTUBE_WORKER_UNAVAILABLE' }));
    const request = http.request({ socketPath, path: '/convert', method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > (response.statusCode === 200 ? LIMIT : 16384)) { request.destroy(new Error('Audio worker response exceeded its limit.')); return; }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('Audio worker connection was interrupted.')));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (response.statusCode !== 200) {
          let payload = {}; try { payload = JSON.parse(buffer.toString('utf8')); } catch { /* Safe generic failure. */ }
          return fail(Object.assign(new Error(payload.message || 'The private audio worker is unavailable.'), { code: ['YOUTUBE_BUSY', 'YOUTUBE_PUBLIC_ACCESS_BLOCKED', 'YOUTUBE_CONVERSION_FAILED'].includes(payload.code) ? payload.code : 'YOUTUBE_WORKER_UNAVAILABLE' }));
        }
        if (response.headers['content-type'] !== 'audio/wav' || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return fail(new Error('Audio worker returned invalid WAV audio.'));
        resolve({ buffer, fileName: 'youtube-audio.wav' });
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Audio worker timed out.')), timeout);
    request.on('error', fail);
    request.on('close', () => clearTimeout(timer));
    request.end(JSON.stringify({ sourceUrl }));
  });
}
module.exports = { convertViaYoutubeWorker };
