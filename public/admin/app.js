'use strict';
/* Admin panel — plain JavaScript, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  csrf: null,
  admin: null,
  settings: null,
  members: [],
  editing: null,      // member id currently in the modal
  photoData: null,    // new photo as data URL
  photoRemoved: false,
  defaultPassword: false,
  token: null,        // session token fallback (see api())
};

/* The session normally travels in an HttpOnly cookie. Browsers that block
   third-party cookies (for example when this page is inside an embedded frame)
   drop that cookie, so the login response also gives us a token which we send
   as an Authorization header.

   The token is kept in sessionStorage, not only in memory: without it a reload
   (or opening a print link in a new tab) would lose the session wherever the
   cookie is blocked. sessionStorage is cleared when the tab is closed. */
const TOKEN_KEY = 'qrid_token';

try {
  const t = new URLSearchParams(location.search).get('t') || sessionStorage.getItem(TOKEN_KEY) || '';
  if (t) {
    state.token = t;
    sessionStorage.setItem(TOKEN_KEY, t);
    if (new URLSearchParams(location.search).get('t')) {
      history.replaceState(null, '', location.pathname);
    }
  }
} catch { /* ignore */ }

const PERSON_SVG = `<svg class="ph" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.24-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-2.76-3.58-5-8-5Z"/></svg>`;

const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ------------------------------ plumbing --------------------------- */

/** Appends the session token to a URL (for links opened in a new tab). */
function withToken(url) {
  if (!state.token) return url;
  return url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(state.token);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (method !== 'GET' && state.csrf) headers['x-csrf-token'] = state.csrf;

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }

  if (res.status === 401 && path !== '/api/login') {
    // Genuinely signed out (idle for longer than the session window, server
    // restarted on a host with a fresh database, or credentials revoked).
    signOut('Your session ended. Please sign in again.');
    throw new Error('Your session ended. Please sign in again.');
  }
  if (res.status === 403 && path !== '/api/login') {
    signOut('Session invalid. Please sign in again.');
    throw new Error('Session invalid. Please sign in again.');
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/** Drop the session everywhere and show the login screen with a reason. */
function signOut(message) {
  state.csrf = null;
  state.token = null;
  state.admin = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  showLogin(message);
}

let toastTimer = 0;
function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  clearTimeout(toastTimer);
  setTimeout(() => el.remove(), kind === 'err' ? 5200 : 3200);
}

function confirmDialog(title, text, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-yes').textContent = confirmLabel;
    $('#confirm-modal').classList.remove('hidden');
    const done = (value) => {
      $('#confirm-modal').classList.add('hidden');
      $('#confirm-yes').onclick = null;
      $('#confirm-no').onclick = null;
      resolve(value);
    };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
  });
}

const fmtDate = (v) => {
  const raw = String(v || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : raw;
};

const fmtDateTime = (v) => {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

async function fileToDataUrl(file, maxDim = 1000, quality = 0.85) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file is not a readable image'));
    image.src = dataUrl;
  });

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (scale === 1 && dataUrl.length <= 1_400_000) return dataUrl;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/* -------------------------------- boot ----------------------------- */

async function boot() {
  bindEvents();
  try {
    const me = await api('/api/me');
    state.admin = me.admin;
    state.csrf = me.csrf;
    state.settings = me.settings;
    state.defaultPassword = !!me.default_password;
    showApp();
  } catch {
    // A 401/403 already sent us to the login screen with a reason — keep it.
    if ($('#login-view').classList.contains('hidden')) showLogin();
  }
}

/** Amharic wording for the messages the login screen can show. */
const AM_ERRORS = [
  ['Wrong username or password', 'የተጠቃሚ ስም ወይም የይለፍ ቃል ተሳስቷል'],
  ['Too many failed attempts', 'ብዙ ሙከራዎች። ከጥቂት ደቂቃዎች በኋላ ይሞክሩ።'],
  ['Your session ended', 'ክፍለ ጊዜው አልቋል። እባክዎ እንደገና ይግቡ።'],
  ['Session invalid', 'ክፍለ ጊዜው ልክ አይደለም። እባክዎ እንደገና ይግቡ።'],
];

function setLoginError(message) {
  const box = $('#login-error');
  if (!box) return;
  const text = String(message || '').trim();
  box.classList.toggle('hidden', !text);
  const am = text && AM_ERRORS.find(([en]) => text.startsWith(en));
  box.innerHTML = text ? `${esc(text)}${am ? `<span class="am">${esc(am[1])}</span>` : ''}` : '';
}

function showLogin(message = '') {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  $('#member-modal').classList.add('hidden');
  $('#confirm-modal').classList.add('hidden');
  setLoginError(message);
  setTimeout(() => $('#login-user').focus(), 30);
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  applySettings(state.settings);
  $('#who').textContent = state.admin ? `${state.admin.full_name || state.admin.username} (@${state.admin.username})` : '';
  $('#default-pass-banner').classList.toggle('hidden', !state.defaultPassword);
  // New-tab links (print sheets, CSV) must work even if the cookie is blocked.
  $$('a[href^="/api/"], a[href^="/admin/"]').forEach((a) => { a.href = withToken(a.getAttribute('href')); });
  loadMembers();
}

function applySettings(settings) {
  if (!settings) return;
  state.settings = settings;
  document.documentElement.style.setProperty('--brand', settings.theme_color || '#0b5d3b');
  $('#brand-name').textContent = settings.org_name || 'QR ID';
  $('#brand-mark').textContent = (settings.org_name || 'ID').trim().charAt(0).toUpperCase() || 'I';
  $('#brand-org').textContent = settings.org_tagline || '';
  fillSettingsForm(settings);
}

/* ------------------------------- tabs ------------------------------ */

function setTab(name) {
  $$('.topbar .tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['members', 'settings', 'security'].forEach((t) =>
    $(`#tab-${t}`).classList.toggle('hidden', t !== name)
  );
  if (name === 'members') loadMembers();
  if (name === 'settings') fillSettingsForm(state.settings);
}

/* ------------------------------ members ---------------------------- */

async function loadMembers() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.status) params.set('status', state.status);
  try {
    const [list, stats] = await Promise.all([
      api(`/api/members?${params.toString()}`),
      api('/api/stats'),
    ]);
    state.members = list.members;
    renderStats(stats);
    renderMembers();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderStats(s) {
  const cards = [
    ['Members', 'አባላት', s.total],
    ['Active cards', 'ንቁ ካርዶች', s.active],
    ['Revoked', 'የተሰረዙ', s.revoked],
    ['QR scans (total)', 'ጠቅላላ ቃኝ', s.scans],
    ['Scans today', 'ዛሬ', s.scans_today],
    ['Next member no.', 'ቀጣይ ቁጥር', s.next_member_no],
  ];
  $('#stats').innerHTML = cards
    .map(([label, am, value]) =>
      `<div class="stat"><div class="n">${esc(value)}</div><div class="l">${esc(label)}<span class="am">${esc(am)}</span></div></div>`)
    .join('');
}

function renderMembers() {
  const grid = $('#members-grid');
  const empty = $('#members-empty');
  grid.innerHTML = state.members.map(memberCardHtml).join('');
  empty.classList.toggle('hidden', state.members.length > 0);
  $('#empty-text').innerHTML = state.query || state.status
    ? 'No member matches that search.'
    : 'No members yet.';
}

function memberCardHtml(m) {
  const badge = m.status === 'active'
    ? '<span class="badge-pill active">Active</span>'
    : '<span class="badge-pill revoked">Revoked</span>';
  const picStyle = m.photo_url ? ` style="background-image:url('${esc(m.photo_url)}')"` : '';
  const picInner = m.photo_url ? badge : `${PERSON_SVG}${badge}`;
  return `<div class="mcard ${esc(m.status)}" data-id="${m.id}">
    <div class="pic"${picStyle} data-open="${m.id}">${picInner}</div>
    <div class="info">
      <div class="name">${esc(m.full_name)}</div>
      <div class="meta">${esc(m.member_no)}</div>
      ${m.role ? `<div class="role">${esc(m.role)}</div>` : ''}
      <div class="acts">
        <button class="btn small" data-edit="${m.id}">Edit / QR</button>
        <button class="btn small danger" data-del="${m.id}" title="Delete member">Delete</button>
      </div>
    </div>
  </div>`;
}

/* ---------------------------- member modal ------------------------- */

const MEMBER_FIELDS = [
  'full_name', 'full_name_alt', 'sex', 'dob', 'national_id',
  'phone', 'phone_alt', 'email',
  'region', 'zone_city', 'woreda', 'kebele', 'house_no', 'address',
  'role', 'department', 'membership_type', 'joined_date', 'expiry_date',
  'marital_status', 'education', 'occupation', 'blood_type',
  'emergency_contact', 'emergency_phone',
  'notes', 'member_no', 'status',
];

function resetMemberForm() {
  state.editing = null;
  state.photoData = null;
  state.photoRemoved = false;
  for (const f of MEMBER_FIELDS) {
    const el = $(`#m_${f}`);
    if (el) el.value = f === 'status' ? 'active' : '';
  }
  setPhotoPreview('');
  $('#modal-title').textContent = 'Add new member';
  $('#member-delete').classList.add('hidden');
  $('#danger-card').classList.add('hidden');
  $('#member-save').innerHTML = 'Save member<span class="am">አስቀምጥ</span>';
  $('#qr-img').classList.add('hidden');
  $('#qr-placeholder').classList.remove('hidden');
  $('#qr-code').classList.add('hidden');
  $('#qr-url').classList.add('hidden');
  $('#scan-total').textContent = '0';
  $('#scans-list').innerHTML = '<li class="empty-line">Not saved yet.</li>';
  ['#print-card', '#dl-qr', '#print-sheet', '#copy-link'].forEach((s) => ($(s).disabled = true));
}

function openMemberModal(id) {
  resetMemberForm();
  state.editing = id;
  $('#member-modal').classList.remove('hidden');
  if (!id) return;
  api(`/api/members/${id}`)
    .then(({ member, scans }) => {
      showMember(member, scans);
      $('#modal-title').textContent = `Edit — ${member.full_name}`;
    })
    .catch((err) => toast(err.message, 'err'));
}

function showMember(m, scans = []) {
  state.editing = m.id;
  state.photoData = null;
  state.photoRemoved = false;
  for (const f of MEMBER_FIELDS) {
    const el = $(`#m_${f}`);
    if (el) el.value = m[f] ?? '';
  }
  if (!m.status) $('#m_status').value = 'active';
  setPhotoPreview(m.photo_url || '');

  $('#modal-title').textContent = `Edit — ${m.full_name}`;
  $('#member-delete').classList.remove('hidden');
  $('#danger-card').classList.remove('hidden');
  $('#toggle-revoke').textContent = m.status === 'active' ? 'Revoke card' : 'Restore card';

  if (m.qr_png) {
    $('#qr-img').src = m.qr_png;
    $('#qr-img').classList.remove('hidden');
    $('#qr-placeholder').classList.add('hidden');
    $('#qr-code').textContent = m.verify_code;
    $('#qr-code').classList.remove('hidden');
    $('#qr-url').textContent = m.public_url;
    $('#qr-url').classList.remove('hidden');
    ['#print-card', '#dl-qr', '#print-sheet', '#copy-link'].forEach((s) => ($(s).disabled = false));
  }

  $('#scan-total').textContent = m.scan_count ?? 0;
  renderScans(scans);
}

function renderScans(scans) {
  if (!scans || !scans.length) {
    $('#scans-list').innerHTML = '<li class="empty-line">No scans yet.</li>';
    return;
  }
  $('#scans-list').innerHTML = scans
    .map((s) => {
      const ua = String(s.user_agent || '');
      const device = /android/i.test(ua) ? 'Android' : /iphone|ipad|ios/i.test(ua) ? 'iPhone/iPad'
        : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : 'Device';
      const result = s.result === 'valid' ? '' : ` · ${esc(s.result)}`;
      return `<li><span class="when">${esc(fmtDateTime(s.scanned_at))}</span><span class="ua">${esc(device)}${result}</span></li>`;
    })
    .join('');
}

function setPhotoPreview(url) {
  const drop = $('#photo-drop');
  const has = !!url;
  drop.classList.toggle('has-photo', has);
  drop.style.backgroundImage = has ? `url('${url}')` : '';
  drop.style.backgroundSize = 'cover';
  drop.style.backgroundPosition = 'center';
}

async function handlePhotoFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) return toast('Please choose an image file', 'err');
  try {
    state.photoData = await fileToDataUrl(file);
    state.photoRemoved = false;
    setPhotoPreview(state.photoData);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveMember(event) {
  event.preventDefault();
  const payload = {};
  for (const f of MEMBER_FIELDS) {
    const el = $(`#m_${f}`);
    if (el) payload[f] = el.value;
  }
  if (!String(payload.full_name || '').trim()) return toast('Full name is required', 'err');
  if (state.photoData) payload.photo_path = state.photoData;
  else if (state.photoRemoved) payload.photo_path = null;

  const button = $('#member-save');
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spin"></span> Saving…';
  try {
    let result;
    if (state.editing) result = await api(`/api/members/${state.editing}`, { method: 'PUT', body: payload });
    else result = await api('/api/members', { method: 'POST', body: payload });
    showMember(result.member, []);
    await loadMembers();
    toast(state.editing ? 'Member saved' : `Member created — ${result.member.member_no}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/* --------------------------- member actions ------------------------ */

async function deleteMember(id) {
  const member = state.members.find((m) => m.id === id);
  const name = member ? member.full_name : 'this member';
  const ok = await confirmDialog(
    'Delete member',
    `Delete ${name} permanently? The ID card will stop working and the record cannot be recovered.`,
    'Delete'
  );
  if (!ok) return;
  try {
    await api(`/api/members/${id}`, { method: 'DELETE' });
    if (state.editing === id) $('#member-modal').classList.add('hidden');
    await loadMembers();
    toast('Member deleted');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function toggleRevoke() {
  if (!state.editing) return;
  const current = $('#m_status').value;
  const next = current === 'active' ? 'revoked' : 'active';
  if (next === 'revoked') {
    const ok = await confirmDialog(
      'Revoke card',
      'The printed QR will immediately show "card revoked". You can restore it later.',
      'Revoke card'
    );
    if (!ok) return;
  }
  try {
    const { member } = await api(`/api/members/${state.editing}/${next === 'revoked' ? 'revoke' : 'activate'}`, { method: 'POST' });
    showMember(member, await loadScans(member.id));
    await loadMembers();
    toast(next === 'revoked' ? 'Card revoked' : 'Card restored', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function reissueQr() {
  if (!state.editing) return;
  const ok = await confirmDialog(
    'Reissue QR code',
    'A brand-new QR code is generated. Every previously printed or photographed copy stops working instantly. Only do this when a card is lost, or after printing the new card.',
    'Reissue QR'
  );
  if (!ok) return;
  try {
    const { member } = await api(`/api/members/${state.editing}/reissue`, { method: 'POST' });
    showMember(member, []);
    await loadMembers();
    toast('New QR code created — old copies are now invalid', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function loadScans(id) {
  try {
    const { scans } = await api(`/api/members/${id}/scans`);
    return scans;
  } catch {
    return [];
  }
}

/* ------------------------------ settings --------------------------- */

function fillSettingsForm(s) {
  if (!s) return;
  $('#s_org_name').value = s.org_name || '';
  $('#s_org_name_alt').value = s.org_name_alt || '';
  $('#s_org_tagline').value = s.org_tagline || '';
  $('#s_card_title').value = s.card_title || '';
  $('#s_id_prefix').value = s.id_prefix || '';
  $('#s_theme_color').value = /^#[0-9a-f]{6}$/i.test(s.theme_color || '') ? s.theme_color : '#0b5d3b';
  $('#s_theme_text').value = s.theme_color || '';
  $('#s_base_url').value = s.base_url || '';
  $('#s_footer_note').value = s.footer_note || '';
  $('#s_verify_note').value = s.verify_note || '';
  $('#logo-preview').innerHTML = s.logo_url ? `<img src="${esc(s.logo_url)}" alt="logo">` : 'No logo';
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = {
    org_name: $('#s_org_name').value,
    org_name_alt: $('#s_org_name_alt').value,
    org_tagline: $('#s_org_tagline').value,
    card_title: $('#s_card_title').value,
    id_prefix: $('#s_id_prefix').value,
    theme_color: $('#s_theme_text').value || $('#s_theme_color').value,
    base_url: $('#s_base_url').value,
    footer_note: $('#s_footer_note').value,
    verify_note: $('#s_verify_note').value,
  };
  try {
    const { settings } = await api('/api/settings', { method: 'PUT', body: payload });
    applySettings(settings);
    toast('Settings saved', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------- events ---------------------------- */

function bindEvents() {
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#login-btn');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span>';
    setLoginError('');
    try {
      const res = await api('/api/login', {
        method: 'POST',
        body: { username: $('#login-user').value, password: $('#login-pass').value },
      });
      state.admin = res.admin;
      state.csrf = res.csrf;
      if (res.token) {
        state.token = res.token;
        try { sessionStorage.setItem(TOKEN_KEY, res.token); } catch { /* ignore */ }
      }
      state.settings = res.settings;
      state.defaultPassword = false;
      $('#login-pass').value = '';
      showApp();
      const me = await api('/api/me').catch(() => null);
      if (me) { state.defaultPassword = !!me.default_password; $('#default-pass-banner').classList.toggle('hidden', !state.defaultPassword); }
    } catch (err) {
      setLoginError(err.message);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    signOut('');
  });

  $$('.topbar .tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#banner-fix').addEventListener('click', () => setTab('security'));

  let searchTimer = 0;
  $('#search').addEventListener('input', (event) => {
    state.query = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadMembers, 220);
  });
  $('#status-filter').addEventListener('change', (event) => {
    state.status = event.target.value;
    loadMembers();
  });

  $('#add-btn').addEventListener('click', () => openMemberModal(null));
  $('#modal-close').addEventListener('click', () => $('#member-modal').classList.add('hidden'));
  $('#member-modal').addEventListener('click', (event) => {
    if (event.target === $('#member-modal')) $('#member-modal').classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('#member-modal').classList.add('hidden');
      $('#confirm-modal').classList.add('hidden');
    }
  });

  $('#members-grid').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit]');
    if (edit) return openMemberModal(Number(edit.dataset.edit));
    const del = event.target.closest('[data-del]');
    if (del) return deleteMember(Number(del.dataset.del));
    const pic = event.target.closest('[data-open]');
    if (pic) return openMemberModal(Number(pic.dataset.open));
  });

  $('#member-form').addEventListener('submit', saveMember);
  $('#member-delete').addEventListener('click', () => state.editing && deleteMember(state.editing));
  $('#toggle-revoke').addEventListener('click', toggleRevoke);
  $('#reissue-btn').addEventListener('click', reissueQr);

  $('#print-card').addEventListener('click', () => {
    if (state.editing) window.open(withToken(`/admin/print/${state.editing}`), '_blank');
  });
  $('#print-sheet').addEventListener('click', () => {
    if (state.editing) window.open(withToken(`/admin/sheet?ids=${state.editing}`), '_blank');
  });
  $('#dl-qr').addEventListener('click', () => {
    if (state.editing) window.location.href = withToken(`/api/members/${state.editing}/qr.png`);
  });
  $('#copy-link').addEventListener('click', async () => {
    const url = $('#qr-url').textContent;
    try {
      await navigator.clipboard.writeText(url);
      toast('Verification link copied', 'ok');
    } catch {
      toast(url);
    }
  });

  // photo input
  const drop = $('#photo-drop');
  const fileInput = $('#photo-file');
  $('#photo-pick').addEventListener('click', () => fileInput.click());
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (event) => handlePhotoFile(event.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); })
  );
  drop.addEventListener('drop', (e) => handlePhotoFile(e.dataTransfer.files[0]));
  $('#photo-clear').addEventListener('click', () => {
    state.photoData = null;
    state.photoRemoved = true;
    $('#photo-file').value = '';
    setPhotoPreview('');
  });

  // settings
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#s_theme_color').addEventListener('input', (e) => { $('#s_theme_text').value = e.target.value; });
  $('#s_theme_text').addEventListener('change', (e) => {
    if (/^#[0-9a-f]{6}$/i.test(e.target.value)) $('#s_theme_color').value = e.target.value;
  });
  $('#logo-pick').addEventListener('click', () => $('#logo-file').click());
  $('#logo-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file, 512, 0.92);
      const { settings } = await api('/api/settings/logo', { method: 'POST', body: { logo: dataUrl } });
      applySettings(settings);
      toast('Logo updated', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      event.target.value = '';
    }
  });
  $('#logo-remove').addEventListener('click', async () => {
    try {
      const { settings } = await api('/api/settings/logo', { method: 'POST', body: { logo: 'remove' } });
      applySettings(settings);
      toast('Logo removed');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // security
  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = $('#p_current').value;
    const next = $('#p_next').value;
    const repeat = $('#p_next2').value;
    if (next !== repeat) return toast('The two new passwords do not match', 'err');
    try {
      await api('/api/password', { method: 'POST', body: { current, next } });
      $('#p_current').value = $('#p_next').value = $('#p_next2').value = '';
      state.defaultPassword = false;
      $('#default-pass-banner').classList.add('hidden');
      toast('Password updated', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

boot();
