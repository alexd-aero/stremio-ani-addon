# Ani-CLI Local Streams — Stremio Add-on

A **locally-hosted** Stremio add-on that returns **direct HTTP anime streams**
(`.m3u8`) — **no torrents, no debrid, no P2P**. It scrapes streams the exact
same way the current `ani-cli` (v5.x) does, using the `anidb.app` backend, and
re-implements that pipeline in Node.js — so **you do not need `ani-cli` (or git,
or WSL) installed**.

```
Kitsu/IMDb ID ──▶ title ──▶ anidb slug ──▶ episode id ──▶ embed_url ──▶ master .m3u8
                                                                            │
                                                     Stremio ◀── raw HLS stream
```

## Quick start (any Windows 10/11 PC)

1. Install **[Node.js](https://nodejs.org)** (LTS) and the **[Stremio](https://www.stremio.com)** desktop app. Nothing else — Windows already ships the `curl` this needs.
2. Download this folder, open a terminal in it, and run:
   ```bash
   npm install
   npm start
   ```
3. In Stremio, install the **Anime Kitsu** add-on (so items carry IDs), then paste this into Stremio's add-on search bar:
   ```
   http://127.0.0.1:7000/manifest.json
   ```
4. Open any anime, pick an episode → the **Ani-CLI** `SUB`/`DUB` streams appear.

To make it **start automatically at every login** (hidden, self-restarting) so you never touch a terminal again:
```bash
powershell -ExecutionPolicy Bypass -File .\setup-autostart.ps1
```
(Undo with `uninstall-autostart.ps1`.)

---

## No ani-cli required

This add-on **re-implements ani-cli's scraping logic in JavaScript** — it does
**not** run the `ani-cli` binary, and you do **not** need ani-cli, git-bash, WSL,
or curl-impersonate installed. The only external tool it uses is `curl`, and
**Windows 10/11 already ships one** at `%SystemRoot%\System32\curl.exe`. So on a
stock Windows machine it works out of the box after `npm install`.

## ⚠️ How the Cloudflare handling works

`anidb.app` sits behind Cloudflare, which fingerprints the TLS handshake:
**Node's own HTTPS gets a 403 "Just a moment" challenge, but a real `curl`
sails through.** So at startup the add-on **probes anidb with each `curl` it can
find** (Windows built-in, any git-bash curl, or a curl-impersonate binary) and
uses the first one that isn't blocked. It prints its choice:

```
 anidb fetch via curl: C:\WINDOWS\System32\curl.exe  (probed, clears Cloudflare)
```

Only if *no* curl on the machine can clear Cloudflare (rare) would you install
**curl-impersonate** ([Step 6b](#step-6b--if-cloudflare-blocks-you-curl-impersonate)).

---

## Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies (`stremio-addon-sdk`, `axios`) and scripts |
| `index.js` | The add-on: ID→title resolution, scraper, stream handler |
| `install.js` | One-click `stremio://` deep-link opener |

---

## Step-by-Step Installation (Windows)

### Step 1 — Create the project folder (File Explorer)
1. Open **File Explorer**.
2. Go to `C:\Users\<You>\` (or anywhere you like).
3. Create a new folder, e.g. **`stremio-ani-addon`**.
4. Put `package.json`, `index.js`, and `install.js` inside it.
   *(If you're reading this, they're already at
   `C:\Users\Alexander\Claude Code\stremio-ani-addon`.)*

### Step 2 — Install prerequisites
Download & install (that's the whole list — **no ani-cli, git, or WSL needed**):
- **Node.js** (LTS, v18+): <https://nodejs.org> — includes `npm`.
- **Stremio** desktop app: <https://www.stremio.com>.

`curl` is already present on Windows 10/11, so there's nothing else to install.

Verify in a terminal (**PowerShell**):
```powershell
node --version
npm --version
```

### Step 3 — Install dependencies
Open **PowerShell**, `cd` into the folder you put the add-on in, and install:
```powershell
cd "path\to\stremio-ani-addon"
npm install
```

### Step 4 — Add the Kitsu catalog to Stremio (one time)
This add-on provides **streams**, not a browsable catalog. To get anime with
`kitsu:` IDs to click on, install the community **Anime Kitsu** add-on inside
Stremio:
1. Stremio → **Add-ons** (puzzle icon) → search **"Anime Kitsu"** → **Install**.

Now anime detail pages will have `kitsu:` IDs that this add-on can serve.

### Step 5 — Run the local server
```powershell
npm start
```
You should see:
```
================================================================
 Ani-CLI Local Streams add-on is running.
 Manifest:  http://127.0.0.1:7000/manifest.json
 Install :  stremio://127.0.0.1:7000/manifest.json
================================================================
```
Leave this window **open** — closing it stops the add-on.

### Step 6 — Install into Stremio (one click)
In a **second** PowerShell window (keep the server running):
```powershell
cd "path\to\stremio-ani-addon"
node install.js
```
This opens the `stremio://` protocol handler and Stremio prompts **Install**.

**Manual alternative:** open Stremio → **Add-ons** → paste into the add-on URL box:
```
http://127.0.0.1:7000/manifest.json
```
or click this deep link:
```
stremio://127.0.0.1:7000/manifest.json
```

### Step 7 — Watch
Open any anime in Stremio (via the Anime Kitsu catalog), pick an episode, and
**Ani-CLI** streams appear in the stream list. Server logs show each request.

---

## Step 6b — If Cloudflare blocks you: curl-impersonate

If you saw the Cloudflare message, install
[**curl-impersonate**](https://github.com/lwthiker/curl-impersonate/releases)
(Windows build) and point the add-on at it. Then restart with the env var set:

```powershell
$env:ANIDB_CURL = "C:\tools\curl-impersonate\curl_chrome116.exe"
npm start
```

The add-on will route **every** request through that binary (which presents a
real Chrome TLS fingerprint) instead of Node's HTTP client. Verify the startup
log prints `Using external curl: …`.

---

## Configuration (env vars)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `7000` | Server port |
| `FLARESOLVERR_URL` | *(unset)* | Base URL of a [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) instance (e.g. `http://host:8191`). When set, all anidb requests are solved through it — this is how the add-on runs **hosted/serverless** where no `curl` is available. |
| `ANIDB_CURL` | *(unset)* | Path to a `curl(-impersonate)` binary; forces all scraping requests through it. |

**Fetch-backend priority:** `FLARESOLVERR_URL` → probed system `curl` → Node/axios.

---

## Hosted / serverless deploy (anidb + FlareSolverr)

On a normal PC the add-on uses the built-in `curl` to clear Cloudflare. On a
**datacenter/serverless** host that trick fails (no `curl`, and datacenter IPs
get challenged harder), so it routes anidb through **FlareSolverr** — a headless
Chromium that solves the challenge. FlareSolverr itself needs a real browser, so
it can't be *serverless*; it runs as a companion container.

The video stream URLs (`hls.anidb.app`) are **not** behind Cloudflare, so only
the lightweight scraping calls go through FlareSolverr — the heavy video traffic
goes straight from anidb to each viewer.

**One-command deploy** (any Docker host — VPS, Fly.io, Railway, Render…):
```bash
docker compose up -d
```
That starts the add-on + FlareSolverr together; then install
`http://<your-host>:7000/manifest.json` in Stremio. For a public URL, put it
behind HTTPS (Caddy/Cloudflare Tunnel) — Stremio requires HTTPS for remote add-ons.

**Wasmer / other serverless:** deploy the add-on (this container / `index.js`)
to your serverless runtime and set `FLARESOLVERR_URL` to a FlareSolverr instance
running on a small always-on box (its Chromium can't live on serverless). The
`docker compose` file above is the simplest way to host that FlareSolverr.

Example on a custom port:
```powershell
$env:PORT = "8000"; npm start
```
(Then install `http://127.0.0.1:8000/manifest.json`.)

---

## How it maps to your requirements

- **stremio-addon-sdk** — `addonBuilder` + `serveHTTP` in `index.js`.
- **Handles Kitsu AND IMDb IDs** — `kitsu:<id>[:ep]` (from the Anime Kitsu
  catalog) and `tt<id>[:season:ep]` (from the default IMDb/Cinemeta catalog).
  IMDb titles are resolved via Cinemeta and only scraped when the genre is
  animation, so the add-on stays out of every non-anime title's stream list.
- **Direct HTTP links, no torrents** — returns `.m3u8` links only.
- **Sub AND dub** — the add-on requests both languages (`jpn` + `eng`, exactly
  like `ani-cli`'s `ANI_CLI_MODE=sub|dub`) and lists whatever exists. Each
  stream's title is tagged `SUB` or `DUB` so you just pick the dub entry.
- **Plays without a proxy** — anidb's HLS needs no special headers, so streams
  are returned as raw URLs (no `notWebReady`/`proxyHeaders`); Stremio's player
  fetches them directly, which avoids the internal-proxy buffering stall.
- **No ani-cli binary** — the scraper is pure JS. `getStreamsViaCli()` in
  `index.js` is an unused optional helper that would shell out to a real
  `ani-cli` if you ever wanted to; nothing calls it.
- **One-click local install** — `install.js` opens `stremio://127.0.0.1:7000/manifest.json`.

---

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| No streams + `Cloudflare blocked` in log | Use `ANIDB_CURL` + curl-impersonate (Step 6b), or try a non-datacenter connection |
| No streams, `no anidb search results` | Title mismatch — anime may be listed under a different name on anidb.app |
| No streams, `episode N not found` | That episode isn't up yet, or numbering differs (e.g. absolute vs. seasonal) |
| Streams show but won't play | The chosen host is down — pick another quality/entry in the list |
| Stremio won't add it | Ensure `npm start` is still running; use `127.0.0.1`, not `localhost` |

---

## Legal note
For personal use. You are responsible for complying with the laws in your
jurisdiction and the terms of any service this software contacts. It streams
from third-party sources it does not control or host.
