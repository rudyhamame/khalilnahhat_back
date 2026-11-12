const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

// What the admin deletes stays deleted: the code must not create equipment or prices from lists of its own.
test('the equipment module no longer carries starter data or a seeding step that inserts it',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/equipment.js'),'utf8');
 assert.doesNotMatch(source,/const SEED\b/);
 assert.doesNotMatch(source,/\$setOnInsert:\s*item/);
 const equipment=require('../src/equipment');
 assert.equal(equipment.seedPlan,undefined);assert.equal(typeof equipment.ensureSeed,'function');
});
test('the server no longer re-creates default service prices',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
 assert.doesNotMatch(source,/DEFAULT_SERVICE_PRICES/);assert.doesNotMatch(source,/ensureServicePrices/);
});
test('the setup catalog is read only from the database, never merged with built-in defaults',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/setup-catalog.js'),'utf8');
 assert.doesNotMatch(source,/new Map\(defaults/);
 assert.match(source,/_meta:defaults-v1/);
});
