'use strict';
/**
 * Database layer.
 *
 * Uses Node's built-in SQLite (node:sqlite, Node >= 22.5) so the project has
 * no native build step. The database file lives in ./data (git-ignored).
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'qrid.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  org_name      TEXT NOT NULL DEFAULT 'Your Organization',
  org_name_alt  TEXT NOT NULL DEFAULT '',
  org_tagline   TEXT NOT NULL DEFAULT 'Official Member Identity Card',
  card_title    TEXT NOT NULL DEFAULT 'MEMBER ID',
  id_prefix     TEXT NOT NULL DEFAULT 'MBR',
  theme_color   TEXT NOT NULL DEFAULT '#0B5D3B',
  logo_path     TEXT NOT NULL DEFAULT '',
  footer_note   TEXT NOT NULL DEFAULT 'This card is the property of the issuing organization. If found, please return it to the nearest office.',
  verify_note   TEXT NOT NULL DEFAULT 'Scan the QR code to verify this member online.',
  base_url      TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  member_no    TEXT NOT NULL UNIQUE,
  full_name    TEXT NOT NULL,
  full_name_alt TEXT NOT NULL DEFAULT '',
  sex          TEXT NOT NULL DEFAULT '',
  dob          TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  phone_alt    TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  region       TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT '',
  department   TEXT NOT NULL DEFAULT '',
  joined_date  TEXT NOT NULL DEFAULT '',
  expiry_date  TEXT NOT NULL DEFAULT '',
  blood_type   TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  photo_path   TEXT NOT NULL DEFAULT '',
  token        TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active',
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_members_token  ON members(token);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);

CREATE TABLE IF NOT EXISTS scans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip         TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  result     TEXT NOT NULL DEFAULT 'valid'
);

CREATE INDEX IF NOT EXISTS idx_scans_member ON scans(member_id);
`);

/* ------------------------------------------------------------------ *
 * Secrets (stable across restarts -> printed verification codes stay valid)
 * ------------------------------------------------------------------ */

function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (_) { /* first run */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const SECRET = loadSecret();

/* ------------------------------------------------------------------ *
 * Seed data
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  org_name: 'Your Organization',
  org_name_alt: '',
  org_tagline: 'Official Member Identity Card',
  card_title: 'MEMBER ID',
  id_prefix: 'MBR',
  theme_color: '#0B5D3B',
  logo_path: '',
  footer_note:
    'This card is the property of the issuing organization. If found, please return it to the nearest office.',
  verify_note: 'Scan the QR code to verify this member online.',
  base_url: '',
};

const settingsRow = db.prepare('SELECT id FROM settings WHERE id = 1').get();
if (!settingsRow) {
  db.prepare('INSERT INTO settings (id) VALUES (1)').run();
}

/**
 * Create the first admin account (admin / admin123) when the register is empty.
 * `auth` is required lazily on purpose: auth.js imports this module, so requiring
 * it at load time would create a circular import.
 * @returns {boolean} true when a default admin was just created
 */
function seedDefaultAdmin() {
  const adminCount = db.prepare('SELECT COUNT(*) AS n FROM admins').get();
  if (Number(adminCount.n) > 0) return false;
  const { hashPassword } = require('./auth');
  db.prepare('INSERT INTO admins (username, password_hash, full_name) VALUES (?, ?, ?)').run(
    'admin',
    hashPassword('admin123'),
    'Administrator'
  );
  return true;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const getSettings = () => db.prepare('SELECT * FROM settings WHERE id = 1').get();

function updateSettings(patch) {
  const allowed = Object.keys(DEFAULTS);
  const fields = Object.keys(patch).filter((k) => allowed.includes(k));
  if (fields.length) {
    const sql = `UPDATE settings SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`;
    db.prepare(sql).run(...fields.map((f) => String(patch[f] ?? '')));
  }
  return getSettings();
}

/** Next sequential member number, e.g. MBR-2026-0007 */
function nextMemberNo() {
  const prefix = (getSettings().id_prefix || 'MBR').trim().toUpperCase().replace(/\s+/g, '-');
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const rows = db
    .prepare("SELECT member_no FROM members WHERE member_no LIKE ?")
    .all(like);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.member_no).split('-').pop(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}-${year}-${String(max + 1).padStart(4, '0')}`;
}

module.exports = {
  db,
  DATA_DIR,
  UPLOAD_DIR,
  SECRET,
  DEFAULTS,
  getSettings,
  updateSettings,
  nextMemberNo,
  seedDefaultAdmin,
};
