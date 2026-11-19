const test = require('node:test');
const assert = require('node:assert/strict');
const { createInstagramPublisher } = require('../src/instagram-publish');

const make = (script) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), method: init.method, body: init.body }); const next = script.shift(); return { ok: !next.error, json: async () => next }; };
  const publish = createInstagramPublisher({ credentials: async () => ({ token: 'T', userId: '17' }), upload: async () => ({ secure_url: 'https://cdn.test/x' }), fetchImpl, sleep: async () => {}, attempts: 3 });
  return { calls, publish };
};

test('a JPEG post: container then publish, with the caption', async () => {
  const { calls, publish } = make([{ id: 'C1' }, { id: 'M1' }, { permalink: 'https://instagram.com/p/abc' }]);
  const result = await publish({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'post', caption: 'Hello' });
  assert.equal(result.permalink, 'https://instagram.com/p/abc');
  assert.match(calls[0].url, /\/17\/media$/); assert.match(calls[0].body, /image_url=https/); assert.match(calls[0].body, /caption=Hello/); assert.doesNotMatch(calls[0].body, /media_type/);
  assert.match(calls[1].url, /\/17\/media_publish$/); assert.match(calls[1].body, /creation_id=C1/);
});

test('a story has no caption and a reel waits for the video to finish', async () => {
  const story = make([{ id: 'C' }, { id: 'M' }, {}]);
  await story.publish({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'story', caption: 'ignored' });
  assert.match(story.calls[0].body, /media_type=STORIES/); assert.doesNotMatch(story.calls[0].body, /caption/);
  const reel = make([{ id: 'C' }, { status_code: 'IN_PROGRESS' }, { status_code: 'FINISHED' }, { id: 'M' }, {}]);
  await reel.publish({ buffer: Buffer.from('x'), mime: 'video/mp4', kind: 'reel', caption: 'c' });
  assert.match(reel.calls[0].body, /media_type=REELS/); assert.match(reel.calls[0].body, /video_url=/);
  assert.equal(reel.calls.filter((c) => c.method === 'GET' && /status_code/.test(c.url)).length, 2);
});

test('wrong kinds, PNG and a missing permission give clear messages', async () => {
  const { publish } = make([]);
  await assert.rejects(publish({ buffer: Buffer.from('x'), mime: 'image/png', kind: 'post' }), /JPEG/);
  await assert.rejects(publish({ buffer: Buffer.from('x'), mime: 'video/mp4', kind: 'post' }), /reel/);
  await assert.rejects(publish({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'reel' }), /video/);
  const denied = make([{ error: { code: 10, message: 'Application does not have permission' } }]);
  await assert.rejects(denied.publish({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'post' }), /instagram_business_content_publish/);
  const failed = make([{ id: 'C' }, { status_code: 'ERROR' }]);
  await assert.rejects(failed.publish({ buffer: Buffer.from('x'), mime: 'video/mp4', kind: 'reel' }), /could not process the video/);
});
