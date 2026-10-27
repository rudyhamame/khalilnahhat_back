const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerMusicArchive, visibleSongs, inputs } = require('../src/music-archive');
const { memoryModel } = require('./helpers/archive-memory');
test('publishing requires the song, album and category to be visible; legacy unassigned tracks survive', () => {
  const categories = [{ externalId: 'c', published: true }, { externalId: 'hidden', published: false }];
  const albums = [{ externalId: 'a', categoryId: 'c', published: true }, { externalId: 'b', categoryId: 'hidden', published: true }];
  const songs = [{ externalId: 'legacy' }, { externalId: 'ok', albumId: 'a', published: true }, { externalId: 'draft', albumId: 'a', published: false }, { externalId: 'hidden-parent', albumId: 'b' }, { externalId: 'orphan', albumId: 'missing' }];
  assert.deepEqual(visibleSongs(songs, albums, categories).map(s => s.externalId), ['legacy', 'ok']);
});
test('archive input rejects arbitrary URLs, unknown fields and malformed values', () => {
  assert.equal(inputs.songs.safeParse({ title: 'Track', audioUrl: 'https://evil.example/a.mp3' }).success, false);
  assert.equal(inputs.categories.safeParse({ title: 'Wedding', admin: true }).success, false);
  assert.equal(inputs.albums.safeParse({ title: 'Wedding', categoryId: 'c', year: 1800 }).success, false);
  assert.equal(inputs.categories.parse({ title: 'Wedding' }).published, false);
});
test('admin CRUD, draft isolation, parent protection and reorder work through real HTTP handlers', async t => {
  const app = express(); app.use(express.json());
  const categories = memoryModel(); const albums = memoryModel(); const songs = memoryModel([{ externalId:'legacy', title:'Existing recording', audioUrl:'https://example.com/legacy.mp3' }]);
  registerMusicArchive(app, { requireAdmin: (req, res, next) => req.headers.authorization === 'test-admin' ? next() : res.status(401).json({ message:'Unauthorized' }), CategoryModel: categories, AlbumModel: albums, ArchiveModel: songs });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, method = 'GET', body, admin = true) {
    const r = await fetch(base + path, { method, headers: { 'Content-Type':'application/json', ...(admin ? { Authorization:'test-admin' } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
    return { status:r.status, body:await r.json() };
  }
  assert.equal((await request('/admin/music-archive', 'GET', null, false)).status,401);
  assert.equal((await request('/admin/music-archive/categories','POST',{title:'Denied'},false)).status,401);
  const c = (await request('/admin/music-archive/categories','POST',{title:'Entrances'})).body.item;
  const a = (await request('/admin/music-archive/albums','POST',{title:'Entrances 2026',categoryId:c.id,year:2026,published:true})).body.item;
  assert.equal((await request('/music-archive')).body.albums.length,0);
  await request(`/admin/music-archive/categories/${c.id}`,'PATCH',{published:true});
  assert.equal((await request('/music-archive')).body.albums[0].title,'Entrances 2026');
  assert.equal((await request(`/admin/music-archive/categories/${c.id}`,'DELETE')).status,409);
  assert.equal((await request('/admin/music-archive/albums','POST',{title:'Orphan',categoryId:'missing'})).status,400);
  const b = (await request('/admin/music-archive/albums','POST',{title:'Entrances 2025',categoryId:c.id,year:2025,published:true})).body.item;
  assert.equal((await request('/admin/music-archive/albums/order','PUT',{ids:[b.id,a.id]})).status,200);
  assert.deepEqual((await request('/music-archive')).body.albums.map(x => x.id),[b.id,a.id]);
  assert.equal((await request('/admin/music-archive/albums/order','PUT',{ids:[b.id,b.id]})).status,400);
  assert.equal((await request('/admin/music-archive/albums/order','PUT',{ids:['missing']})).status,409);
  await request('/admin/music-archive/songs/legacy','PATCH',{albumId:a.id,published:false});
  assert.equal((await request('/music-archive')).body.songs.length,0);
  assert.equal((await request(`/admin/music-archive/albums/${a.id}`,'DELETE')).status,409);
  assert.equal((await request('/admin/music-archive')).body.songs.length,1);
  await request('/admin/music-archive/songs/legacy','PATCH',{published:true});
  assert.equal((await request('/music-archive')).body.songs.length,1);
  await request(`/admin/music-archive/categories/${c.id}`,'PATCH',{published:false});
  assert.equal((await request('/music-archive')).body.songs.length,0);
  await request('/admin/music-archive/songs/legacy','DELETE');
  assert.equal((await request(`/admin/music-archive/albums/${a.id}`,'DELETE')).status,200);
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
