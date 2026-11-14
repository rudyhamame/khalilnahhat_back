const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const AUTH_COOKIES = new Set(['SID', 'SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID']);
function filterYoutubeSession(text) {
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('Session file must be under 1 MB.');
  const rows = text.split(/\r?\n/).filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_'))).map(line => line.split('\t'));
  const selected = rows.filter(fields => {
    const domain = (fields[0] || '').replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase();
    return fields.length === 7 && /^(?:[a-z0-9-]+\.)*(?:youtube|google)\.com$/.test(domain)
      && fields[5] && fields[6] && /^\d+$/.test(fields[4]);
  });
  const auth = selected.filter(fields => AUTH_COOKIES.has(fields[5]) && (!Number(fields[4]) || Number(fields[4]) * 1000 > Date.now()));
  if (!auth.length) throw new Error('This file has no unexpired YouTube/Google sign-in session. Sign in on YouTube and export a Netscape cookies.txt file.');
  return '# Netscape HTTP Cookie File\n' + selected.map(fields => fields.join('\t')).join('\n') + '\n';
}
function createYoutubeSessionStore(cookieFile) {
  const metadataFile = cookieFile ? `${cookieFile}.json` : '';
  let publicAccess = { status: 'unchecked', message: 'Public music links are downloaded without an account.', lastCheckedAt: null };
  async function atomicWrite(filename, content) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, content, { mode: 0o600 }); await fs.rename(temporary, filename); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async function metadata() { try { return JSON.parse(await fs.readFile(metadataFile, 'utf8')); } catch { return {}; } }
  async function status() {
    if (!cookieFile) return { publicAccess, configured: false, connected: false, accessStatus: 'disconnected', message: 'YouTube session storage is not configured on the server.' };
    let connected = false, sessionExpired = false;
    try {const text=await fs.readFile(cookieFile,'utf8');try{filterYoutubeSession(text);connected=true;}catch{sessionExpired=true;}}catch{/* No readable session saved. */}
    const data = await metadata();
    return {
      publicAccess: data.publicAccess || publicAccess,
      configured: true, connected, sessionExpired, authenticationMode:connected?'session':'public', accountLabel: connected ? String(data.accountLabel || 'Account label not set').slice(0, 120) : '',
      connectedAt: connected ? data.connectedAt || null : null,
      lastCheckedAt: data.lastCheckedAt || null,
      accessStatus: connected ? data.accessStatus || 'unchecked' : 'disconnected',
      message: sessionExpired?'The saved YouTube session expired. Connect a new session.':connected ? data.message || 'Session saved. Server download access has not been checked.' : 'No usable server session. Sign in on YouTube, then connect a session file here.',
    };
  }
  return {
    status,
    async save(text, accountLabel) {
      if (!cookieFile) throw new Error('YouTube session storage is not configured.');
      const filtered = filterYoutubeSession(text);
      const label = String(accountLabel || '').trim();
      if (!label || label.length > 120) throw new Error('Enter an account label of up to 120 characters.');
      await atomicWrite(cookieFile, filtered);
      await atomicWrite(metadataFile, JSON.stringify({ accountLabel: label, connectedAt: new Date().toISOString(), accessStatus: 'unchecked' }));
      return status();
    },
    async clear() {
      if (cookieFile) { await fs.rm(cookieFile, { force: true }); await fs.rm(metadataFile, { force: true }); }
      return status();
    },
    async recordPublicAccess(status, message) {
      publicAccess = { status, message, lastCheckedAt: new Date().toISOString() };
      if (cookieFile) {
        const data = await metadata();
        await atomicWrite(metadataFile, JSON.stringify({ ...data, publicAccess }));
      }
    },
    async recordAccess(accessStatus, message) {
      if (!cookieFile) return;
      const data = await metadata();
      await atomicWrite(metadataFile, JSON.stringify({ ...data, accessStatus, message, lastCheckedAt: new Date().toISOString() }));
    },
  };
}
function registerYoutubeSessionRoutes(app, { requireAdmin, upload, store, convert, normalizeUrl, isBusy = () => false, usesLocalWorker = () => false }) {
  let checkActive = false;
  const getStatus = async () => {
    const item = { ...await store.status(), processingLocation: usesLocalWorker() ? 'admin-computer' : 'server', checking: checkActive };
    if (checkActive) {
      const message = 'Downloading and converting the video to check access. This can take up to three minutes.';
      if (item.connected) Object.assign(item, { accessStatus: 'checking', message });
      else item.publicAccess = { ...item.publicAccess, status: 'checking', message };
    }
    return item;
  };
  app.get('/api/admin/youtube-session', requireAdmin, async (_request, response) => response.json({ item: await getStatus() }));
  app.post('/api/admin/youtube-session', requireAdmin, (request, response, next) => {
    upload(request, response, error => error ? response.status(400).json({ message: 'Upload one cookies.txt file under 1 MB.' }) : next());
  }, async (request, response) => {
    try {
      if (checkActive || isBusy()) return response.status(409).json({ message: 'Wait for the active conversion before changing the session.' });
      if (!request.file) return response.status(400).json({ message: 'Choose a YouTube cookies.txt session file.' });
      const item = await store.save(request.file.buffer.toString('utf8'), request.body.accountLabel);
      return response.json({ item });
    } catch (error) {
      return response.status(400).json({ message: error.code ? 'Unable to save the session file. Check private server storage.' : error.message });
    }
  });
  app.delete('/api/admin/youtube-session', requireAdmin, async (_request, response) => {
    if (checkActive || isBusy()) return response.status(409).json({ message: 'Wait for the active conversion before signing out.' });
    return response.json({ item: await store.clear() });
  });
  app.post('/api/admin/youtube-session/check', requireAdmin, async (request, response) => {
    if (!normalizeUrl(request.body?.sourceUrl)) return response.status(400).json({ message: 'Enter a YouTube music link before checking access.' });
    if (checkActive || isBusy()) return response.status(409).json({ message: 'Another conversion is running. Wait for it to finish.' });
    checkActive = true;
    // The converter persists success/failure. Keep the HTTP request short enough
    // for proxies, and expose its current state through the status endpoint.
    void Promise.resolve().then(() => convert(request.body.sourceUrl))
      .catch(() => {})
      .finally(() => { checkActive = false; });
    return response.status(202).json({ item: await getStatus() });
  });
}
module.exports = { filterYoutubeSession, createYoutubeSessionStore, registerYoutubeSessionRoutes };
