'use strict';
/** Small shared helpers. */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** dd/mm/yyyy for display; passes through anything unparseable. */
function formatDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return raw;
}

/** "02 Oct 2026, 14:31" (UTC) */
function formatDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

const initials = (name) =>
  String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();

/** Escape a value for a CSV cell. */
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** Basic sanity check for a data: image URL and its decoded size. */
function decodeDataUrlImage(dataUrl, maxBytes = 6 * 1024 * 1024) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > maxBytes) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  return { buffer: buf, ext };
}

module.exports = { esc, formatDate, formatDateTime, initials, csvCell, decodeDataUrlImage };
