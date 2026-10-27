const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { convertViaYoutubeWorker } = require('./youtube-worker-client');

function normalizeYoutubeUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    const host = url.hostname.toLowerCase();
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return '';
    const parts = url.pathname.split('/').filter(Boolean);
    const id = host === 'youtu.be' ? parts[0]
      : url.pathname === '/watch' ? url.searchParams.get('v')
        : ['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : '';
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : '';
  } catch {
    return '';
  }
}

function isYoutubeUrl(value) {
  return Boolean(normalizeYoutubeUrl(value));
}

function runCommand(command, args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    // Kill the downloader and its FFmpeg children together when conversion times out.
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { detached: grouped, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The process may have just exited. */ }
    }, timeout);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('YouTube conversion timed out.'));
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `${command} exited with status ${code}.`));
    });
  });
}

async function convertYoutubeToWav(sourceUrl, { localOnly = false, command } = {}) {
  const normalizedUrl = normalizeYoutubeUrl(sourceUrl);
  if (!normalizedUrl) {
    throw new Error('Only YouTube URLs can be converted.');
  }

  if (!localOnly && process.env.YOUTUBE_PROCESSING_MODE !== 'server' && process.env.YOUTUBE_WORKER_SOCKET) {
    return convertViaYoutubeWorker(normalizedUrl, { socketPath: process.env.YOUTUBE_WORKER_SOCKET, keyFile: process.env.YOUTUBE_WORKER_KEY_FILE });
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'khalil-youtube-'));
  const outputTemplate = path.join(tempDirectory, 'khalil-source.%(ext)s');
  const ytDlpCommand = command || process.env.YT_DLP_PATH || 'yt-dlp';
  const ffmpegCommand = process.env.FFMPEG_PATH;

  try {
    await runCommand(ytDlpCommand, [
      '--ignore-config',
      '--no-cookies',
      '--no-cookies-from-browser',
      '--no-playlist',
      '--js-runtimes', 'node',
      '--format', 'bestaudio/best',
      '--match-filter', 'duration <= 1800 & !is_live',
      '--socket-timeout', '20',
      '--retries', '2',
      '--max-filesize', '100M',
      '--no-warnings',
      '--extract-audio',
      '--audio-format', 'wav',
      '--audio-quality', '0',
      ...(ffmpegCommand ? ['--ffmpeg-location', ffmpegCommand] : []),
      '--output', outputTemplate,
      '--', normalizedUrl,
    ], { timeout: 180000 });

    const files = await fs.readdir(tempDirectory);
    const wavName = files.find((fileName) => fileName.toLowerCase().endsWith('.wav'));

    if (!wavName) {
      throw new Error('The YouTube conversion did not produce a WAV file.');
    }

    const outputSize = (await fs.stat(path.join(tempDirectory, wavName))).size;
    if (!outputSize || outputSize > 100 * 1024 * 1024) {
      throw new Error('Converted audio must be between 1 byte and 100 MB.');
    }

    return {
      buffer: await fs.readFile(path.join(tempDirectory, wavName)),
      fileName: wavName,
    };
  } catch (error) {
    if (/sign in to confirm|login.required|cookies.*authentication|sign in.*not a bot|private video|members.only|age.restrict|confirm your age/i.test(error.message || '')) {
      error.code = 'YOUTUBE_PUBLIC_ACCESS_BLOCKED';
    }
    throw error;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

module.exports = { convertYoutubeToWav, isYoutubeUrl, normalizeYoutubeUrl };
