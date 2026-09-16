const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function isYoutubeUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with status ${code}.`));
    });
  });
}

async function convertYoutubeToWav(sourceUrl) {
  if (!isYoutubeUrl(sourceUrl)) {
    throw new Error('Only YouTube URLs can be converted.');
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'khalil-youtube-'));
  const outputTemplate = path.join(tempDirectory, 'khalil-source.%(ext)s');
  const ytDlpCommand = process.env.YT_DLP_PATH || 'yt-dlp';
  const ffmpegCommand = process.env.FFMPEG_PATH || 'ffmpeg';

  try {
    await runCommand(ytDlpCommand, [
      '--no-playlist',
      '--max-filesize', '100M',
      '--no-warnings',
      '--extract-audio',
      '--audio-format', 'wav',
      '--audio-quality', '0',
      '--ffmpeg-location', ffmpegCommand,
      '--output', outputTemplate,
      sourceUrl,
    ], { timeout: 180000 });

    const files = await fs.readdir(tempDirectory);
    const wavName = files.find((fileName) => fileName.toLowerCase().endsWith('.wav'));

    if (!wavName) {
      throw new Error('The YouTube conversion did not produce a WAV file.');
    }

    return {
      buffer: await fs.readFile(path.join(tempDirectory, wavName)),
      fileName: wavName,
    };
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

module.exports = { convertYoutubeToWav, isYoutubeUrl };
