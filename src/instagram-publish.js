// Publishes a card made in the Android Social Cards page to Instagram (feed post, story or reel) with the Instagram API (Instagram Login).
// Instagram fetches the media from a public URL, so the file is first stored with the site's asset store, then: create a media container ->
// (videos only) wait until Instagram has processed it -> publish the container. The account and token are the ones saved in the admin's Instagram settings.
const multer = require('multer');
const GRAPH = 'https://graph.instagram.com/v27.0';
const failure = (status, message) => Object.assign(new Error(message), { status });
const KINDS = ['post', 'story', 'reel'];

function createInstagramPublisher({ credentials, upload, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 60, delayMs = 3000 }) {
  async function graph(method, path, token, params = {}) {
    const url = new URL(`${GRAPH}/${path}`);
    const init = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000), redirect: 'error' };
    if (method === 'GET') Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    else { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(params).toString(); }
    let response, data;
    try { response = await fetchImpl(url, init); data = await response.json(); } catch { throw failure(502, 'Instagram could not be reached. Try again shortly.'); }
    if (!response.ok || data.error) {
      const code = Number(data?.error?.code), text = String(data?.error?.message || '').slice(0, 300);
      if (code === 190) throw failure(422, 'The Instagram token has expired or was revoked. Generate a new token in the Meta app and save it in the admin.');
      if (code === 10 || code === 200 || /permission/i.test(text)) throw failure(422, 'Instagram refused: the token needs the instagram_business_content_publish permission. Generate a new token with it and save it in the admin.');
      throw failure(422, `Instagram: ${text || 'the request was rejected.'}`);
    }
    return data;
  }

  return async function publish({ buffer, mime, kind, caption = '' }) {
    if (!KINDS.includes(kind)) throw failure(400, 'Choose post, story or reel.');
    const video = /^video\//.test(mime || '');
    if (!video && mime !== 'image/jpeg') throw failure(400, 'Instagram photos must be JPEG.');
    if (kind === 'post' && video) throw failure(400, 'A feed post is a photo. Publish a video as a reel.');
    if (kind === 'reel' && !video) throw failure(400, 'A reel is a video.');
    if (!buffer?.length) throw failure(400, 'Choose a file to publish.');
    if (caption.length > 2200) throw failure(400, 'The caption can have at most 2,200 characters.');
    const { token, userId } = await credentials();
    const stored = await upload(buffer, { folder: 'khalil/instagram', resource_type: video ? 'video' : 'image' });
    const url = stored?.secure_url;
    if (!url) throw failure(502, 'The file could not be stored for Instagram.');
    const params = { ...(video ? { video_url: url } : { image_url: url }) };
    if (kind === 'story') params.media_type = 'STORIES';
    else { if (caption) params.caption = caption; if (kind === 'reel') { params.media_type = 'REELS'; params.share_to_feed = 'true'; } }
    const container = await graph('POST', `${userId}/media`, token, params);
    if (!container.id) throw failure(502, 'Instagram did not accept the media.');
    if (video) {
      let status = '';
      for (let i = 0; i < attempts; i++) {
        status = (await graph('GET', container.id, token, { fields: 'status_code,status' })).status_code;
        if (status === 'FINISHED') break;
        if (status === 'ERROR' || status === 'EXPIRED') throw failure(422, 'Instagram could not process the video. Use an MP4 (H.264 + AAC), 3–90 s for reels, 9:16.');
        await sleep(delayMs);
      }
      if (status !== 'FINISHED') throw failure(504, 'Instagram is still processing the video. Check Instagram in a few minutes before trying again.');
    }
    const published = await graph('POST', `${userId}/media_publish`, token, { creation_id: container.id });
    let permalink = '';
    try { permalink = (await graph('GET', published.id, token, { fields: 'permalink' })).permalink || ''; } catch { /* the post is live; the link is a nicety */ }
    return { id: published.id, permalink, kind };
  };
}

function registerInstagramPublish(app, { requireAdmin, credentials, upload = require('./cloudinary-assets').uploadAsset }) {
  const publish = createInstagramPublisher({ credentials, upload });
  const receive = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 4 } }).single('file');
  app.post('/api/admin/instagram/publish', requireAdmin, (req, res) => receive(req, res, async (problem) => {
    res.set('Cache-Control', 'no-store');
    if (problem) return res.status(400).json({ message: 'The file could not be read (maximum 100 MB).' });
    try { res.json({ item: await publish({ buffer: req.file?.buffer, mime: req.file?.mimetype, kind: String(req.body?.kind || ''), caption: String(req.body?.caption || '') }) }); }
    catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Instagram publishing is temporarily unavailable.' }); }
  }));
}
module.exports = { registerInstagramPublish, createInstagramPublisher };
