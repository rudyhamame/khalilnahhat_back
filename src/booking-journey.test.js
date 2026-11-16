const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const journey = require('./booking-journey');
const { ServiceRequest } = require('./models');

test('every status the database allows has exactly one journey row, and no row is invented', () => {
  const allowed = ServiceRequest.schema.path('status').enumValues;
  assert.deepEqual([...journey.STATUSES].sort(), [...allowed].sort());
  assert.equal(new Set(journey.STATUSES).size, journey.STATUSES.length);
  assert.deepEqual(Object.values(journey.STATUS).sort(), [...allowed].sort());
});

test('the facts agree with each other, and no two facts are secretly the same fact', () => {
  const flags = Object.keys(journey.rule(undefined)).filter(key => typeof journey.rule(undefined)[key] === 'boolean');
  const on = fact => new Set(journey.statusesWhere(fact));
  const subset = (a, b) => [...on(a)].every(status => on(b).has(status));
  const key = fact => [...on(fact)].sort().join();
  assert.equal(new Set(flags.map(key)).size, flags.length, 'two facts have identical statuses; merge them into one');
  assert.ok(subset('isBooked', 'holdsStock'), 'a booked date must also hold stock');
  assert.ok(subset('awaitingClient', 'expires'), 'a quote awaiting the client can lapse');
  assert.ok(subset('expires', 'showsPrices'), 'only a quote the client can see may expire');
  assert.ok(subset('extendable', 'repriceable'));
  assert.ok(subset('awaitingClient', 'showsPrices'));
  assert.deepEqual([...on('isBooked')], [journey.STATUS.CONFIRMED]);
  assert.ok(!on('repriceable').has(journey.STATUS.CONFIRMED) && !on('repriceable').has(journey.STATUS.CANCELLED));
  const { clientNext, adminNext, label, labelAr, step, ...cancelled } = journey.rule(journey.STATUS.CANCELLED);
  assert.ok(Object.values(cancelled).every(value => value === false), 'a cancelled request allows nothing');
  assert.equal(clientNext, 'none');
  assert.equal(adminNext, 'none');
});

test('every status has one display name in both languages, and the progress path matches the table', () => {
  for (const status of journey.STATUSES) {
    const { label, labelAr } = journey.rule(status);
    assert.ok(label && labelAr, status);
  }
  journey.PATH_STEPS.forEach((entry, index) => assert.equal(journey.rule(entry.status).step, index, entry.status));
  const onPath = new Set(journey.PATH_STEPS.map(entry => entry.status));
  for (const status of journey.STATUSES) {
    const { step } = journey.rule(status);
    assert.equal(step === null, [journey.STATUS.EXPIRED, journey.STATUS.CANCELLED].includes(status) , status);
    if (!onPath.has(status) && step !== null) assert.ok(step >= 0 && step < journey.PATH_STEPS.length, status);
  }
});

test('an unknown or missing status allows nothing', () => {
  for (const status of [undefined, null, '', 'shipped']) {
    const { clientNext, adminNext, label, labelAr, step, ...facts } = journey.rule(status);
    assert.ok(Object.values(facts).every(value => value === false));
    assert.equal(step, null);
  }
});

test('describe() is the single shape sent to clients', () => {
  const described = journey.describe(journey.STATUS.QUOTED);
  assert.equal(described.status, 'quoted');
  assert.equal(described.awaitingClient, true);
  assert.equal(described.canRecordDeposit, false);
});

// Duplication guard: lifecycle statuses are named only in booking-journey.js. Everything else asks it.
test('no other backend file hard-codes a booking lifecycle status', () => {
  // venue-intelligence has its own unrelated job states (e.g. 'pending'); it never touches booking requests.
  const skip = new Set(['node_modules', 'test', '.git', 'venue-intelligence']);
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name) && entry.name !== 'booking-journey.js') files.push(full);
    }
  })(__dirname);
  const lifecycleOnly = /['"`](quoted|accepted|changes_requested)['"`]/;
  const statusCompare = new RegExp([
    "status\\s*(?:===|!==|==|!=|=|:)\\s*['\"`](?:confirmed|expired|cancelled|pending)['\"`]",   // status === 'confirmed', status: 'pending'
    "\\$(?:in|nin)\\s*:\\s*\\[[^\\]]*['\"`](?:confirmed|pending|expired|cancelled)['\"`]",     // $in: ['pending', ...]
    "\\[[^\\]]*['\"`](?:confirmed|expired|cancelled)['\"`][^\\]]*\\]\\.includes\\(",            // ['confirmed','cancelled'].includes(x)
  ].join('|'));
  const found = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (lifecycleOnly.test(line) || statusCompare.test(line)) found.push(`${path.relative(__dirname, file)}:${index + 1}  ${line.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(found, [], 'Use require("./booking-journey") instead:\n' + found.join('\n'));
});

test('the contract is well formed: every fact named by a status is declared, with a meaning and a next step', () => {
  const contract = require('../contracts/booking-journey.json');
  for (const [status, entry] of Object.entries(contract.statuses)) {
    for (const fact of entry.facts) assert.ok(fact in contract.facts, `${status}: undeclared fact ${fact}`);
    assert.ok(entry.meaning && entry.whoActsNext, `${status}: meaning and whoActsNext are required`);
  }
  for (const status of contract.path) assert.ok(status in contract.statuses, status);
});
