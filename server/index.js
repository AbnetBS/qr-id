'use strict';
/**
 * QR ID — member ID cards with secure QR verification.
 * Express server: admin API, admin SPA, public verification pages and print pages.
 */

const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const express = require('express');

const dbModule = require('./db');
const { db, getSettings, updateSettings, nextMemberNo, seedDefaultAdmin, setFlag, pruneScans, UPLOAD_DIR } = dbModule;
const auth = require('./auth');
const createdDefaultAdmin = seedDefaultAdmin();
const members = require('./members');
const qr = require('./qr');
const views = require('./views');
const { esc, csvCell, decodeDataUrlImage } = require('./util');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

/**
 * gzip for dynamic responses (verification pages, print sheets, JSON lists).
 * Cut the bytes on every scan: a 4 KB page leaves as ~1.5 KB.
 */
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(req.get('accept-encoding') || '')) return next();
  const send = res.send.bind(res);
  res.send = function compress(body) {
    // Express only decides the Content-Type inside send(), so set it here the
    // same way (a plain string is HTML) before looking at it.
    if (typeof body === 'string' && !res.get('Content-Type')) res.type('html');
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      const type = String(res.get('Content-Type') || '');
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      if (buf.length >= 700 && !res.get('Content-Encoding') && /text|json|javascript|xml|svg/i.test(type)) {
        res.set('Content-Encoding', 'gzip');
        res.set('Vary', 'Accept-Encoding');
        res.removeHeader('Content-Length');
        return res.end(zlib.gzipSync(buf, { level: 6 }));
      }
    }
    return send(body);
  };
  next();
});

auth.cleanupSessions();
setInterval(auth.cleanupSessions, 60 * 60 * 1000).unref?.();
pruneScans();
setInterval(() => { try { pruneScans(); } catch (_) { /* never fatal */ } }, 6 * 60 * 60 * 1000).unref?.();

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

const settingsJson = (s, req) => ({
  org_name: s.org_name,
  org_name_alt: s.org_name_alt,
  org_tagline: s.org_tagline,
  card_title: s.card_title,
  id_prefix: s.id_prefix,
  theme_color: s.theme_color,
  footer_note: s.footer_note,
  verify_note: s.verify_note,
  base_url: s.base_url,
  logo_url: s.logo_path ? `/media/${s.logo_path}` : '',
  effective_base_url: qr.baseUrl(req, s),
});

/** Member + everything the admin UI needs to show/edit it. */
async function memberDetail(member, req) {
  const settings = getSettings();
  const url = qr.publicUrl(req, settings, member.token);
  return {
    ...members.toAdminJson(member),
    verify_code: qr.verifyCode(member.token),
    public_url: url,
    qr_png: await qr.qrPngDataUrl(url, 320),
    scan_count: members.scanCount(member.id),
    last_scan: members.lastScan(member.id),
  };
}

function requireIdParam(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || !members.getMember(id)) {
    res.status(404).json({ error: 'Member not found' });
    return null;
  }
  return id;
}

/* ---------------------------------------------------------------- *
 * Auth API
 * ---------------------------------------------------------------- */

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const waitMs = auth.lockoutRemaining(ip);
  if (waitMs > 0) {
    const minutes = Math.max(1, Math.ceil(waitMs / 60000));
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    });
  }
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);

  if (!admin || !auth.verifyPassword(password, admin.password_hash)) {
    auth.noteFailedLogin(ip);
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  auth.clearLoginAttempts(ip);
  db.prepare("UPDATE admins SET last_login = datetime('now') WHERE id = ?").run(admin.id);
  const session = auth.createSession(Number(admin.id));
  auth.setSessionCookie(req, res, session.token);
  res.json({
    ok: true,
    // The cookie is the real credential; `token` is only a fallback for
    // embedded browsers that drop third-party cookies (see auth.js).
    token: session.token,
    csrf: session.csrf,
    admin: { id: Number(admin.id), username: admin.username, full_name: admin.full_name },
    settings: settingsJson(getSettings(), req),
  });
});

app.post('/api/logout', (req, res) => {
  const session = auth.currentSession(req);
  auth.destroySession(session ? session.token : auth.parseCookies(req)[auth.COOKIE_NAME]);
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = auth.touchSession(req, res, auth.currentSession(req));
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  const settings = getSettings();
  res.json({
    admin: session.admin,
    token: session.token,
    csrf: session.csrf,
    settings: settingsJson(settings, req),
    // True until the seeded admin password is changed (survives restarts).
    default_password: Number(settings.pw_changed) !== 1,
  });
});

app.post('/api/password', auth.requireAuth, auth.requireCsrf, (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.admin.id);
  if (!auth.verifyPassword(current, admin.password_hash)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), admin.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token <> ?').run(admin.id, req.session.token);
  setFlag('pw_changed', 1);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- *
 * Members API
 * ---------------------------------------------------------------- */

app.get('/api/stats', auth.requireAuth, (req, res) => {
  res.json({ ...members.stats(), next_member_no: nextMemberNo() });
});

app.get('/api/members', auth.requireAuth, (req, res) => {
  const rows = members.listMembers({ q: req.query.q || '', status: req.query.status || '' });
  const counts = members.scanCounts();
  res.json({
    members: rows.map((m) => ({
      ...members.toAdminJson(m),
      scan_count: counts.get(m.id) || 0,
    })),
  });
});

app.post('/api/members', auth.requireAuth, auth.requireCsrf, async (req, res) => {
  const data = { ...(req.body || {}) };
  if (typeof data.photo_path === 'string' && data.photo_path.startsWith('data:image/')) {
    const saved = members.savePhoto(data.photo_path);
    if (!saved) return res.status(400).json({ error: 'Could not read that photo file' });
    data.photo_path = saved;
  } else {
    data.photo_path = '';
  }
  if (!String(data.full_name || '').trim()) return res.status(400).json({ error: 'Full name is required' });

  const member = members.createMember(data);
  res.status(201).json({ member: await memberDetail(member, req) });
});

app.get('/api/members/:id', auth.requireAuth, async (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  const member = members.getMember(id);
  res.json({
    member: await memberDetail(member, req),
    scans: members.getScans(id, 15),
  });
});

app.put('/api/members/:id', auth.requireAuth, auth.requireCsrf, async (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  const member = members.updateMember(id, { ...(req.body || {}) });
  res.json({ member: await memberDetail(member, req) });
});

app.delete('/api/members/:id', auth.requireAuth, auth.requireCsrf, (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  members.deleteMember(id);
  res.json({ ok: true });
});

app.post('/api/members/:id/revoke', auth.requireAuth, auth.requireCsrf, async (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  const member = members.setStatus(id, 'revoked');
  res.json({ member: await memberDetail(member, req) });
});

app.post('/api/members/:id/activate', auth.requireAuth, auth.requireCsrf, async (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  const member = members.setStatus(id, 'active');
  res.json({ member: await memberDetail(member, req) });
});

/** Issue a brand-new QR: all previously printed copies become invalid. */
app.post('/api/members/:id/reissue', auth.requireAuth, auth.requireCsrf, async (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  const member = members.reissueToken(id);
  res.json({ member: await memberDetail(member, req) });
});

app.get('/api/members/:id/scans', auth.requireAuth, (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  res.json({ scans: members.getScans(id, 100), total: members.scanCount(id) });
});

app.get('/api/members/:id/qr.png', auth.requireAuth, async (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  const member = members.getMember(id);
  const url = qr.publicUrl(req, getSettings(), member.token);
  const buf = await qr.qrPngBuffer(url, 1200);
  res.type('png').set('Content-Disposition', `attachment; filename="qr-${member.member_no}.png"`).send(buf);
});

app.get('/api/members/:id/qr.svg', auth.requireAuth, async (req, res) => {
  const id = requireIdParam(req, res);
  if (!id) return;
  const member = members.getMember(id);
  const url = qr.publicUrl(req, getSettings(), member.token);
  res.type('svg').send(await qr.qrSvgString(url));
});

/** CSV export of the whole register (backup / spreadsheet use). */
app.get('/api/export.csv', auth.requireAuth, (req, res) => {
  const rows = members.listMembers({});
  const cols = [
    'member_no', 'full_name', 'full_name_alt', 'sex', 'dob', 'phone', 'phone_alt', 'email',
    'region', 'address', 'role', 'department', 'joined_date', 'expiry_date', 'blood_type',
    'status', 'notes', 'created_at',
  ];
  const lines = [cols.join(','), ...rows.map((m) => cols.map((c) => csvCell(m[c])).join(','))];
  res
    .type('text/csv')
    .set('Content-Disposition', 'attachment; filename="members.csv"')
    .send('\uFEFF' + lines.join('\r\n'));
});

/* ---------------------------------------------------------------- *
 * Settings API
 * ---------------------------------------------------------------- */

app.put('/api/settings', auth.requireAuth, auth.requireCsrf, (req, res) => {
  const patch = {};
  for (const key of Object.keys(dbModule.DEFAULTS)) {
    if (req.body && req.body[key] !== undefined) patch[key] = req.body[key];
  }
  const updated = updateSettings(patch);
  res.json({ settings: settingsJson(updated, req) });
});

app.post('/api/settings/logo', auth.requireAuth, auth.requireCsrf, (req, res) => {
  const dataUrl = req.body?.logo;
  const current = getSettings();
  if (!dataUrl || dataUrl === 'remove') {
    members.deletePhotoFile(current.logo_path);
    updateSettings({ logo_path: '' });
    return res.json({ settings: settingsJson(getSettings(), req) });
  }
  const decoded = decodeDataUrlImage(dataUrl, 3 * 1024 * 1024);
  if (!decoded) return res.status(400).json({ error: 'Could not read that image file' });
  const name = `logo-${Date.now()}.${decoded.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), decoded.buffer);
  members.deletePhotoFile(current.logo_path);
  updateSettings({ logo_path: name });
  res.json({ settings: settingsJson(getSettings(), req) });
});

/* ---------------------------------------------------------------- *
 * Public verification pages
 * ---------------------------------------------------------------- */

const recentScans = new Map(); // dedupe: token -> timestamp

app.get('/v/:token', (req, res) => {
  const settings = getSettings();
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return res.status(404).send(views.invalidView({ settings, token }));
  }
  const member = members.getMemberByToken(token);
  if (!member) {
    return res.status(404).send(views.invalidView({ settings, token }));
  }
  if (member.status !== 'active') {
    members.logScan(member.id, token, req, 'revoked');
    return res.status(410).send(views.revokedView({ member, settings }));
  }

  // Log a scan, but collapse repeat views from the same device within 60 seconds.
  const key = `${token}|${req.ip}`;
  const now = Date.now();
  if (!(recentScans.get(key) > now - 60_000)) {
    members.logScan(member.id, token, req, 'valid');
  }
  recentScans.set(key, now);
  if (recentScans.size > 5000) recentScans.clear();

  res.send(
    views.publicView({
      member,
      settings,
      verifyUrl: qr.publicUrl(req, settings, member.token),
    })
  );
});

app.get('/media/:file', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^[A-Za-z0-9._-]{6,120}$/.test(file) || file.includes('..')) {
    return res.status(400).end();
  }
  const full = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(full);
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'qr-id' }));

/* ---------------------------------------------------------------- *
 * Admin pages (server rendered)
 * ---------------------------------------------------------------- */

app.get('/admin/print/:id', auth.requireAuthPage, async (req, res) => {
  const member = members.getMember(Number(req.params.id));
  if (!member) return res.status(404).send('Member not found');
  const settings = getSettings();
  res.send(
    await views.printPage({
      member,
      settings,
      verifyUrl: qr.publicUrl(req, settings, member.token),
      sessionToken: req.session.token,
    })
  );
});

app.get('/admin/sheet', auth.requireAuthPage, async (req, res) => {
  const settings = getSettings();
  const ids = String(req.query.ids || '')
    .split(',')
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);

  const rows = ids.length
    ? ids.map((id) => members.getMember(id)).filter(Boolean)
    : members.listMembers({ status: req.query.status === 'all' ? '' : 'active' });

  if (!rows.length) return res.status(404).send('No members to print');
  res.send(
    await views.sheetPage({
      members: rows,
      settings,
      urlFor: (m) => qr.publicUrl(req, settings, m.token),
      sessionToken: req.session.token,
    })
  );
});

/* ---------------------------------------------------------------- *
 * Static files + errors
 * ---------------------------------------------------------------- */

/**
 * Static files: read once, gzip once, then served from memory with an ETag.
 * Costs a few hundred KB of RAM and removes all disk I/O (and most of the
 * bandwidth) for the admin panel and the public CSS.
 */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const staticCache = new Map();

function staticEntry(file) {
  const st = fs.statSync(file);
  const cached = staticCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const raw = fs.readFileSync(file);
  const entry = {
    mime: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    raw,
    gz: zlib.gzipSync(raw, { level: 9 }),
    etag: `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
  staticCache.set(file, entry);
  return entry;
}

/** URL path -> file inside public/, or null. Blocks anything outside it. */
function resolveStaticFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(String(urlPath).split('?')[0]);
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const full = path.join(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  for (const candidate of [full, `${full}.html`, path.join(full, 'index.html')]) {
    try {
      if (candidate.startsWith(PUBLIC_DIR) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = resolveStaticFile(req.path);
  if (!file) return next();
  const entry = staticEntry(file);
  const isHtml = entry.mime.startsWith('text/html');
  res.set('Content-Type', entry.mime);
  res.set('ETag', entry.etag);
  // HTML revalidates (so a redeploy is picked up); assets may be cached a while.
  res.set('Cache-Control', isHtml ? 'no-cache' : 'public, max-age=600');
  if (req.get('if-none-match') === entry.etag) return res.status(304).end();

  const useGzip = /\bgzip\b/.test(req.get('accept-encoding') || '');
  const body = useGzip ? entry.gz : entry.raw;
  if (useGzip) {
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
  }
  res.set('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That file is too large — use an image under 8 MB.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request body' });
  }
  console.error(err);
  res.status(err.status || err.statusCode || 500).json({ error: 'Server error' });
});

app.listen(PORT, HOST, () => {
  const s = getSettings();
  console.log(`\n  QR ID server running  ->  http://localhost:${PORT}`);
  console.log(`  Admin panel           ->  http://localhost:${PORT}/admin`);
  console.log(`  Organization          ->  ${s.org_name}`);
  if (createdDefaultAdmin) {
    console.log('\n  First run: sign in with  admin / admin123  and change the password.');
  }
  console.log('');
});

module.exports = app;
