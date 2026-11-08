const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
let active = 0;
const queue = [];
async function derive(password, salt, cost) {
  if (active >= 2) {
    if (queue.length >= 16) throw Object.assign(new Error('Authentication is busy. Please retry shortly.'), { status: 503 });
    await new Promise(resolve => queue.push(resolve));
  } else active++;
  try { return await scrypt(password, salt, 64, { N: cost, maxmem: 64 * 1024 * 1024 }); }
  finally { const next = queue.shift(); if (next) next(); else active--; }
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 32768);
  return `scrypt$32768$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, storedValue) {
  let salt = '00000000000000000000000000000000', cost = 16384, expected = Buffer.alloc(64), valid = false;
  if (typeof storedValue === 'string') {
    const legacy = storedValue.match(/^([a-f0-9]{32}):([a-f0-9]{128})$/);
    const current = storedValue.match(/^scrypt\$(32768)\$([a-f0-9]{32})\$([a-f0-9]{128})$/);
    if (legacy) { password = password.trim(); salt = legacy[1]; expected = Buffer.from(legacy[2], 'hex'); valid = true; }
    if (current) { cost = Number(current[1]); salt = current[2]; expected = Buffer.from(current[3], 'hex'); valid = true; }
  }
  // Equal work for missing accounts; malformed stored values fail without throwing.
  const computed = await derive(password, salt, cost);
  return crypto.timingSafeEqual(expected, computed) && valid;
}
function createSessionToken() { return crypto.randomBytes(32).toString('hex'); }
module.exports = { createSessionToken, hashPassword, verifyPassword };
