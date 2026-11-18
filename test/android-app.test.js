const test=require('node:test'),assert=require('node:assert');
process.env.ANDROID_LINK_SECRET='s';
const {make,check}=require('../src/android-app');
test('link tokens verify and reject tampering',()=>{const t=make('a@b.co');assert.ok(check(t));assert.ok(!check(t.slice(0,-2)+'xx'));assert.ok(!check('x.y'));});
