const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { filterYoutubeSession, createYoutubeSessionStore, registerYoutubeSessionRoutes } = require('../src/youtube-session');
const session = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSAPISID\tprivate-session-secret\n.example.com\tTRUE\t/\tTRUE\t2147483647\tsid\tunrelated-secret\n';
test('only YouTube/Google cookie domains are retained and expired or malformed sessions are rejected', () => {
  const filtered = filterYoutubeSession(session);
  assert.match(filtered, /youtube.com/);
  assert.doesNotMatch(filtered, /example.com|unrelated-secret/);
  for (const value of ['', 'not a cookie file', session.replace('2147483647', '1'), session.replace('.youtube.com', '.youtube.com.evil.test')]) {
    assert.throws(() => filterYoutubeSession(value));
  }
});
test('saved session status exposes label and access state, never credential contents; sign-out removes credentials', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-session-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cookies.txt');
  const store = createYoutubeSessionStore(file);
  assert.equal((await store.status()).connected, false);
  await store.save(session, 'Music account');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await store.recordAccess('blocked', 'YouTube requires sign-in.');
  const status = await store.status();
  assert.equal(status.accountLabel, 'Music account'); assert.equal(status.accessStatus, 'blocked');
  assert.doesNotMatch(JSON.stringify(status), /private-session-secret|cookies.txt|unrelated-secret/);
  await assert.rejects(store.save('invalid', 'Other account'));
  assert.equal((await store.status()).accountLabel, 'Music account');
  assert.equal((await store.clear()).connected, false);
  await assert.rejects(fs.access(file));
});
test('all session operations require administrator authentication and changes reject an active conversion', async () => {
  const routes = [];
  const admin = () => {};
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (route, ...handlers) => routes.push({ method, route, handlers })]));
  registerYoutubeSessionRoutes(app, { requireAdmin: admin, upload: () => {}, store: {}, convert: () => {}, normalizeUrl: () => true, isBusy: () => true });
  assert.equal(routes.length, 4);
  for (const route of routes) assert.equal(route.handlers[0], admin);
  const response = { status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
  await routes.find(route => route.method === 'delete').handlers.at(-1)({}, response);
  assert.equal(response.code, 409);
});

test('public access reports verification and blocks without a saved account', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-public-status-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const file of ['', path.join(dir, 'cookies.txt')]) {
    const store = createYoutubeSessionStore(file);
    await store.recordPublicAccess('ready', 'Public conversion succeeded without an account.');
    let status = await store.status();
    assert.equal(status.connected, false);
    assert.equal(status.publicAccess.status, 'ready');
    await store.recordPublicAccess('blocked', 'Public access blocked.');
    status = await store.status();
    assert.equal(status.publicAccess.status, 'blocked');
    if (file) await assert.rejects(fs.access(file));
  }
});

test('connected session status stays unverified until a successful conversion and expires independently',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-auth-status-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'cookies.txt'),store=createYoutubeSessionStore(file);
 await store.recordPublicAccess('ready','Earlier public check passed');await store.save(session,'Converter account');let status=await store.status();assert.equal(status.authenticationMode,'session');assert.equal(status.accessStatus,'unchecked');
 await store.recordAccess('ready','Session conversion passed');assert.equal((await store.status()).accessStatus,'ready');await store.save(session,'Replacement');assert.equal((await store.status()).accessStatus,'unchecked');
 await fs.writeFile(file,session.replace('2147483647','1'));status=await store.status();assert.equal(status.connected,false);assert.equal(status.sessionExpired,true);assert.match(status.message,/expired/);assert.doesNotMatch(JSON.stringify(status),/private-session-secret/);
});


test('access checks return immediately, expose progress, reject duplicates and publish the conversion result', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-check-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createYoutubeSessionStore(path.join(dir, 'cookies.txt'));
  await store.save(session, 'Converter');
  const routes = {};
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (path, ...handlers) => { routes[`${method} ${path}`] = handlers.at(-1); }]));
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  registerYoutubeSessionRoutes(app, { requireAdmin() {}, upload() {}, store, normalizeUrl: value => value === 'valid',
    convert: async () => { calls++; await pending; await store.recordAccess('ready', 'Conversion verified'); } });
  const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  let result = response();
  await routes['post /api/admin/youtube-session/check']({body:{sourceUrl:'invalid'}}, result);
  assert.equal(result.code, 400); assert.equal(calls, 0);
  result = response();
  await routes['post /api/admin/youtube-session/check']({body:{sourceUrl:'valid'}}, result);
  assert.equal(result.code, 202); assert.equal(result.body.item.checking, true); assert.equal(result.body.item.accessStatus, 'checking');
  result = response(); await routes['post /api/admin/youtube-session/check']({body:{sourceUrl:'valid'}}, result);
  assert.equal(result.code, 409); assert.equal(calls, 1);
  result = response(); await routes['delete /api/admin/youtube-session']({}, result); assert.equal(result.code, 409);
  finish();
  for (let i=0;i<50;i++) {
    result=response(); await routes['get /api/admin/youtube-session']({},result);
    if(!result.body.item.checking) break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(result.body.item.checking, false); assert.equal(result.body.item.accessStatus, 'ready');
});

test('a rejected background conversion clears progress and exposes its recorded failure without an unhandled rejection', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-check-error-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createYoutubeSessionStore(path.join(dir,'cookies.txt'));await store.save(session,'Converter');
  const routes={};const app=Object.fromEntries(['get','post','delete'].map(method=>[method,(path,...handlers)=>{routes[`${method} ${path}`]=handlers.at(-1);} ]));
  let fail;const pending=new Promise(resolve=>{fail=resolve;});
  registerYoutubeSessionRoutes(app,{requireAdmin(){},upload(){},store,normalizeUrl:()=>true,convert:async()=>{await pending;await store.recordAccess('error','Video unavailable');throw new Error('Download failed');}});
  const result={status(){return this;},json(body){this.body=body;return this;}};
  await routes['post /api/admin/youtube-session/check']({body:{sourceUrl:'valid'}},result);fail();
  for(let i=0;i<50;i++){await routes['get /api/admin/youtube-session']({},result);if(!result.body.item.checking)break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(result.body.item.checking,false);assert.equal(result.body.item.accessStatus,'error');assert.equal(result.body.item.message,'Video unavailable');
});
