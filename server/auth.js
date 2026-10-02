'use strict';
/**
 * Authentication: scrypt password hashing, server-side sessions,
 * HttpOnly cookies and CSRF protection for the admin API.
 */

const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_DAYS = 7;
const COOKIE_NAME = 'qrid_session';

/* ---------------------------- passwords ---------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1, keylen = 32;
  const hash = crypto.scryptSync(String(password), salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

/* ---------------------------- sessions ----------------------------- */

const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function createSession(adminId) {
  const token = newToken();
  const csrf = newToken(24);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, admin_id, csrf, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, adminId, csrf, expires);
  return { token, csrf, expires };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Returns { admin, csrf } for a valid session, otherwise null. */
function currentSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token, s.csrf, s.expires_at, a.id AS admin_id, a.username, a.full_name
         FROM sessions s JOIN admins a ON a.id = s.admin_id
        WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return {
    token: row.token,
    csrf: row.csrf,
    admin: { id: Number(row.admin_id), username: row.username, full_name: row.full_name },
  };
}

function cookieAttributes(req) {
  const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https';
  const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieAttributes(req)}`);
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

/* ---------------------------- middleware --------------------------- */

/** Protects API routes; attaches req.session. */
function requireAuth(req, res, next) {
  const session = currentSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  req.session = session;
  next();
}

/** Protects server-rendered admin pages (redirects to the login screen). */
function requireAuthPage(req, res, next) {
  const session = currentSession(req);
  if (!session) return res.redirect('/admin/?next=' + encodeURIComponent(req.originalUrl));
  req.session = session;
  next();
}

/** Double-submit CSRF check for state-changing API calls. */
function requireCsrf(req, res, next) {
  const sent = req.get('x-csrf-token') || '';
  if (!req.session || !sent || sent !== req.session.csrf) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token. Please sign in again.' });
  }
  next();
}

/* ------------------------- login rate limit ------------------------ */

const attempts = new Map(); // ip -> { count, first }
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function loginAllowed(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) return true;
  return rec.count < MAX_ATTEMPTS;
}

function noteFailedLogin(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) attempts.set(ip, { count: 1, first: now });
  else rec.count += 1;
}

function clearLoginAttempts(ip) {
  attempts.delete(ip);
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  currentSession,
  setSessionCookie,
  clearSessionCookie,
  cleanupSessions,
  requireAuth,
  requireAuthPage,
  requireCsrf,
  loginAllowed,
  noteFailedLogin,
  clearLoginAttempts,
  parseCookies,
};
