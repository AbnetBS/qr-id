'use strict';
/**
 * Server-rendered pages:
 *   - public verification page (what a phone sees after scanning the QR)
 *   - printable card-back (CR80 / ID-1 size) and A4 QR sheets for the admin
 * These are plain HTML so they work on any phone browser without JavaScript.
 */

const { esc, formatDate, formatDateTime } = require('./util');
const { verifyCode, qrPngDataUrl } = require('./qr');

/* ----------------------------- small bits -------------------------- */

function readableOn(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#101828' : '#ffffff';
}

const PERSON_ICON = `<svg class="placeholder" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.24-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-2.76-3.58-5-8-5Z"/></svg>`;

function shell({ title, css = '', body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/id.css">
${css}
</head>
<body class="${esc(bodyClass)}">
${body}
</body>
</html>`;
}

function brandHead(settings) {
  const logo = settings.logo_path
    ? `<img src="/media/${esc(settings.logo_path)}" alt="logo">`
    : `<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff" opacity=".85"><path d="M12 2 3 6v6c0 5 3.8 9.3 9 10 5.2-.7 9-5 9-10V6l-9-4Z"/></svg>`;
  return `<div class="verify-head" style="color:${readableOn(settings.theme_color)}">
      <div class="logo">${logo}</div>
      <div>
        <div class="org-name">${esc(settings.org_name)}</div>
        ${settings.org_name_alt ? `<div class="org-alt">${esc(settings.org_name_alt)}</div>` : ''}
        <div class="org-sub">${esc(settings.org_tagline)}</div>
      </div>
    </div>`;
}

/** Amharic wording shown under each English label. */
const AM = {
  'Member number': 'የአባል መለያ ቁጥር',
  'Verification code': 'የማረጋገጫ ኮድ',
  'Member since': 'አባል ከሆነበት',
  'Valid until': 'የሚያበቃበት',
  Organization: 'ድርጅት',
  'Department / Branch': 'ክፍል / ቅርንጫፍ',
  'National ID no.': 'የብሔራዊ መታወቂያ ቁጥር',
  'Membership type': 'የአባልነት ዓይነት',
  'Marital status': 'የጋብቻ ሁኔታ',
  Education: 'የትምህርት ደረጃ',
  Occupation: 'ሙያ',
  'Emergency contact': 'የአደጋ ጊዜ ተጠሪ',
  'Emergency phone': 'የአደጋ ጊዜ ስልክ',
  'Zone / City': 'ዞን / ከተማ',
  Woreda: 'ወረዳ',
  Kebele: 'ቀበሌ',
  'House no.': 'የቤት ቁጥር',
  Phone: 'ስልክ',
  'Alternate phone': 'ተጨማሪ ስልክ',
  Email: 'ኢሜይል',
  Region: 'ክልል',
  Address: 'አድራሻ',
  Sex: 'ጾታ',
  'Date of birth': 'የትውልድ ቀን',
  'Blood type': 'የደም ዓይነት',
  'Card valid until': 'የካርድ ማብቂያ',
  'Registered on': 'የተመዘገበበት',
};

/** English label with its Amharic line underneath. */
const lab = (label) =>
  `${esc(label)}${AM[label] ? `<span class="am">${esc(AM[label])}</span>` : ''}`;

const field = (label, value) =>
  value ? `<div class="field"><div class="k">${lab(label)}</div><div class="v">${esc(value)}</div></div>` : '';

const chip = (label, value) =>
  value ? `<div class="id-chip"><div class="k">${lab(label)}</div><div class="v">${esc(value)}</div></div>` : '';

/* ------------------------- public verify page ----------------------- */

function publicView({ member, settings, verifyUrl }) {
  const revoked = member.status !== 'active';
  const code = verifyCode(member.token);
  const photo = member.photo_path
    ? `<img src="/media/${esc(member.photo_path)}" alt="Member photo">`
    : PERSON_ICON;

  const body = `
<div class="page" style="--brand:${esc(settings.theme_color)}">
  <div class="verify-card">
    ${brandHead(settings)}
    <div class="verify-body">
      <div class="person">
        <div class="photo">${photo}</div>
        <div class="person-main">
          <div class="person-name">${esc(member.full_name)}</div>
          ${member.full_name_alt ? `<div class="person-alt">${esc(member.full_name_alt)}</div>` : ''}
          ${member.role ? `<div class="person-role">${esc(member.role)}${member.department ? ` &middot; ${esc(member.department)}` : ''}</div>` : (member.department ? `<div class="person-role">${esc(member.department)}</div>` : '')}
          <div class="badges">
            <span class="badge ${revoked ? 'bad' : 'ok'}">${revoked ? 'Revoked<span class="am">የተሰረዘ</span>' : 'Active member<span class="am">ንቁ አባል</span>'}</span>
            ${member.region ? `<span class="badge info">${esc(member.region)}</span>` : ''}
          </div>
        </div>
      </div>

      <div class="id-strip">
        ${chip('Member number', member.member_no)}
        ${chip('Verification code', code)}
        ${chip('Member since', formatDate(member.joined_date) || formatDate(member.created_at))}
        ${chip('Valid until', formatDate(member.expiry_date))}
      </div>

      <div class="fields">
        ${field('Organization', settings.org_name)}
        ${field('Membership type', member.membership_type)}
        ${field('Department / Branch', member.department)}
        ${field('National ID no.', member.national_id)}
        ${field('Sex', member.sex)}
        ${field('Date of birth', formatDate(member.dob))}
        ${field('Marital status', member.marital_status)}
        ${field('Education', member.education)}
        ${field('Occupation', member.occupation)}
        ${field('Blood type', member.blood_type)}
        ${field('Phone', member.phone)}
        ${field('Alternate phone', member.phone_alt)}
        ${field('Emergency contact', member.emergency_contact)}
        ${field('Emergency phone', member.emergency_phone)}
        ${field('Email', member.email)}
        ${field('Region', member.region)}
        ${field('Zone / City', member.zone_city)}
        ${field('Woreda', member.woreda)}
        ${field('Kebele', member.kebele)}
        ${field('House no.', member.house_no)}
        ${field('Address', member.address)}
        ${field('Card valid until', formatDate(member.expiry_date))}
        ${field('Registered on', formatDate(member.created_at))}
      </div>

      ${member.notes ? `<div class="note">${esc(member.notes)}</div>` : ''}

      <div class="verified">
        <span class="dot"></span>
        <span>Verified ${esc(formatDateTime(new Date().toISOString()))}</span>
      </div>
    </div>
  </div>
  <div class="foot">
    ${esc(settings.footer_note)}
  </div>
</div>`;

  return shell({ title: `${member.full_name} — ${settings.org_name}`, body });
}

/* ------------------------- invalid / revoked ------------------------ */

function invalidView({ settings, token }) {
  const body = `
<div class="page" style="--brand:${esc(settings.theme_color)}">
  <div class="state-card">
    <div class="icon">&#128269;</div>
    <h1>ID not recognised<span class="am">መታወቂያው አልታወቀም</span></h1>
    <p>This QR code is not in the ${esc(settings.org_name)} register.</p>
    <p class="ref">ref: ${esc(String(token || '').slice(0, 12))}</p>
  </div>
</div>`;
  return shell({ title: 'ID not recognised', body });
}

function revokedView({ member, settings }) {
  const body = `
<div class="page" style="--brand:${esc(settings.theme_color)}">
  <div class="state-card">
    <div class="icon">&#9888;&#65039;</div>
    <h1>Card revoked<span class="am">ካርዱ ተሰርዟል</span></h1>
    <p>Member number <b>${esc(member.member_no)}</b> was revoked by ${esc(settings.org_name)}
       on ${esc(formatDateTime(member.revoked_at))}. Do not accept this card.</p>
  </div>
</div>`;
  return shell({ title: 'Card revoked', body });
}

/* --------------------------- printable card ------------------------- */

function cardBackHtml({ member, settings, qrDataUrl }) {
  const revoked = member.status !== 'active';
  const logo = settings.logo_path ? `<img src="/media/${esc(settings.logo_path)}" alt="">` : '';
  return `<div class="card-back${revoked ? ' revoked' : ''}" style="--brand:${esc(settings.theme_color)}">
  <div class="cb-head" style="color:${readableOn(settings.theme_color)}">
    ${logo}
    <div>
      <div class="cb-org">${esc(settings.org_name)}</div>
      <div class="cb-tag">${esc(settings.card_title)} &middot; verification</div>
    </div>
    <div class="cb-right">${esc(member.member_no)}</div>
  </div>
  <div class="cb-body">
    <div class="cb-qr">
      <img src="${qrDataUrl}" alt="QR code">
      <div class="cb-scan">${esc(settings.verify_note)}</div>
    </div>
    <div class="cb-info">
      <div class="cb-name">${esc(member.full_name)}</div>
      ${member.full_name_alt ? `<div class="cb-alt">${esc(member.full_name_alt)}</div>` : ''}
      ${member.role ? `<div class="cb-row">Position: <b>${esc(member.role)}</b></div>` : ''}
      ${member.department ? `<div class="cb-row">Dept / Branch: <b>${esc(member.department)}</b></div>` : ''}
      ${member.phone ? `<div class="cb-row">Tel: <b>${esc(member.phone)}</b></div>` : ''}
      <div class="cb-code">${esc(verifyCode(member.token))}</div>
    </div>
  </div>
  <div class="cb-foot">
    <span>${esc(member.expiry_date ? `Valid until ${formatDate(member.expiry_date)}` : 'Valid while registered')}</span>
    <span class="spacer"></span>
    <span>${esc(settings.org_tagline)}</span>
  </div>
  <div class="cb-watermark">${revoked ? 'VOID' : 'VERIFIED'}</div>
</div>`;
}

async function printPage({ member, settings, verifyUrl, sessionToken = '' }) {
  const qrDataUrl = await qrPngDataUrl(verifyUrl, 640);
  const card = cardBackHtml({ member, settings, qrDataUrl });
  const q = sessionToken ? `?t=${encodeURIComponent(sessionToken)}` : '';
  const body = `
<div class="toolbar no-print">
  <span class="title">Card back &middot; ${esc(member.full_name)} &middot; ${esc(member.member_no)}</span>
  <span class="spacer"></span>
  <a href="${esc(verifyUrl)}" target="_blank" rel="noopener">Open public page</a>
  <a href="/api/members/${Number(member.id)}/qr.png${esc(q)}" download="qr-${esc(member.member_no)}.png">Download QR</a>
  <button onclick="window.print()">Print card</button>
  <a href="/admin/${esc(q)}">&larr; Back to admin</a>
</div>
<div class="card-sheet">${card}</div>
<p class="no-print" style="text-align:center;font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#5b6474;max-width:640px;margin:0 auto">
  A4 &middot; scale 100% &middot; headers/footers off
</p>`;
  return shell({ title: `Card back — ${member.full_name}`, body });
}

async function sheetPage({ members, settings, urlFor, sessionToken = '' }) {
  const perPage = 8;
  const pages = [];
  for (let i = 0; i < members.length; i += perPage) pages.push(members.slice(i, i + perPage));

  const rendered = await Promise.all(
    pages.map(async (page) => {
      const cards = await Promise.all(
        page.map(async (m) =>
          `<div class="sheet-cut">${cardBackHtml({
            member: m,
            settings,
            qrDataUrl: await qrPngDataUrl(urlFor(m), 640),
          })}</div>`
        )
      );
      return `<div class="sheet-page">${cards.join('\n')}</div>`;
    })
  );

  const body = `
<div class="toolbar no-print">
  <span class="title">QR sheets &middot; ${members.length} card${members.length === 1 ? '' : 's'}</span>
  <span class="spacer"></span>
  <button onclick="window.print()">Print sheet</button>
  <a href="/admin/${sessionToken ? `?t=${encodeURIComponent(sessionToken)}` : ''}">&larr; Back to admin</a>
</div>
${rendered.join('\n')}
<p class="no-print" style="text-align:center;font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#5b6474;margin:0 0 40px">
  A4 &middot; scale 100% &middot; headers/footers off
</p>`;

  return shell({ title: 'Printable QR sheets', body });
}

module.exports = { publicView, invalidView, revokedView, printPage, sheetPage, cardBackHtml, readableOn };
