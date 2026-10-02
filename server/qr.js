'use strict';
/**
 * QR code / anti-counterfeit helpers.
 *
 * Design decision: the QR code does **not** contain the member's personal data.
 * It contains only an opaque, unguessable URL to this server:
 *
 *      https://your-host/v/<random-token>
 *
 * That gives three properties a plain "data QR" cannot have:
 *   1. Nobody can fabricate a QR for a member that does not exist (128-bit token).
 *   2. The information shown is always the live, current record (nothing to forge
 *      by editing a photo of the card).
 *   3. A card can be invalidated instantly ("Revoke"), which kills every copy of
 *      the QR that was ever printed or photographed.
 *
 * A short human-readable verification code (``VR-XXXXXXXX``) is derived from the
 * token and printed next to the QR, so a physical card can also be checked by eye.
 */

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { SECRET } = require('./db');

const newMemberToken = () => crypto.randomBytes(16).toString('hex');

/** Short public check code for a member: VR-4F2A-91C3 */
function verifyCode(token) {
  const mac = crypto.createHmac('sha256', SECRET).update(String(token)).digest('hex').toUpperCase();
  const raw = mac.slice(0, 8);
  return `VR-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Absolute base URL used inside QR codes.
 *
 * `https://host/anything/path` is normalised so a pasted link still yields a
 * clean QR target, and a URL without a scheme gets one.
 */
function baseUrl(req, settings) {
  let configured = (settings && settings.base_url ? String(settings.base_url) : '').trim();
  if (configured) {
    if (!/^https?:\/\//i.test(configured)) configured = `https://${configured}`;
    try {
      return new URL(configured).origin;
    } catch {
      /* fall through to the request host */
    }
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`.replace(/\/+$/, '');
}

function publicUrl(req, settings, token) {
  return `${baseUrl(req, settings)}/v/${token}`;
}

const QR_OPTIONS = {
  errorCorrectionLevel: 'H', // 30% damage tolerance - survives printing/lamination wear
  margin: 2,
  color: { dark: '#0b1220ff', light: '#ffffffff' },
};

const qrPngDataUrl = (text, width = 512) =>
  QRCode.toDataURL(text, { ...QR_OPTIONS, type: 'image/png', width });

const qrSvgString = (text) =>
  QRCode.toString(text, { ...QR_OPTIONS, type: 'svg', width: 512 });

const qrPngBuffer = (text, width = 1024) =>
  QRCode.toBuffer(text, { ...QR_OPTIONS, type: 'png', width });

module.exports = {
  newMemberToken,
  verifyCode,
  baseUrl,
  publicUrl,
  qrPngDataUrl,
  qrSvgString,
  qrPngBuffer,
};
