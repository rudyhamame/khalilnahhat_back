const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerDjServiceBuilder } = require('../src/dj-service-builder');

async function server(t, { booking = { id: 'booking-1', externalId: 'booking-1', status: 'confirmed', planning: { timeline: 'Client timeline' } }, authorized = true } = {}) {
  const app = express(); app.use(express.json());
  const requireAdmin = (_req, res, next) => authorized ? next() : res.status(403).json({ message: 'Admin only' });
  let querySeen, saved;
  const BookingModel = { findOne: async query => { querySeen = query; return booking ? { ...booking, save: async function () { saved = structuredClone({ id: this.id, externalId: this.externalId, status: this.status, planning: this.planning }); } } : null; } };
  registerDjServiceBuilder(app, { requireAdmin, ArchiveModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) }, BookingModel, Store: { findById: async () => null, findOneAndUpdate: async () => ({ plans: [] }) } });
  const instance = await new Promise(resolve => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return { base: `http://127.0.0.1:${instance.address().port}/api/admin/dj-service-builder`, get querySeen() { return querySeen; }, get saved() { return saved; } };
}

test('confirmed booking set plan is saved within its planning record', async t => {
  const api = await server(t);
  const djSet = { segments: [{ id: 's1', title: 'Dinner', startsAt: '18:00', endsAt: '19:00', recordingIds: [], notes: 'Soft start' }], notes: 'Client prefers Arabic classics' };
  const response = await fetch(`${api.base}/booking-1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ djSet }) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.djSet, djSet);
  assert.equal(api.querySeen.externalId, 'booking-1');
  assert.equal(api.querySeen.status, 'confirmed');
  assert.equal(api.saved.planning.djSet.notes, djSet.notes);
  assert.equal(api.saved.planning.timeline, 'Client timeline');
  assert.ok(api.saved.planning.updatedAt instanceof Date);
});

test('set plan rejects duplicate recording placements and unknown fields', async t => {
  const api = await server(t);
  const base = { id: 's1', title: 'Dinner', startsAt: '', endsAt: '', recordingIds: ['r1', 'r1'], notes: '' };
  const duplicate = await fetch(`${api.base}/booking-1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ djSet: { segments: [base], notes: '' } }) });
  assert.equal(duplicate.status, 400);
  const invalid = await fetch(`${api.base}/booking-1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ djSet: { segments: [], notes: '', streamKey: 'no' } }) });
  assert.equal(invalid.status, 400);
});

test('set plan cannot be saved to a missing or unconfirmed booking', async t => {
  const api = await server(t, { booking: null });
  const response = await fetch(`${api.base}/booking-1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ djSet: { segments: [], notes: '' } }) });
  assert.equal(response.status, 409);
});

test('set plan routes require administrator authorization', async t => {
  const api = await server(t, { authorized: false });
  const response = await fetch(`${api.base}/booking-1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ djSet: { segments: [], notes: '' } }) });
  assert.equal(response.status, 403);
});
