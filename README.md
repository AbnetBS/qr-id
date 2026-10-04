# QR ID — member identity cards with secure QR codes

A small self-hosted system for issuing **member ID cards** (like a national ID, but for your own
organization: a political party, association, club, company or cooperative).

The admin adds a member, the system generates a **QR code for the back of the card**, you print it,
and anyone who scans it with a normal phone camera sees that member's full record on a web page —
name, photo, position, branch, phone, membership status, and more.

```
┌──────────────────────────┐        ┌────────────────────────────────┐
│  FRONT OF CARD           │        │  scan with any phone camera    │
│  photo · name · number   │  ───►  │  https://your-host/v/9f3c…      │
├──────────────────────────┤        │  Live member record + photo     │
│  BACK OF CARD            │        │  Active / revoked status        │
│  [ QR ]  VR-4F2A-91C3    │        │  Verification code + scan count │
└──────────────────────────┘        └────────────────────────────────┘
```

## Why the QR cannot just be copied or faked

The QR code does **not** contain the person's data. It contains only a random 128-bit link to this
server, plus a signed short code printed next to it:

| Property | How it works |
| --- | --- |
| **Cannot be invented** | Tokens are 128-bit random values. There is no pattern to guess, so nobody can print a QR for a member who does not exist. |
| **Cannot be copied onto another card** | *Reissue QR* gives a new token and instantly kills every old printed copy or photograph of it. |
| **Cannot be edited** | The scan page always renders the **live** record. Editing a name, photo or phone in the panel updates every card in circulation — there is nothing to forge on the card itself. |
| **Can be killed** | *Revoke* makes the scan page refuse the card (status 410, big "Card revoked" notice) within seconds. |
| **Eyeball check** | The code under the QR (`VR-4F2A-91C3`) is HMAC-signed with the server's secret key, so a printed card can be checked against the screen without scanning. |

Honest limits: any system where the verifier only looks at a card can be fooled by a good enough
photocopy. What this system guarantees is that **the information behind the QR cannot be faked** — a
copy carries either a valid live record or an obviously revoked/invalid one. For physical durability,
print on a real card printer / PVC blank and add a hologram sticker or laminate (see
[Practical tips](#practical-tips-for-a-real-card)).

## Quick start

Requirements: **Node.js 22.5 or newer** (uses the built-in SQLite). No database server, no build step.

```bash
npm install
npm start
```

* Admin panel — <http://localhost:3000/admin>
* Public landing page — <http://localhost:3000/>

First run creates the admin account:

```
username: admin
password: admin123
```

**Change it immediately** in the *Security* tab. Lost it? `npm run reset-admin -- admin newpassword`
(or `-- --list` to see accounts, `-- admin --random` to generate one).

To test a scan from your phone, both devices must be on the same network and you should set the
public address (see below), otherwise use the QR preview inside the panel.

## Daily use

1. **Add new member** → fill the form → optionally *Upload from device* a photo → **Save member**.
2. The right-hand panel now shows the member's **QR code**, its verification code and the live
   public link.
3. Click **Print card back** → the browser print dialog opens with the card at true ID size
   (85.6 × 54 mm). Print it on the back of the card (or on a sticker).
4. Anyone scanning the QR sees the member's record. Scans are logged per member.

Members list: a photo grid with a neutral person icon for members who have no photo yet, search by
name / member number / phone / branch / national ID / woreda / kebele, filter by status, **Edit / QR**
and **Delete** on every card. Extra tools in the toolbar: *Print all QR sheets* (A4, 8 cards per page)
and *Export CSV*.

### What a record holds

Every field is optional except the name, is labelled in English **and Amharic** in the panel, and
only filled fields appear on the scan page:

*Identity* — full name (+ name in the second language), sex, date of birth, national ID number,
blood type.
*Contact* — phone, alternate phone, email, emergency contact name and phone.
*Membership* — member number, position/role, department/branch, membership type, joined date, card
valid-until date, status (active/revoked).
*Address* — region, zone/city, woreda, kebele, house number, address.
*Personal* — marital status, education, occupation, notes, photo.

New columns are added to an existing database automatically (`ALTER TABLE`), so deploying an update
never touches your data.

### Revoke / Reissue

| Situation | Action |
| --- | --- |
| Card lost, membership cancelled | **Revoke card** — scans show "revoked" immediately. Restore later if needed. |
| Card lost but the member stays | **Reissue QR** — new QR, all old copies void. Print the new card back. |
| Card damaged, same QR is fine | Just print the card back again. |

## Settings

In *Card & Organization* you set the organization name (and a second-language name, Amharic works
out of the box), the card title, the member-number prefix, the card colour, the logo, the footer
text and the public address.

**Public address (`base_url`)** matters: it is written into every QR code. Set it to the address
where members' phones can reach this server, e.g. `https://id.yourparty.org`. If you leave it empty,
the address in your browser bar is used at printing time — fine while testing, risky in production
because a card printed from `localhost` will be useless on a phone.

## Printing

* The card back is laid out for the **ID-1 / CR80** format (85.6 × 54 mm) — the same size as a
  bank card or a national ID.
* Print dialog: **A4**, **scale 100 %**, **no headers and footers**, background graphics **on**.
* Options: a dedicated card printer, printing onto a sticker sheet and sticking it to the back of a
  plastic card, or printing the whole sheet and cutting along the dashed guides.
* Test-print one card and place a real ID card on top of it before printing a batch.

## Practical tips for a real card

* Print the front of the card yourself or at a print shop; the QR must stay **flat, clean and
  uncreased** — a damaged code is the most common scan failure.
* Keep the QR at least ~25 mm wide. It is generated with error-correction level **H** (30 % damage
  tolerance) so lamination is safe.
* Add a serial number, signature line, stamp or hologram sticker for extra physical credibility.
* Laminating the card makes it last; a scanned photograph of a laminated card still works, which is
  exactly why *Reissue* and *Revoke* exist.

## Deployment

Full comparison (free tiers, measured CPU/RAM/disk numbers, per-host recipes) lives in
**[DEPLOYMENT.md](DEPLOYMENT.md)**.

Short version — the app needs **~66 MB RAM idle, ~1 ms of CPU per scan and ~1 KB of network per
scan**, so the only things that really matter are a **disk that survives restarts** and a host that
**does not sleep**:

| Option | Cost | Fits? |
| --- | --- | --- |
| **Your existing VPS (VPSDime + Coolify)** | no extra cost | ✅ **0 % CPU when idle, ~65 MB RAM, no timers or polling** — see `docker-compose.yml` |
| Oracle Cloud Always Free ARM VM (2 OCPU / 12 GB / 200 GB disk) | $0 forever | ✅ best free — runs this repo as-is |
| Your own PC / mini-PC + Cloudflare Tunnel | $0 | ✅ persistent disk, you own the data |
| Cheap VPS (Hetzner, Fly.io with volume, Railway) | ~€3–5 / month | ✅ nothing to change |
| Cloudflare Workers + D1 + R2 | $0 | ⚠️ needs a port off `node:sqlite` |
| Render / Koyeb free | $0 | ❌ no persistent disk + 30–60 s cold start |

Environment variables: `PORT`, `HOST`, `DATA_DIR` (must be on persistent storage), `APP_SECRET`,
`SESSION_DAYS` (default 30, renews on activity), `SCAN_RETENTION_DAYS` (0 = keep all scan logs).

Any always-on machine that runs Node 22.5+ works: a small VPS, a mini-PC in the office, or a
container.

### Option A — plain Node behind a reverse proxy

```bash
git clone <this repo> qr-id && cd qr-id
npm install --omit=dev
PORT=3000 HOST=0.0.0.0 npm start      # put nginx/Caddy with HTTPS in front
```

Then set **Public address** in the settings to your HTTPS address. Use a process manager so it
restarts after a reboot (`systemd`, `pm2`, `screen`, `docker`).

Example systemd unit:

```ini
[Unit]
Description=QR ID server
After=network.target

[Service]
WorkingDirectory=/opt/qr-id
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Environment=PORT=3000
Environment=HOST=0.0.0.0
Restart=always

[Install]
WantedBy=multi-user.target
```

### Option B — Docker

```bash
docker build -t qr-id .
docker run -d --name qr-id -p 3000:3000 -v qrid-data:/app/data qr-id
```

### Backups

Everything lives in `./data` (or `DATA_DIR`): `qrid.db` (records, scans, settings) and `uploads/`
(photos, logo). Copy that folder for a backup; restore it to move the whole system to another
machine. Keep it private — and note that `data/secret.key` must be kept: verification codes and
sessions depend on it.

### Security checklist

* Change the admin password on day one; the panel can issue valid ID cards, so treat it as a
  privileged system.
* Serve it over **HTTPS** — an unencrypted link lets someone on the same network swap the page a
  scan lands on.
* The panel is protected by password (scrypt hashing), an HttpOnly session cookie, CSRF tokens and
  login rate-limiting. Keep `data/` off any public file share.
* Public verification pages carry `noindex, nofollow`; they still show personal data to whoever
  scans the card, so treat scan links as confidential — the same as the card itself.
* Optional: if you only need verification inside the office, run the server on the local network
  instead of the open internet.

## Member numbers

Numbers are automatic: `PREFIX-YEAR-0001` (e.g. `DNP-2026-0001`). You can type your own format in the
form — for example a national-ID-style 12-digit number `3901 2345 6789` — and the system keeps it
unique (it appends `-1` if it is taken). The number is printed on the card and shown on the scan
page; the anti-forgery work is done by the QR token, not by the number.

If you want a checksum inside the number itself (like real national IDs), use the *prefix* field plus
your own scheme, or open an issue — it is a small change.

## Project layout

```
server/
  index.js       Express routes: admin API, public pages, print pages
  db.js          SQLite schema, settings, member-number generator
  auth.js        scrypt passwords, sessions, CSRF, login rate limit
  members.js     member CRUD, photo storage, token reissue, scan log
  qr.js          token generation, QR rendering, signed verification codes
  views.js       server-rendered scan page and printable cards
  reset-admin.js emergency password reset
public/
  index.html     landing page
  id.css         styling for the scan page and printed cards
  admin/         admin SPA (index.html, admin.css, app.js) — no build step
data/            database, uploads, secret key (git-ignored, back this up)
```

## API (for your own integrations)

All admin endpoints need the session cookie plus the `x-csrf-token` header (both are returned by
`POST /api/login`). If cookies are unavailable — for example when the panel is embedded in another
page — `POST /api/login` also returns a `token` that can be sent instead as
`Authorization: Bearer <token>`, or appended to a page URL as `?t=<token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/login` | Sign in (returns `csrf`) |
| GET | `/api/members?q=&status=` | List / search members |
| POST | `/api/members` | Create member (photo as `data:image/...` URL) |
| GET | `/api/members/:id` | One member + QR preview + scan history |
| PUT | `/api/members/:id` | Update member |
| DELETE | `/api/members/:id` | Delete member |
| POST | `/api/members/:id/revoke` \| `/activate` \| `/reissue` | Card control |
| GET | `/api/members/:id/qr.png` / `.svg` | Download the QR |
| GET | `/api/members/:id/scans` | Scan history |
| GET | `/api/export.csv` | Whole register as CSV |
| GET/PUT | `/api/settings`, POST `/api/settings/logo` | Organization/card settings |
| — | `/v/<token>` | **Public** scan page (what the QR points to) |

## FAQ

**Does the member need an app?** No. Any phone camera opens the page.

**Does it work without internet?** Only if the server is reachable from the phone. For an offline
event you can run it on a laptop hotspot and set the public address accordingly.

**Two members with the same name?** Fine — member number and QR token are unique.

**Can I change a photo or phone number after printing?** Yes; the printed QR keeps working and shows
the new data on the next scan.
