const crypto = require('node:crypto');
const { createSessionToken } = require('./security');
const slots = ['sessionToken', 'androidSessionToken'];
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
let developmentKey;
function encryptionKey() {
  if (/^[a-f0-9]{64}$/i.test(process.env.SESSION_ENCRYPTION_KEY || '')) return Buffer.from(process.env.SESSION_ENCRYPTION_KEY, 'hex');
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_ENCRYPTION_KEY must be configured.');
  return developmentKey ||= crypto.randomBytes(32);
}
function seal(token) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}
function unseal(value) {
  try {
    const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
  } catch { return null; }
}
function expiry(user, now = Date.now()) {
  const admin = require('./admin-role').isAdminUser(user);
  return { absolute: new Date(now + (admin ? 12 * 3600000 : 7 * 86400000)), idle: admin ? 3600000 : 86400000 };
}
function slotFields(field, token, user, now = Date.now()) {
  return { [field]: '', [field + 'Hash']: digest(token), [field + 'Encrypted']: seal(token),
    [field + 'ExpiresAt']: expiry(user, now).absolute, [field + 'LastSeenAt']: new Date(now) };
}
function sessionField(user, request, isAdminUser) {
  return isAdminUser(user) && String(request.headers?.['x-echo-client'] || '').toLowerCase() === 'android' ? 'androidSessionToken' : 'sessionToken';
}
async function issueSession(user, request, isAdminUser) {
  const token = createSessionToken(), field = sessionField(user, request, isAdminUser);
  Object.assign(user, slotFields(field, token, user));
  if (isAdminUser(user)) user.lastLoginAt = new Date();
  await user.save(); return token;
}
function sessionQuery(token) {
  if (!validToken(token)) return { _id: null };
  return { isBlocked: { $ne: true }, $or: slots.map(field => ({ [field + 'Hash']: digest(token) })) };
}
function slotActive(user, field, now = Date.now()) {
  return !!user && !user.isBlocked && !!user[field + 'Hash'] &&
    +new Date(user[field + 'ExpiresAt']) > now &&
    +new Date(user[field + 'LastSeenAt']) > now - expiry(user, now).idle;
}
function matchingSlot(user, token, binding) {
  if (token !== undefined && !validToken(token)) return undefined;
  if (binding !== undefined && !/^[a-f0-9]{64}$/.test(binding)) return undefined;
  const hash = validToken(token) ? digest(token) : binding;
  return slots.find(field => slotActive(user, field) && (!hash || user[field + 'Hash'] === hash));
}
async function authenticate(User, token) {
  if (!validToken(token)) return null;
  const user = await User.findOne(sessionQuery(token));
  const field = matchingSlot(user, token);
  if (!field) return null;
  // Bound activity writes; conditional update cannot revive a revoked/replaced session.
  if (Date.now() - +new Date(user[field + 'LastSeenAt']) >= 60000) {
    const result = await User.updateOne({ _id: user._id, isBlocked: { $ne: true }, [field + 'Hash']: digest(token),
      [field + 'ExpiresAt']: { $gt: new Date() }, [field + 'LastSeenAt']: { $gt: new Date(Date.now() - expiry(user).idle) } },
      { $max: { [field + 'LastSeenAt']: new Date() } }, { timestamps: false });
    if (!result.matchedCount) return null;
  }
  return user;
}
function sessionActor(user, token) {
  const actor = { ...(user.toObject ? user.toObject() : user), id: String(user._id || user.id) };
  for (const name of Object.keys(actor)) if (/password|sessionToken|verifyToken|resetToken/i.test(name)) delete actor[name];
  actor.sessionToken = token; return actor;
}
function selectSession(user, token, binding) {
  const field = matchingSlot(user, token, binding);
  if (!field) return null;
  if (validToken(token)) return token;
  const value = unseal(user[field + 'Encrypted'] || '');
  return validToken(value) && digest(value) === user[field + 'Hash'] ? value : null;
}
function clearFields() {
  return Object.fromEntries(slots.flatMap(field => [[field, ''], [field + 'Hash', ''], [field + 'Encrypted', ''],
    [field + 'ExpiresAt', null], [field + 'LastSeenAt', null]]));
}
async function revokeSession(User, user, token) {
  const field = matchingSlot(user, token);
  if (!field) return;
  const clear = clearFields();
  await User.updateOne({ _id: user._id, [field + 'Hash']: digest(token) },
    { $set: Object.fromEntries(Object.entries(clear).filter(([key]) => key.startsWith(field))) });
}
async function migrateLegacySessions(User) {
  encryptionKey(); // Fail closed before listening if the production secret is missing.
  await User.init();
  await User.updateMany({ verifyTokenHash: /^[a-f0-9]{64}$/, verifyExpires: null },
    { $set: { verifyExpires: new Date(Date.now() + 86400000) } }, { timestamps: false });
  for await (const user of User.find({ $or: slots.map(field => ({ [field]: { $type: 'string', $nin: [''] } })) }).cursor()) {
    for (const field of slots) {
      const token = user[field]; if (!token) continue;
      const update = validToken(token) && !user.isBlocked ? slotFields(field, token, user) :
        Object.fromEntries(Object.entries(clearFields()).filter(([key]) => key.startsWith(field)));
      await User.updateOne({ _id: user._id, [field]: token }, { $set: update }, { timestamps: false });
    }
  }
}
module.exports = { sessionField, issueSession, sessionQuery, sessionActor, selectSession, revokeSession,
  authenticate, clearFields, migrateLegacySessions };
