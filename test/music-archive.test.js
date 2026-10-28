const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerMusicArchive, visibleSongs, inputs } = require('../src/music-archive');
const { memoryModel } = require('./helpers/archive-memory');
test('only published, active recordings are visible; legacy tracks survive', () => {
  const songs = [{ externalId: 'legacy' }, { externalId: 'ok', published: true }, { externalId: 'draft', published: false }, { externalId: 'gone', archivalStatus: 'ARCHIVED' }];
  assert.deepEqual(visibleSongs(songs).map(s => s.externalId), ['legacy', 'ok']);
});
test('archive input rejects arbitrary URLs, unknown fields and malformed values', () => {
  assert.equal(inputs.songs.safeParse({ title: 'Track', audioUrl: 'https://evil.example/a.mp3' }).success, false);
  assert.equal(inputs.collections.safeParse({ title: 'Wedding', admin: true }).success, false);
  assert.equal(inputs.collections.safeParse({ title: 'Wedding', recordingIds: [''] }).success, false);
  assert.equal(inputs.collections.parse({ title: 'Wedding' }).published, false);
});
test('collections: admin CRUD, draft isolation, manual membership/order and reorder work through real HTTP handlers', async t => {
  const app = express(); app.use(express.json());
  const collections = memoryModel(); const songs = memoryModel([{ externalId:'legacy', title:'Existing recording', audioUrl:'https://example.com/legacy.mp3' }, { externalId:'second', title:'Second', audioUrl:'https://example.com/second.mp3' }]);
  registerMusicArchive(app, { requireAdmin: (req, res, next) => req.headers.authorization === 'test-admin' ? next() : res.status(401).json({ message:'Unauthorized' }), CollectionModel: collections, ArchiveModel: songs });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, method = 'GET', body, admin = true) {
    const r = await fetch(base + path, { method, headers: { 'Content-Type':'application/json', ...(admin ? { Authorization:'test-admin' } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
    return { status:r.status, body:await r.json().catch(() => ({})) };
  }
  assert.equal((await request('/admin/music-archive', 'GET', null, false)).status,401);
  assert.equal((await request('/admin/music-archive/collections','POST',{title:'Denied'},false)).status,401);
  assert.equal((await request('/admin/music-archive/collections','POST',{title:'Bad',recordingIds:['missing']})).status,400);
  const a = (await request('/admin/music-archive/collections','POST',{title:'Entrances',recordingIds:['second','legacy','second']})).body.item;
  assert.deepEqual(a.recordingIds,['second','legacy']);
  assert.equal((await request('/music-archive')).body.collections.length,0);
  await request(`/admin/music-archive/collections/${a.id}`,'PATCH',{published:true});
  const shown = (await request('/music-archive')).body.collections[0];
  assert.deepEqual([shown.title,shown.recordingIds,shown.songCount],['Entrances',['second','legacy'],2]);
  await request('/admin/music-archive/songs/legacy','PATCH',{published:false});
  assert.deepEqual((await request('/music-archive')).body.collections[0].recordingIds,['second']);
  assert.equal((await request('/admin/music-archive')).body.collections[0].recordingIds.length,2);
  const b = (await request('/admin/music-archive/collections','POST',{title:'Second set',published:true})).body.item;
  assert.equal((await request('/admin/music-archive/collections/order','PUT',{ids:[b.id,a.id]})).status,200);
  assert.deepEqual((await request('/music-archive')).body.collections.map(x => x.id),[b.id,a.id]);
  assert.equal((await request('/admin/music-archive/collections/order','PUT',{ids:[b.id,b.id]})).status,400);
  assert.equal((await request('/admin/music-archive/collections/order','PUT',{ids:['missing']})).status,409);
  assert.equal((await request(`/admin/music-archive/collections/${a.id}`,'DELETE')).status,200);
  assert.equal((await request('/admin/music-archive/albums','POST',{title:'Old'})).status,404);
});

test('Cloudinary-required uploads fail closed when credentials are missing', async t => {
  const app = express();
  registerMusicArchive(app, { requireAdmin: (_req, _res, next) => next(), requireCloudinary: true, useCloudinary: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const body = new FormData();
  body.append('file', new Blob(['test bytes'], { type: 'audio/mpeg' }), 'test.mp3');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/music-archive/upload`, { method: 'POST', body });
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /has not been saved/);
});

test('uploads require admin, reject executable/image impostor types and store allowed audio as authenticated media', async t => {
  const app = express(); const options = [];
  const fakeCloud = { uploader: { upload_stream: (config, done) => { options.push(config); return { end: () => done(null, { secure_url:'https://res.cloudinary.com/qa/video/upload/audio.mp3',duration:66 }) }; } } };
  registerMusicArchive(app, { requireAdmin:(req,res,next) => req.headers.authorization === 'admin' ? next() : res.status(401).json({}), cloudinaryClient:fakeCloud, useCloudinary:true });
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/music-archive/upload`;
  async function upload(type, auth = true) {
    const body = new FormData(); body.append('file',new Blob(['test bytes'],{type}),'test-file');
    return fetch(url,{method:'POST',headers:auth ? {Authorization:'admin'} : {},body});
  }
  assert.equal((await upload('audio/mpeg',false)).status,401);
  assert.equal((await upload('image/svg+xml')).status,400);
  assert.equal((await upload('text/html')).status,400);
  const response = await upload('audio/mpeg'); assert.equal(response.status,201);
  assert.equal((await response.json()).duration,'1:06');
  assert.equal(options[0].type,'authenticated'); assert.equal(options[0].resource_type,'video');
  assert.equal((await upload('image/png')).status,201);
  assert.equal(options[1].resource_type,'image'); assert.equal(options[1].transformation[0].width,1600);
});
