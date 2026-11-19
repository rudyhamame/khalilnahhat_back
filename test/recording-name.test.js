const test = require('node:test');
const assert = require('node:assert/strict');
const { recordingName, recordingNames } = require('../src/music-ontology/recording-name');

test('a recording name is the list of its atoms names', () => {
  const row = { atoms: [{ name: 'Intro' }, { name: ' Verse ' }, { name: '' }, { name: 'Outro' }] };
  assert.deepEqual(recordingNames(row), ['Intro', 'Verse', 'Outro']);
  assert.equal(recordingName(row), 'Intro · Verse · Outro');
});

test('a stored name only shows while no atom is named (rows saved before the change)', () => {
  assert.deepEqual(recordingNames({ name: 'Old name', atoms: [] }), ['Old name']);
  assert.equal(recordingName({ name: 'Old name' }), 'Old name');
  assert.equal(recordingName({ name: 'Old name', atoms: [{ name: 'Atom' }] }), 'Atom');
  assert.equal(recordingName({}), '');
});
