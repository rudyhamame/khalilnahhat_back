const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
  if (!storedValue || !storedValue.includes(':')) {
    return false;
  }

  const [salt, storedHash] = storedValue.split(':');
  const computedHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(computedHash, 'hex'));
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  createSessionToken,
  hashPassword,
  verifyPassword,
};
