// Client profile photo. The browser crops/zooms to a small square and sends it as a data URL; the id always comes from the session.
const TYPES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const MAX_BYTES = 150 * 1024;
function parse(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  const magic = TYPES[m[1]];
  if (!bytes.length || bytes.length > MAX_BYTES || !magic.every((b, i) => bytes[i] === b)) return null;
  return { type: m[1], bytes };
}
function register(app, { authFromRequest, User }) {
  app.put('/api/account/avatar', async (req, res) => {
    const user = await authFromRequest(req);
    if (!user) return res.status(401).json({ message: 'No active session.' });
    const photo = parse(req.body?.image);
    if (!photo) return res.status(400).json({ message: 'Choose a JPEG, PNG or WebP photo under 150 KB.' });
    const version = Date.now();
    await User.updateOne({ _id: user._id }, { $set: { avatar: photo.bytes, avatarType: photo.type, avatarVersion: version } });
    res.json({ avatarVersion: version });
  });
  app.delete('/api/account/avatar', async (req, res) => {
    const user = await authFromRequest(req);
    if (!user) return res.status(401).json({ message: 'No active session.' });
    await User.updateOne({ _id: user._id }, { $unset: { avatar: 1 }, $set: { avatarType: '', avatarVersion: 0 } });
    res.json({ avatarVersion: 0 });
  });
  app.get('/api/account/avatar', async (req, res) => {
    const user = await authFromRequest(req);
    if (!user) return res.status(401).json({ message: 'No active session.' });
    const u = await User.findById(user._id).select('+avatar avatarType');
    if (!u?.avatar?.length) return res.status(404).json({ message: 'No photo.' });
    res.set({ 'Content-Type': u.avatarType || 'image/jpeg', 'Cache-Control': 'private, no-cache' }).send(u.avatar);
  });
}
module.exports = { register, parse };
