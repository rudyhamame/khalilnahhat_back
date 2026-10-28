const PROMPTS = {
  wedding: 'an elegant wedding reception with a dance floor, warm string lights and floral decor',
  engagement: 'an intimate engagement party with candlelight, champagne and soft romantic lighting',
  birthday: 'a lively birthday party with balloons, a cake table and colourful stage lights',
  corporate: 'a polished corporate event with a stage, LED screen and professional lighting',
  party: 'a high-energy party with a DJ booth, moving head lights and a packed dance floor',
  graduation: 'a graduation celebration hall with a stage, banners and bright celebratory lighting',
  other: 'a stylish private event with a DJ booth, sound system and ambient lighting',
};
const cache = new Map(); // ponytail: in-memory per event type (7 keys max); persist to Cloudinary if cold-start cost matters

function registerEventImages(app, { requireAuth, policy, admitted, headers, fetchImpl = fetch, env = process.env }) {
  app.post('/api/ai-booking/event-images', requireAuth, async (req, res) => {
    const type = String(req.body?.type || '');
    if (!Object.hasOwn(PROMPTS, type)) return res.status(400).json({ message: 'Choose a valid event type.' });
    if (cache.has(type)) return res.json({ images: cache.get(type) });
    const config = await policy(res, 'chat');
    if (!config || !admitted(req, res, 'chat', config.chat.requestsPer10Min, config)) return;
    try {
      const upstream = await fetchImpl('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { ...headers(req), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000),
        body: JSON.stringify({ model: env.OPENAI_EVENT_IMAGE_MODEL || 'gpt-image-1-mini', n: 2, size: '1536x1024', quality: 'low', output_format: 'webp',
          prompt: `Photorealistic wide photo of ${PROMPTS[type]}, event production by a DJ, sound and lighting company. No text, no logos, no people's faces in close-up.` }),
      });
      if (!upstream.ok) return res.status(upstream.status === 429 ? 429 : 502).json({ message: 'Image generation is unavailable right now.' });
      const images = (await upstream.json()).data?.map(row => `data:image/webp;base64,${row.b64_json}`) || [];
      if (!images.length) return res.status(502).json({ message: 'Image generation returned nothing.' });
      cache.set(type, images);
      res.json({ images });
    } catch { res.status(502).json({ message: 'Image generation is unavailable right now.' }); }
  });
}
module.exports = { registerEventImages };
