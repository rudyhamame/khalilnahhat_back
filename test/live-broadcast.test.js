const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerLiveBroadcastRoutes } = require('../src/live-broadcast');
function setup(overrides = {}) {
  const routes = {};
  const writes = []; const deleted = [];
  const current = { key: 'live', isLive: false, webrtcRoomName: '' };
  const deps = { requireAdmin: () => {}, getLiveStreamConfig: async () => current,
    LiveStreamConfig: { findOneAndUpdate: async (filter, change) => { writes.push({ filter, change }); return { ...current, ...change }; } },
    defaults: { key: 'live', title: 'Live', statusLabel: 'Offline' }, createToken: async () => 'temporary-token',
    getConfig: () => ({ wsUrl: 'wss://media.example', apiKey: 'key', apiSecret: 'secret' }), serialize: value => value, serializePublic: value => value, verifyWebhook: async body => JSON.parse(body),
    RoomServiceClient: class { async deleteRoom(name) { deleted.push(name); } }, randomUUID: () => 'new', ...overrides };
  registerLiveBroadcastRoutes({ get: (path, handler) => { routes.status = handler; }, post: (path, auth, handler) => { if (handler) assert.equal(auth, deps.requireAdmin); routes[path.split('/').pop()] = handler || auth; } }, deps);
  const call = async (name, body = {}) => { const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } }; await routes[name]({ body, rawBody: JSON.stringify(body), headers: {} }, res); return res; };
  return { call, writes, deleted, current };
}
test('missing media configuration does not publish a false live status', async () => {
  const ctx = setup({ getConfig: () => { throw Object.assign(new Error('Not configured'), { status:503 }); } });
  assert.equal((await ctx.call('go-live')).statusCode, 503); assert.equal(ctx.writes.length, 0);
});
test('stale phone cannot stop a replacement broadcast', async () => {
  const ctx = setup(); ctx.current.isLive=true; ctx.current.webrtcRoomName='new-room';
  const result=await ctx.call('end', { roomName:'old-room' });
  assert.equal(result.body.ended,false); assert.equal(ctx.writes.length,0); assert.deepEqual(ctx.deleted,[]);
});
test('starting claims the offline singleton atomically', async () => {
  const ctx=setup(); const result=await ctx.call('go-live',{ title:' Phone set ' });
  assert.equal(result.statusCode,201); assert.deepEqual(ctx.writes[0].filter,{ key:'live',isLive:{$ne:true} });
  assert.equal(result.body.item.title,'Phone set');
});
test('concurrent go-live loser receives no publishing token', async () => {
  const ctx=setup({ LiveStreamConfig:{ findOneAndUpdate: async()=>null } });
  const result=await ctx.call('go-live'); assert.equal(result.statusCode,409); assert.equal(result.body.token,undefined);
});
test('end clears only the expected room and deletes that room', async () => {
  const ctx=setup(); ctx.current.webrtcRoomName='phone-room'; ctx.current.isLive=true;
  assert.equal((await ctx.call('end',{roomName:'phone-room'})).body.ended,true);
  assert.equal(ctx.writes[0].filter.webrtcRoomName,'phone-room'); assert.deepEqual(ctx.deleted,['phone-room']);
});

test('unsigned webhook cannot change live status', async () => {
  const ctx=setup({verifyWebhook: async()=>{throw new Error('bad signature');}});
  assert.equal((await ctx.call('webhook',{event:'room_finished',room:{name:'current'}})).statusCode,401);
  assert.equal(ctx.writes.length,0);
});
test('viewer leaving does not end the broadcaster', async () => {
  const ctx=setup(); await ctx.call('webhook',{event:'participant_left',room:{name:'current'},participant:{identity:'viewer-1'}});
  assert.equal(ctx.writes.length,0);
});
test('verified broadcaster departure clears only its exact room', async () => {
  const ctx=setup(); await ctx.call('webhook',{event:'participant_left',room:{name:'old-room'},participant:{identity:'khalil-broadcaster'}});
  assert.deepEqual(ctx.writes[0].filter,{key:'live',broadcastMode:'webrtc',webrtcRoomName:'old-room'});
});

test('LiveKit webhook verifies the original webhook+json bytes and rejects tampering', async () => {
  const express = require('express');
  const { AccessToken, WebhookReceiver } = require('livekit-server-sdk');
  const crypto = require('node:crypto');
  const receiver = new WebhookReceiver('test-key', 'a-test-secret-that-is-at-least-32-characters');
  const payload = JSON.stringify({event:'room_finished',room:{name:'phone-room',sid:'RM_test'}});
  const token = new AccessToken('test-key', 'a-test-secret-that-is-at-least-32-characters', {ttl:'1m'});
  token.sha256 = crypto.createHash('sha256').update(payload).digest('base64');
  const authorization = await token.toJwt();
  const app = express();
  // Exercise the actual deployed parser declaration, not a separately reconstructed parser.
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').join(__dirname,'../src/server.js'),'utf8');
  const declaration = source.slice(source.indexOf('app.use(express.json('), source.indexOf('} }));',source.indexOf('app.use(express.json(')) + 7);
  require('node:vm').runInNewContext(declaration,{app,express});
  app.post('/api/live-stream/webrtc/webhook', async(req,res)=> {
    try { const event=await receiver.receive(req.rawBody,req.headers.authorization); res.json({event:event.event}); }
    catch { res.sendStatus(401); }
  });
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/live-stream/webrtc/webhook`;
    const headers={'Content-Type':'application/webhook+json',Authorization:authorization};
    const valid=await fetch(url,{method:'POST',headers,body:payload});
    assert.equal(valid.status,200); assert.equal((await valid.json()).event,'room_finished');
    assert.equal((await fetch(url,{method:'POST',headers,body:payload.replace('phone-room','wrong-room')})).status,401);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('recording setup failure releases only its own live claim and returns no token',async()=>{
 const ctx=setup({prepareRecording:async()=>{throw Object.assign(new Error('Recording unavailable'),{status:503});}});
 const result=await ctx.call('go-live');assert.equal(result.statusCode,503);assert.equal(result.body.token,undefined);
 assert.equal(ctx.writes.length,2);assert.deepEqual(ctx.writes[1].filter,{key:'live',webrtcRoomName:'khalil-live-new'});assert.equal(ctx.writes[1].change.isLive,false);
});
