const { randomUUID } = require('crypto');

function createArchiveHandler({ schema, convert, upload, removeUpload, create, serialize }) {
  let converting = false;
  return async (request, response) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        message: 'Check the track details and YouTube video link.',
        errors: parsed.error.flatten().fieldErrors,
      });
    }
    const { youtubeUrl, ...data } = parsed.data;
    if (!youtubeUrl && !data.audioUrl) {
      return response.status(400).json({ message: 'Choose an audio file or enter a YouTube music link.' });
    }
    if (youtubeUrl && data.audioUrl) {
      return response.status(400).json({ message: 'Choose either a YouTube link or an uploaded audio file.' });
    }
    if (youtubeUrl && converting) {
      return response.status(503).json({ message: 'Another YouTube track is converting. Please try again shortly.' });
    }
    let uploadedId = '';
    let stage = 'save';
    if (youtubeUrl) converting = true;
    try {
      if (youtubeUrl) {
        stage = 'convert';
        const audio = await convert(youtubeUrl);
        const result = await upload({ buffer: audio.buffer, originalname: audio.fileName, mimetype: 'audio/wav' });
        uploadedId = result.public_id || '';
        if (!result.secure_url) throw new Error('Audio upload returned no secure URL.');
        data.audioUrl = result.secure_url;
        data.audioPublicId = uploadedId;
        data.audioOriginalName = `${data.title}.wav`;
      }
      stage = 'save';
      const item = await create({ ...data, externalId: `archive-${randomUUID()}` });
      return response.status(201).json({ item: serialize(item) });
    } catch (error) {
      if (uploadedId) {
        try { await removeUpload(uploadedId); }
        catch (cleanupError) { console.error('Archive audio cleanup failed:', cleanupError); }
      }
      console.error('Archive creation failed:', error);
      return response.status(['YOUTUBE_BUSY', 'YOUTUBE_WORKER_UNAVAILABLE'].includes(error.code) ? 503 : stage === 'convert' ? 502 : 500).json({
        code: ['YOUTUBE_PUBLIC_ACCESS_BLOCKED', 'YOUTUBE_AUTH_REQUIRED', 'YOUTUBE_BUSY', 'YOUTUBE_WORKER_UNAVAILABLE'].includes(error.code) ? error.code : 'ARCHIVE_CREATE_FAILED',
        message: error.code === 'YOUTUBE_WORKER_UNAVAILABLE'
          ? 'The local YouTube audio service is offline. Keep the admin computer online or upload an Audio file.'
          : error.code === 'YOUTUBE_BUSY'
          ? 'Another YouTube conversion is running. Please try again shortly.'
          : ['YOUTUBE_PUBLIC_ACCESS_BLOCKED', 'YOUTUBE_AUTH_REQUIRED'].includes(error.code)
          ? 'YouTube blocked public download access on the conversion connection. No account was used. Choose Audio file to upload the track instead.'
          : stage === 'convert'
          ? 'Could not convert this YouTube video. Use an available non-live video under 30 minutes; converted audio must be under 100 MB. The server needs yt-dlp and FFmpeg.'
          : 'Could not save this track. Please try again.',
      });
    } finally {
      if (youtubeUrl) converting = false;
    }
  };
}
module.exports = { createArchiveHandler };
