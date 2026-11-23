const test = require('node:test');
const assert = require('node:assert/strict');
const { stepsOf, withEquipmentCategoryIds } = require('./tree-core');
const { serviceCatalogInstructions } = require('./ai-booking');

const dj = { kind: 'service', id: 'dj', name: 'DJ Khalil', nameAr: '', isActive: true };
const sound = { kind: 'service', id: 'sound', name: 'Sound Systems', category: 'sound', equipmentIds: [], isActive: true };
const mc = { kind: 'service', id: 'mc', name: 'MC', selectionField: 'music.mcRequested', isActive: true };

test('steps exist only while their service id is in the tree', () => {
  assert.deepEqual(stepsOf([dj, sound]), { dj: true, rental: true, djName: 'DJ Khalil', djNameAr: '' });
  assert.equal(stepsOf([sound]).dj, false);
  assert.equal(stepsOf([dj, mc]).rental, false, 'MC alone is not a rental service');
  assert.equal(stepsOf([{ ...dj, isActive: false }, sound]).dj, false);
});

test('equipment links to a category by equipmentCategoryId (serviceId is its legacy alias); older items are matched once by category or the service equipment list', () => {
  const rows = withEquipmentCategoryIds([dj, sound, { ...mc, category: 'mc', equipmentIds: ['lectern'] }], [
    { id: 'a', category: 'sound' }, { id: 'lectern', category: 'x' }, { id: 'b', category: 'sound', equipmentCategoryId: 'dj' }, { id: 'c', category: 'none' },
  ]);
  assert.deepEqual(rows.map((row) => row.equipmentCategoryId), ['sound', 'mc', 'dj', '']);
  assert.deepEqual(rows.map((row) => row.serviceId), ['sound', 'mc', 'dj', '']);
});

test('the AI is told what the tree does not offer', () => {
  const text = serviceCatalogInstructions([sound]);
  assert.match(text, /DJ service is not offered/);
  assert.doesNotMatch(text, /No rental equipment is offered/);
  assert.match(serviceCatalogInstructions([dj, mc]), /No rental equipment is offered/);
  assert.doesNotMatch(serviceCatalogInstructions([dj, sound]), /is not offered|No rental equipment/);
});
