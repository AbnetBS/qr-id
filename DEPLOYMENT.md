# Deploying QR ID — free and low-cost options

Everything below is about **keeping CPU, RAM, disk, network and money close to zero** while the
system still answers instantly when somebody scans a card.

---

## 1. What this app actually needs (measured, not guessed)

Measured on Node 22.22 with 200 members in the register:

| Metric | Value | Notes |
| --- | --- | --- |
| Idle RAM (RSS) | **~66 MB** | Almost all of it is the Node runtime itself, not your data. |
| CPU per scan (`GET /v/<token>`) | **~1.1 ms** | One SQLite read + one HTML page. |
| CPU per login | **~100 ms** | scrypt password hashing — happens once per session, not per scan. |
| CPU per QR image | **~100 ms** the first time, **~0 ms** after | QR images are cached in memory until the token or the public address changes. |
| Bytes per scan | **1.4 KB** page + the member photo (~50–200 KB) | Pages are gzipped (3.9 KB → 1.4 KB). |
| Admin panel, first load | **18 KB** (was 65 KB uncompressed) | Assets are gzipped and cached; later loads are 304 Not Modified. |
| Member list, 200 members | **15 KB** (was 227 KB uncompressed) | gzip on the API. |
| Database growth | **~0.6 KB per member** | 1,000 members ≈ 1 MB (plus photos). |
| Photo storage | **~50–200 KB per photo** | The browser downscales to max 1000 px before upload. |

**Conclusion:** this is a *tiny* workload. Any host that can run Node 22 can run it — the question is
not power, it is **persistent disk** and **not falling asleep**.

```
Realistic 1,000-member register:   ~1 MB database + ~150 MB photos
Realistic traffic (5,000 scans/month): ~1 GB/month egress, ~6 seconds of CPU in total
```

---

## 1b. Sharing a VPS that already runs something else (Coolify)

This is the "the restaurant system must not pay for QR traffic" case, so it is worth being precise
about what the app does when nobody is using it:

* **No timers, no polling, no cron, no keep-alive.** The hourly session-cleanup interval was removed:
  housekeeping now runs once at start-up and then only when a real request arrives (at most once
  every 6 hours, `MAINTENANCE_EVERY_MS`).
* **Measured idle cost: 0 CPU ticks over 90 seconds** — i.e. 0.00 % of a core. Node goes back to sleep
  the moment a response is finished.
* **~65 MB RAM at rest**, ~90 MB right after a burst of traffic. Cap it in Coolify
  (`mem_limit: 256m` in `docker-compose.yml`) so it can never crowd the restaurant system.
* **Disk writes:** one row per *(first) scan from a device within 60 s*, plus a photo when you upload
  one. Set `SCAN_LOG=0` to write nothing at all on scans, or `SCAN_RETENTION_DAYS=365` to prune.
* **Speed is not traded away:** pages and the API are gzipped (a scan is 1.4 KB), static assets are
  pre-compressed and served from memory with ETags, settings and QR images are cached in memory, so a
  scan is ~1 ms of CPU and the panel opens instantly.

**Deploy in Coolify:** *New Resource → Docker Compose* (or Dockerfile), point it at this repo, set the
domain (Coolify gives you HTTPS automatically), and add the volume `/app/data` so the database and
photos survive redeploys. Then set **Public address** in the panel to that HTTPS domain.

```bash
# or by hand, on the VPS
docker compose up -d --build
```

Estimated monthly load for a 1,000-member register with a few thousand scans: **well under 1 GB of
traffic and a couple of seconds of CPU** — the shared VPS will not notice it.

---

## 2. The one hard requirement: a disk that survives restarts

The database is a single SQLite file in `data/` (see `DATA_DIR`). If the host throws the filesystem
away when the process restarts, you lose the members *and* your session — which is exactly the
"session ended after a few minutes" symptom on the big free PaaS platforms.

| Host | Disk survives restart? | Sleeps when idle? | Verdict for QR ID |
| --- | --- | --- | --- |
| Oracle Cloud Always Free (ARM VM) | ✅ real block volume | no | **Best free option** |
| Any VPS (Hetzner, Fly volume, Railway volume, Contabo…) | ✅ | no | **Best paid-cheap option** |
| Your own PC / mini-PC / Raspberry Pi | ✅ | no | **Free, total control** |
| Cloudflare Workers + D1 (+R2 for photos) | ✅ (managed DB/R2) | no (scale to zero, no cold start) | **Best $0 if you port it** |
| Render free web service | ❌ filesystem is wiped | ✅ 15 min → 30–60 s cold start | Only with an external DB |
| Koyeb free instance | ❌ no volumes on free | ✅ 1 h → cold start | Only with an external DB |
| Fly.io | ✅ with a volume | no | ~$2–4/month |
| Vercel / Netlify / Cloud Run (no volume) | ❌ | ✅ | Needs external DB + rewrite |

Sources: Render's free services cannot attach persistent disks and spin down after 15 minutes with a
30–60 s cold start [3](https://freetier.co/directory/products/render),
[4](https://agentdeals.dev/vendor/render); Koyeb's free instance (512 MB / 0.1 vCPU / 2 GB SSD)
cannot use volumes and scales to zero after 1 hour [3](https://www.koyeb.com/docs/reference/instances);
Fly.io no longer offers a free allowance — a `shared-cpu-1x` 256 MB machine is about **$2.02/month**
plus **$0.15/GB/month** for a volume and $2 for a dedicated IPv4
[1](https://www.budgetforge.dev/tools/fly-io-pricing-2026-2),
[3](https://fly.io/pricing/).

---

## 3. Ranked recommendations

### 🥇 1. Oracle Cloud "Always Free" ARM VM — free forever, no cold start

* **What you get:** Ampere A1 compute, **10 TB/month egress**, **200 GB block storage**, free forever.
  The ARM allowance was halved in June 2026 and is now **2 OCPU / 12 GB RAM** (older guides still say
  4/24) — still ~180× more RAM than this app needs
  [1](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/),
  [5](https://www.mrplanb.com/datacenter/free-vps-tiers),
  [2](https://cloudpricecheck.com/free-tier/oracle).
* **Why it fits:** it is a normal Linux VM with a real disk, so the Docker image in this repo runs
  unchanged. No sleep, no cold start, SQLite is perfectly happy.
* **Catches:** a credit card is required at sign-up (not charged), ARM capacity can be "out of
  capacity" in popular regions (try Frankfurt, Amsterdam, Johannesburg or Dubai), and Oracle may
  reclaim instances that are idle for very long periods.
* **Deploy:**
  ```bash
  # on the VM (Ubuntu 24.04, arm64)
  curl -fsSL https://get.docker.com | sh
  sudo apt install -y nginx certbot python3-certbot-nginx
  git clone <this repo> qr-id && cd qr-id
  docker build -t qr-id .
  docker run -d --name qr-id --restart unless-stopped \
    -p 127.0.0.1:3000:3000 -v /opt/qrid-data:/app/data qr-id
  ```
  Then put nginx in front with `certbot --nginx` for HTTPS and set **Public address** in
  *Card & Organization* to `https://id.yourdomain.org`.
* **Backups:** `sqlite3 /opt/qrid-data/qrid.db ".backup /root/qrid-$(date +%F).db"` in cron, or just
  copy the folder.

### 🥈 2. Cloudflare Workers + D1 + R2 — genuinely $0, edge-fast, but needs a port

* **What you get (free):** Workers **100,000 requests/day**, D1 **5 M rows read/day, 100 k rows
  written/day, 5 GB storage**, R2 **10 GB with zero egress fees**
  [1](https://www.buildmvpfast.com/blog/cloudflare-workers-hono-d1-r2-free-fullstack-2026),
  [2](https://agentdeals.dev/vendor/cloudflare-workers),
  [3](https://freetier.co/articles/cloudflare-d1-free-tier-limits-pricing-and-alternatives).
  Since 1 Sep 2026 D1 hard-fails on the free plan once the daily limit is hit
  [4](https://community.cloudflare.com/t/d1-d1-enforces-free-tier-daily-query-limits/954367).
* **Why it fits:** compute is billed *per request*, so an idle register costs nothing and there is no
  cold start. Scans are served from the nearest Cloudflare location, which matters when the person
  scanning is on Ethiopian mobile data.
* **Catches:** it is not Node. `node:sqlite` → D1, `fs` photo storage → R2, `scrypt` → WebCrypto
  PBKDF2. That is a real port of `server/db.js`, `server/members.js` and `server/auth.js` (roughly a
  day's work). Also mind the 10 ms CPU/invocation free limit — fine here (our whole scan is ~1 ms of
  work), but tight if we add heavy features later.
* **Verdict:** the best *technical* answer for a mostly-idle, scan-driven system — worth doing if
  you want zero bills and global speed. Say the word and I will port it.

### 🥉 3. Your own machine + Cloudflare Tunnel — $0, persistent, works offline

An office PC, a mini-PC or a Raspberry Pi running the Docker image, exposed with
`cloudflared tunnel` (free, no port forwarding, HTTPS included). Full disk persistence, no monthly
bill, scans work even when the internet at the office is the only connection you have.
Catch: the machine has to stay on, and you own the backups.

**Deploy:**
```bash
docker run -d --name qr-id --restart unless-stopped -p 3000:3000 -v /opt/qrid-data:/app/data qr-id
cloudflared tunnel login
cloudflared tunnel create qrid
cloudflared tunnel route dns qrid id.yourdomain.org
cloudflared tunnel run --url http://localhost:3000 qrid
```

### 4. Cheap always-on VPS — €3–5/month, zero fuss

Hetzner CX22 (2 vCPU / 4 GB / 40 GB), Contabo, or **Fly.io with a 1 GB volume** (~$2.02 compute +
$0.15 volume, or ~$4 with a dedicated IPv4). Same Docker commands as option 1. Pick a region close to
your members — Frankfurt, Dubai or Johannesburg, not Singapore/US, to keep scan latency low.

### 5. Render / Koyeb free — only if you also rent nothing at all

Possible, but you must attach an external database (Turso free = **5 GB total storage, 100 databases**
[1](https://costbench.com/software/database-as-a-service/turso/free-plan/)) because the container
filesystem is wiped on every spin-down, and the first scan after 15 minutes of idleness waits 30–60
seconds for the cold start. For a card that somebody scans at a checkpoint, that wait is the whole
product. **Not recommended** unless budget is the only criterion.

---

## 4. Configuration (all hosts)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `./data` | **Put this on a persistent volume.** Holds `qrid.db`, `uploads/`, `secret.key`. |
| `APP_SECRET` | (file) | Signing key for the printed verification codes. Keep it — if it changes, printed codes change. |
| `SESSION_DAYS` | `30` | Idle window before an admin is signed out. The session renews itself on activity, so this is *idle* time, not a hard cut-off. |
| `SCAN_RETENTION_DAYS` | `0` (keep forever) | Set e.g. `365` to auto-delete scan-log rows and cap storage growth. |
| `SCAN_LOG` | `1` | `0` = never write scan-log rows (zero disk writes on a scan). |
| `MAINTENANCE_EVERY_MS` | `21600000` (6 h) | How often housekeeping may run — and only when real traffic arrives, never on a timer. |
| `QR_CACHE_MAX` | `150` | Cached QR images. `0` disables the cache (trades CPU for RAM). |
| `NODE_OPTIONS` | – | `--max-old-space-size=128` keeps the heap small on a shared box. |

Also set **Public address** (`base_url`) in the admin panel to your real HTTPS address — that is the
URL baked into every printed QR code.

---

## 5. What to watch, whatever you pick

* **Backups** = a copy of `DATA_DIR`. Photos are in `uploads/`, everything else in `qrid.db`.
* **HTTPS** is mandatory in production: without it, someone on the same Wi-Fi can rewrite the page a
  scan lands on.
* **Region matters more than CPU.** A scan is ~1 ms of work and maybe 200 ms of network round-trip;
  choosing a nearby region does more for perceived speed than any code change.
* **Free tiers change.** Oracle quietly halved its ARM allowance in June 2026, Fly retired its free
  tier, and Cloudflare started enforcing D1 daily caps — so keep the data exportable (Export CSV, and
  the whole register is one SQLite file you can copy).
