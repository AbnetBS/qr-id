'use strict';
/** Member records: create / read / update / delete, tokens, photos and scans. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, UPLOAD_DIR, nextMemberNo } = require('./db');
const { newMemberToken } = require('./qr');
const { decodeDataUrlImage } = require('./util');

/* Editable columns on the member form, in form order. */
const FIELDS = [
  'full_name', 'full_name_alt', 'sex', 'dob',
  'phone', 'phone_alt', 'email',
  'region', 'address',
  'role', 'department', 'joined_date', 'expiry_date', 'blood_type',
  'notes', 'photo_path', 'status', 'member_no',
];

const TEXT_FIELDS = FIELDS.filter((f) => f !== 'photo_path');

/* ------------------------------- photos ---------------------------- */

function savePhoto(dataUrl) {
  const decoded = decodeDataUrlImage(dataUrl);
  if (!decoded) return null;
  const name = `${crypto.randomUUID()}.${decoded.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), decoded.buffer);
  return name;
}

function deletePhotoFile(name) {
  if (!name) return;
  const file = path.join(UPLOAD_DIR, path.basename(String(name)));
  fs.rmSync(file, { force: true });
}

/* ------------------------------- CRUD ------------------------------ */

function uniqueMemberNo(preferred) {
  let candidate = String(preferred || '').trim();
  if (!candidate) return nextMemberNo();
  // If the admin typed a number that already exists, keep it unique.
  let n = 1;
  let test = candidate;
  while (db.prepare('SELECT 1 FROM members WHERE member_no = ?').get(test)) {
    test = `${candidate}-${n++}`;
    if (n > 500) break;
  }
  return test;
}

function createMember(data) {
  const member = {};
  for (const f of TEXT_FIELDS) member[f] = String(data[f] ?? '').trim();
  member.status = data.status === 'revoked' ? 'revoked' : 'active';
  member.member_no = uniqueMemberNo(member.member_no);
  member.full_name = member.full_name || 'Unnamed member';
  member.photo_path = data.photo_path ? String(data.photo_path) : '';
  member.token = newMemberToken();

  const cols = [...FIELDS, 'token'];
  const sql = `INSERT INTO members (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const info = db.prepare(sql).run(...cols.map((c) => member[c]));
  return getMember(Number(info.lastInsertRowid));
}

function updateMember(id, data) {
  const existing = getMember(id);
  if (!existing) return null;

  const member = {};
  for (const f of TEXT_FIELDS) {
    member[f] = data[f] === undefined ? existing[f] : String(data[f] ?? '').trim();
  }
  member.full_name = member.full_name || existing.full_name;
  member.status = data.status === 'revoked' ? 'revoked' : (data.status === 'active' ? 'active' : existing.status);

  if (String(member.member_no) !== String(existing.member_no)) {
    member.member_no = uniqueMemberNo(member.member_no);
  }

  // photo: undefined = keep, null = remove, data URL = replace
  let photo = existing.photo_path;
  if (data.photo_path === null || data.photo_path === '') {
    deletePhotoFile(existing.photo_path);
    photo = '';
  } else if (typeof data.photo_path === 'string' && data.photo_path.startsWith('data:image/')) {
    const saved = savePhoto(data.photo_path);
    if (saved) {
      deletePhotoFile(existing.photo_path);
      photo = saved;
    }
  }
  member.photo_path = photo;

  db.prepare(
    `UPDATE members SET ${TEXT_FIELDS.map((f) => `${f} = ?`).join(', ')}, photo_path = ?,
       status = ?, revoked_at = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    ...TEXT_FIELDS.map((f) => member[f]),
    member.photo_path,
    member.status,
    member.status === 'revoked' ? (existing.revoked_at || new Date().toISOString()) : null,
    id
  );

  return getMember(id);
}

const getMember = (id) => db.prepare('SELECT * FROM members WHERE id = ?').get(Number(id)) || null;
const getMemberByToken = (token) =>
  db.prepare('SELECT * FROM members WHERE token = ?').get(String(token || '')) || null;

function listMembers({ q = '', status = '' } = {}) {
  const where = [];
  const params = [];
  const search = String(q || '').trim();
  if (search) {
    where.push(`(full_name LIKE ? OR full_name_alt LIKE ? OR member_no LIKE ? OR phone LIKE ?
                 OR role LIKE ? OR department LIKE ? OR region LIKE ? OR email LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like, like);
  }
  if (status === 'active' || status === 'revoked') {
    where.push('status = ?');
    params.push(status);
  }
  const sql = `SELECT * FROM members ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY full_name COLLATE NOCASE ASC`;
  return db.prepare(sql).all(...params);
}

function deleteMember(id) {
  const member = getMember(id);
  if (!member) return false;
  db.prepare('DELETE FROM members WHERE id = ?').run(Number(id));
  deletePhotoFile(member.photo_path);
  return true;
}

/** New token -> every previously printed / photographed QR stops working. */
function reissueToken(id) {
  const member = getMember(id);
  if (!member) return null;
  const token = newMemberToken();
  db.prepare(
    "UPDATE members SET token = ?, status = 'active', revoked_at = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(token, Number(id));
  return getMember(id);
}

function setStatus(id, status) {
  const member = getMember(id);
  if (!member) return null;
  db.prepare(
    "UPDATE members SET status = ?, revoked_at = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, status === 'revoked' ? new Date().toISOString() : null, Number(id));
  return getMember(id);
}

/* ------------------------------- scans ----------------------------- */

function logScan(memberId, token, req, result = 'valid') {
  try {
    db.prepare('INSERT INTO scans (member_id, token, ip, user_agent, result) VALUES (?, ?, ?, ?, ?)').run(
      Number(memberId),
      String(token),
      String(req.ip || req.socket?.remoteAddress || '').slice(0, 60),
      String(req.get('user-agent') || '').slice(0, 240),
      result
    );
  } catch (_) { /* logging must never break the page */ }
}

const getScans = (memberId, limit = 25) =>
  db.prepare('SELECT * FROM scans WHERE member_id = ? ORDER BY id DESC LIMIT ?').all(Number(memberId), Number(limit));

const scanCount = (memberId) =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM scans WHERE member_id = ?').get(Number(memberId)).n);

const lastScan = (memberId) =>
  db.prepare('SELECT * FROM scans WHERE member_id = ? ORDER BY id DESC LIMIT 1').get(Number(memberId)) || null;

/* ------------------------------- stats ----------------------------- */

function stats() {
  const one = (sql, ...p) => Number(db.prepare(sql).get(...p).n);
  return {
    total: one('SELECT COUNT(*) AS n FROM members'),
    active: one("SELECT COUNT(*) AS n FROM members WHERE status = 'active'"),
    revoked: one("SELECT COUNT(*) AS n FROM members WHERE status = 'revoked'"),
    scans: one('SELECT COUNT(*) AS n FROM scans'),
    scans_today: one("SELECT COUNT(*) AS n FROM scans WHERE date(scanned_at) = date('now')"),
    scans_7d: one("SELECT COUNT(*) AS n FROM scans WHERE scanned_at >= datetime('now', '-7 days')"),
    added_7d: one("SELECT COUNT(*) AS n FROM members WHERE created_at >= datetime('now', '-7 days')"),
  };
}

/** Full member row -> shape used by the admin UI. */
const toAdminJson = (m, extras = {}) => ({
  id: Number(m.id),
  member_no: m.member_no,
  full_name: m.full_name,
  full_name_alt: m.full_name_alt,
  sex: m.sex,
  dob: m.dob,
  phone: m.phone,
  phone_alt: m.phone_alt,
  email: m.email,
  region: m.region,
  address: m.address,
  role: m.role,
  department: m.department,
  joined_date: m.joined_date,
  expiry_date: m.expiry_date,
  blood_type: m.blood_type,
  notes: m.notes,
  status: m.status,
  photo_url: m.photo_path ? `/media/${m.photo_path}` : '',
  token: m.token,
  created_at: m.created_at,
  updated_at: m.updated_at,
  ...extras,
});

module.exports = {
  FIELDS,
  createMember,
  updateMember,
  getMember,
  getMemberByToken,
  listMembers,
  deleteMember,
  reissueToken,
  setStatus,
  savePhoto,
  deletePhotoFile,
  logScan,
  getScans,
  scanCount,
  lastScan,
  stats,
  toAdminJson,
};
