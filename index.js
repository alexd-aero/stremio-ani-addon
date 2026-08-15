/**
 * Stremio Ani-CLI Add-on  (local, no torrents / no P2P)
 * ------------------------------------------------------
 * Answers Stremio "stream" requests for anime with DIRECT HTTP video links
 * (.m3u8 / .mp4), by re-implementing — in plain JavaScript — the exact
 * scraping pipeline used by the CURRENT ani-cli (v5.x, the anidb.app backend):
 *
 *      Kitsu ID  ->  anime title                (Kitsu API)
 *      title     ->  anidb anime slug           GET /browse?q=<title>
 *      slug      ->  episode id                 GET /api/frontend/anime/<num>/episodes
 *      ep id     ->  embed_url (sub=jpn/dub=eng) GET /api/frontend/episode/<id>/languages
 *      embed     ->  master .m3u8               fetch embed page, read  file: '...'
 *
 * Every returned stream carries `behaviorHints.proxyHeaders` so Stremio
 * replays the request with the Referer / User-Agent the CDN expects (no 403).
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT — Cloudflare:
 *   anidb.app sits behind Cloudflare.  From a normal home/residential
 *   connection the requests below succeed.  From flagged IPs (datacenters,
 *   some VPNs) Cloudflare serves a "Just a moment..." challenge that a plain
 *   HTTP client cannot solve.  ani-cli hits the exact same wall and its own
 *   fix is `curl-impersonate`.  If you get blocked, install curl-impersonate
 *   and point this add-on at it:   set  ANIDB_CURL=/path/to/curl_chrome116
 *   (see the install guide) — the add-on will route every request through it.
 * ---------------------------------------------------------------------------
 */

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const https = require("https");
const { execFile } = require("child_process");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 7000;

const AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BASE = "https://anidb.app";
const SEARCH_API = (q) => `${BASE}/browse?q=${encodeURIComponent(q)}`;
const EPISODES_API = (num) => `${BASE}/api/frontend/anime/${num}/episodes`;
const LANGUAGES_API = (epId) => `${BASE}/api/frontend/episode/${epId}/languages`;

// Optional escape hatch: an external curl(-impersonate) binary used for ALL
// requests.  Recommended by ani-cli when Cloudflare blocks the plain client.
//   e.g.  ANIDB_CURL="C:\\tools\\curl-impersonate\\curl_chrome116.exe"
const ANIDB_CURL = process.env.ANIDB_CURL || "";

// A browser-ish TLS cipher order (ani-cli's cipher_flag equivalent).  This
// nudges lighter Cloudflare checks; it cannot defeat a full JS challenge —
// that's what ANIDB_CURL / curl-impersonate is for.
const tlsAgent = new https.Agent({
  keepAlive: true,
  minVersion: "TLSv1.2",
  ciphers: [
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
  ].join(":"),
});

class CloudflareError extends Error {}

const { spawnSync } = require("child_process");
const PROBE_URL = `${BASE}/browse?q=naruto`;

/**
 * True only for a REAL Cloudflare block/interstitial.
 * NOTE: Cloudflare injects a `cdn-cgi/challenge-platform` beacon script into
 * every normally-served page, so matching that string flags healthy pages as
 * blocked (the original bug).  We match the actual challenge markers instead.
 */
function looksBlocked(body) {
  return (
    /<title>\s*Just a moment/i.test(body) ||
    /Enable JavaScript and cookies to continue/i.test(body) ||
    /__cf_chl_|cf-error-code|cf_chl_opt/i.test(body)
  );
}

// anidb.app is behind Cloudflare, which fingerprints the TLS handshake: Node's
// own HTTPS gets a 403 "Just a moment" challenge, but a real curl sails through.
// This add-on does NOT need ani-cli (or git, or curl-impersonate) installed —
// it only needs *a* curl, and Windows 10/11 always ships one at
// %SystemRoot%\System32\curl.exe.  At startup we PROBE the real site with each
// candidate and keep the first that isn't blocked, so it works out of the box.
function curlCandidates() {
  const list = [];
  if (ANIDB_CURL) list.push(ANIDB_CURL);
  // curl-impersonate variants (best at defeating Cloudflare), if installed:
  list.push("curl_firefox135", "curl_chrome136", "curl_chrome116", "curl_ff117");
  // Every curl on PATH — on Windows `where` lists any git-bash curl AND the
  // built-in System32 curl; they can behave differently, so we test each.
  try {
    const finder =
      process.platform === "win32" ? ["where", "curl"] : ["which", "-a", "curl"];
    const r = spawnSync(finder[0], finder.slice(1), { timeout: 5000, encoding: "utf8" });
    if (r.stdout)
      for (const line of r.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p) list.push(p);
      }
  } catch { /* ignore */ }
  // Explicit fallbacks so we find a curl even if PATH/`where` is minimal.
  if (process.platform === "win32") {
    const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    list.push(`${sysRoot}\\System32\\curl.exe`);
  } else {
    list.push("/usr/bin/curl");
  }
  list.push("curl");
  return [...new Set(list)];
}

/** Run one curl binary against anidb; true if it returns real content (not a challenge). */
function curlWorks(bin) {
  try {
    const r = spawnSync(
      bin,
      ["-sL", "-A", AGENT, "--max-time", "12", PROBE_URL],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }
    );
    const body = r.stdout || "";
    // Positive success signal: the search page actually contains anime links.
    return r.status === 0 && !looksBlocked(body) && /anime\/[a-z0-9-]+-\d+/i.test(body);
  } catch {
    return false;
  }
}

// Pick a working curl ONCE at startup (this makes a couple of probe requests).
let SYSTEM_CURL = null;
(function detectCurl() {
  for (const c of curlCandidates()) {
    if (curlWorks(c)) { SYSTEM_CURL = c; break; }
  }
})();

/** Fetch via an external curl(-impersonate) binary — mirrors ani-cli's anidb_curl. */
function curlFetch(bin, url) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-sL", "-A", AGENT, "--max-time", "15", url],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const body = stdout.toString();
        if (looksBlocked(body))
          return reject(new CloudflareError(`Cloudflare challenge (${bin})`));
        resolve(body);
      }
    );
  });
}

/**
 * Core fetch helper.  Prefers the probed-working curl (curl reliably clears
 * Cloudflare here); falls back to Node/axios only if no working curl was found.
 */
async function anidbCurl(url) {
  if (SYSTEM_CURL) {
    try {
      return await curlFetch(SYSTEM_CURL, url);
    } catch (e) {
      if (!(e instanceof CloudflareError)) throw e;
      // Unexpected challenge from the "good" curl — fall through to axios.
    }
  }
  return axiosFetch(url);
}

/** Node/axios fetch with a browser-ish TLS cipher order. */
function axiosFetch(url) {
  return axios
    .get(url, {
      httpsAgent: tlsAgent,
      timeout: 15000,
      maxRedirects: 5,
      responseType: "text",
      transformResponse: [(d) => d], // keep raw text, don't auto-JSON
      headers: {
        "User-Agent": AGENT,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      // Accept 4xx too so we can inspect Cloudflare's challenge body (it is
      // served WITH a 403 status) and raise a helpful error instead of a raw one.
      validateStatus: (s) => s >= 200 && s < 500,
    })
    .then((r) => {
      const body = String(r.data);
      if (looksBlocked(body)) throw new CloudflareError("Cloudflare challenge");
      if (r.status >= 400) throw new Error(`HTTP ${r.status} from ${url}`);
      return body;
    });
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const manifest = {
  id: "org.local.anicli.stremio",
  version: "1.1.0",
  name: "Ani-CLI Local Streams",
  description:
    "Direct HTTP anime streams scraped the same way the current ani-cli does " +
    "(anidb.app). No torrents, no debrid, no P2P. Runs locally on your machine.",
  logo: "https://raw.githubusercontent.com/pystardust/ani-cli/master/res/logo.png",
  resources: ["stream"],
  types: ["anime", "series", "movie"],
  // Handle BOTH id schemes Stremio uses for anime:
  //   kitsu:12345[:ep]        -> the community "Anime Kitsu" catalog
  //   tt1234567[:season:ep]   -> the default IMDb/Cinemeta catalog
  // For "tt" ids we first check Cinemeta genres and only scrape if it's
  // actually animation (so we don't hammer anidb for every movie/series).
  idPrefixes: ["tt", "kitsu"],
  catalogs: [],
  behaviorHints: { configurable: false, adult: false },
};

const builder = new addonBuilder(manifest);

// ---------------------------------------------------------------------------
// Step 1: Stremio id -> { source, baseId, episode }
// ---------------------------------------------------------------------------
/**
 * Stremio stream ids we handle:
 *   kitsu:12345          movie/single  -> episode 1
 *   kitsu:12345:3        series ep 3
 *   kitsu:anime:12345:3  (optional "anime" segment)
 *   tt1234567            IMDb movie
 *   tt1234567:1:3        IMDb series  season 1 episode 3
 */
function parseStremioId(id) {
  const parts = id.split(":").filter(Boolean);

  if (parts[0] === "kitsu") {
    if (parts[1] === "anime") parts.splice(1, 1);
    return { source: "kitsu", baseId: parts[1], season: "1", episode: parts[2] || "1" };
  }

  // Anything else is treated as an IMDb id (tt...).
  return { source: "imdb", baseId: parts[0], season: parts[1] || "1", episode: parts[2] || "1" };
}

/** Kitsu id -> title. */
async function resolveKitsuTitle(kitsuId) {
  const { data } = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, {
    timeout: 15000,
    headers: { Accept: "application/vnd.api+json", "User-Agent": AGENT },
  });
  const attr = data?.data?.attributes || {};
  const titles = attr.titles || {};
  // Romaji/en_jp tends to match anidb slugs best; fall back through the rest.
  const title = titles.en_jp || attr.canonicalTitle || titles.en || titles.ja_jp;
  if (!title) throw new Error(`Could not resolve Kitsu id ${kitsuId}`);
  return { title, isAnime: true };
}

/**
 * IMDb id -> title via Stremio's public Cinemeta.  Also returns whether the
 * title is animation, so the handler can skip non-anime content and avoid
 * pointless anidb searches for every movie/series in Stremio.
 */
async function resolveImdbTitle(type, imdbId) {
  const metaType = type === "movie" ? "movie" : "series";
  const { data } = await axios.get(
    `https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`,
    { timeout: 15000, headers: { "User-Agent": AGENT } }
  );
  const meta = data?.meta || {};
  const title = meta.name ? decodeEntities(meta.name) : null;
  if (!title) throw new Error(`Could not resolve IMDb id ${imdbId}`);
  const genres = (meta.genres || []).map((g) => String(g).toLowerCase());
  const isAnime = genres.includes("animation") || genres.includes("anime");
  return { title, isAnime };
}

// ---------------------------------------------------------------------------
// Step 2: title -> anidb anime slug   (GET /browse?q=)
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return s
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/’/g, "'"); // curly apostrophe -> straight
}

/**
 * Returns [{ slug, num, title }]  (slug like "cowboy-bebop-217", num "217").
 * anidb.app renders results as:
 *   <a href="https://anidb.app/anime/<slug>" class="anime-card ..." title="<Title>">
 * i.e. the title is in a `title=` attribute (NOT `alt=`, which ani-cli's own
 * regex still expects — that's why plain scraping currently returns nothing).
 */
async function searchAnidb(query) {
  const html = await anidbCurl(SEARCH_API(query));
  const out = [];

  // Primary: slug + title="" inside the same <a> tag (attribute order-agnostic).
  const re = /anime\/([a-z0-9-]+-[0-9]+)"[^>]*?\btitle="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push({ slug: m[1], num: m[1].split("-").pop(), title: decodeEntities(m[2]) });
  }

  // Fallback: bare slugs (derive a display title from the slug) if the markup
  // ever changes again and the title attribute can't be found.
  if (!out.length) {
    const re2 = /anime\/([a-z0-9-]+-[0-9]+)"/gi;
    while ((m = re2.exec(html))) {
      const slug = m[1];
      out.push({
        slug,
        num: slug.split("-").pop(),
        title: slug.replace(/-[0-9]+$/, "").replace(/-/g, " "),
      });
    }
  }

  // De-dupe by slug, preserve order.
  const seen = new Set();
  return out.filter((a) => (seen.has(a.slug) ? false : (seen.add(a.slug), true)));
}

/** Pick the closest title match, falling back to the first result. */
function pickBest(results, wanted) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const want = norm(wanted);
  let best = results[0];
  let score = -1;
  for (const r of results) {
    const n = norm(r.title);
    let s = 0;
    if (n === want) s = 100;
    else if (n.includes(want) || want.includes(n)) s = 60;
    else for (const w of new Set(want.split(" "))) if (n.split(" ").includes(w)) s += 5;
    if (s > score) ((score = s), (best = r));
  }
  return best;
}

// ---------------------------------------------------------------------------
// Step 3: anime -> episode id   (GET /api/frontend/anime/<num>/episodes)
// ---------------------------------------------------------------------------
/** Returns a Map of episodeNumber(string) -> episodeId(string). */
async function getEpisodeMap(animeNum) {
  const body = await anidbCurl(EPISODES_API(animeNum));
  const map = new Map();
  try {
    const json = JSON.parse(body);
    const arr = Array.isArray(json) ? json : json.episodes || json.data || [];
    for (const e of arr) {
      if (e && e.id != null && e.number != null) map.set(String(e.number), String(e.id));
    }
  } catch {
    // Fallback to ani-cli's regex approach if the JSON shape is unexpected.
    const re = /"id":(\d+)[^}]*?"number":(\d+)/g;
    let m;
    while ((m = re.exec(body))) map.set(m[2], m[1]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Step 4: episode id -> embed_url -> master .m3u8
// ---------------------------------------------------------------------------
/** mode: 'sub' -> language "jpn", 'dub' -> "eng" (as ani-cli does). */
async function getEmbedUrl(episodeId, mode) {
  const lang = mode === "dub" ? "eng" : "jpn";
  const body = await anidbCurl(LANGUAGES_API(episodeId));

  let embed = null;
  try {
    const json = JSON.parse(body);
    const arr = Array.isArray(json) ? json : json.languages || json.data || [];
    // Prefer the entry matching the requested language; else take any.
    const match =
      arr.find((x) => JSON.stringify(x).toLowerCase().includes(lang) && x.embed_url) ||
      arr.find((x) => x && x.embed_url);
    if (match) embed = match.embed_url;
  } catch {
    const chunks = body.split(/\},\{/);
    for (const c of chunks) {
      if (c.toLowerCase().includes(lang)) {
        const mm = c.match(/embed_url":"([^"]+)"/);
        if (mm) { embed = mm[1]; break; }
      }
    }
    if (!embed) {
      const mm = body.match(/embed_url":"([^"]+)"/);
      if (mm) embed = mm[1];
    }
  }
  if (!embed) return null;
  return embed.replace(/\\\//g, "/"); // unescape \/  ->  /
}

/** Fetch an embed page and extract the master playlist:  file: '...'  */
async function getMasterFromEmbed(embedUrl) {
  const page = await anidbCurl(embedUrl);
  const m = page.match(/file:\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

/**
 * Best-effort: parse a master .m3u8 into labeled quality variants.
 * Returns [] if it isn't a master playlist (caller then uses the master URL).
 */
async function parseMasterVariants(masterUrl) {
  let text;
  try {
    text = await anidbCurl(masterUrl);
  } catch {
    return [];
  }
  if (!/#EXT-X-STREAM-INF/i.test(text)) return [];
  const base = masterUrl.slice(0, masterUrl.lastIndexOf("/") + 1);
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#EXT-X-STREAM-INF/i.test(lines[i])) {
      const res = lines[i].match(/RESOLUTION=\d+x(\d+)/i);
      const quality = res ? `${res[1]}p` : "auto";
      const next = (lines[i + 1] || "").trim();
      if (next && !next.startsWith("#")) {
        const url = /^https?:\/\//i.test(next) ? next : base + next;
        out.push({ quality, url });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build Stremio streams
// ---------------------------------------------------------------------------
/**
 * The anidb HLS on hls.anidb.app is HTTPS and needs NO custom headers (master,
 * variant playlists and segments all return 200 without Referer/UA — verified).
 * So we hand Stremio the raw URL with NO proxyHeaders and NO notWebReady:
 * setting those forces Stremio to route the stream through its internal HLS
 * proxy, which stalls on these playlists (odd ".xls" segment names) and shows
 * endless buffering.  Direct playback via the desktop player just works.
 */
function makeStream({ url, quality, animeTitle, episode, mode }) {
  return {
    name: `Ani-CLI\n${quality || "auto"}`,
    title: `${animeTitle}\nEp ${episode} • ${mode.toUpperCase()}`,
    url,
    behaviorHints: {
      bingeGroup: `anicli-${animeTitle}-${mode}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Stream handler
// ---------------------------------------------------------------------------
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[stream] type=${type} id=${id}`);
  try {
    const { source, baseId, episode } = parseStremioId(id);
    if (!baseId) return { streams: [] };

    let title;
    let isAnime = true;
    if (source === "kitsu") {
      ({ title, isAnime } = await resolveKitsuTitle(baseId));
    } else {
      ({ title, isAnime } = await resolveImdbTitle(type, baseId));
    }

    // For IMDb ids, only anime should reach anidb.app.  Non-animation titles
    // return nothing immediately (keeps this add-on out of every movie's list).
    if (!isAnime) {
      console.log(`[stream] ${baseId} "${title}" is not animation — skipping`);
      return { streams: [] };
    }
    console.log(`[stream] ${source} ${baseId} -> "${title}" (ep ${episode})`);

    const results = await searchAnidb(title);
    if (!results.length) {
      console.log("[stream] no anidb search results");
      return { streams: [] };
    }
    const anime = pickBest(results, title);
    console.log(`[stream] matched anidb: ${anime.slug}`);

    const epMap = await getEpisodeMap(anime.num);
    const episodeId = epMap.get(String(episode)) || epMap.get(String(Number(episode)));
    if (!episodeId) {
      console.log(`[stream] episode ${episode} not found (have ${epMap.size} eps)`);
      return { streams: [] };
    }

    const streams = [];
    // DUB first (highest quality on top), then SUB — dub entries sit at the
    // top of Stremio's list, subs at the bottom.
    for (const mode of ["dub", "sub"]) {
      try {
        const embed = await getEmbedUrl(episodeId, mode);
        if (!embed) continue;
        const master = await getMasterFromEmbed(embed);
        if (!master) continue;

        const variants = await parseMasterVariants(master);
        // Highest resolution first (1080p → 720p → 360p) so the top pick is
        // the best-quality stream; the adaptive master goes last in the group.
        variants.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
        for (const v of variants) {
          streams.push(
            makeStream({ url: v.url, quality: v.quality, animeTitle: anime.title, episode, mode })
          );
        }
        streams.push(
          makeStream({ url: master, quality: variants.length ? "auto" : "HLS", animeTitle: anime.title, episode, mode })
        );
      } catch (e) {
        if (e instanceof CloudflareError) {
          console.error(`[stream] Cloudflare blocked (${mode}). See ANIDB_CURL / curl-impersonate note.`);
        } else {
          console.error(`[stream] ${mode} failed:`, e.message);
        }
      }
    }

    console.log(`[stream] returning ${streams.length} link(s)`);
    return { streams };
  } catch (err) {
    if (err instanceof CloudflareError) {
      console.error("[stream] Cloudflare blocked the request. Set ANIDB_CURL to a curl-impersonate binary.");
    } else {
      console.error("[stream] error:", err.message);
    }
    return { streams: [] };
  }
});

// ---------------------------------------------------------------------------
// OPTIONAL: drive the real ani-cli binary instead of scraping in-process.
// ---------------------------------------------------------------------------
/**
 * ani-cli is an interactive Bash script; on Windows it needs WSL or Git Bash.
 * `-d` makes it print the stream URL instead of launching a player.  We answer
 * its episode prompt by piping the number in.  The in-process scraper above is
 * the recommended path — this exists to satisfy "execute ani-cli directly".
 */
// eslint-disable-next-line no-unused-vars
function getStreamsViaCli(title, episode) {
  return new Promise((resolve) => {
    const script = `printf '%s\\n' "${episode}" | ani-cli -d "${String(title).replace(/"/g, "")}"`;
    execFile("bash", ["-lc", script], { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, out, errout) => {
      const blob = `${out || ""}\n${errout || ""}`;
      const urls = blob.match(/https?:\/\/\S+\.(?:m3u8|mp4)\S*/g) || [];
      resolve([...new Set(urls)]);
    });
  });
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
serveHTTP(builder.getInterface(), { port: PORT });

console.log("=".repeat(64));
console.log(" Ani-CLI Local Streams add-on is running.");
console.log(` Manifest:  http://127.0.0.1:${PORT}/manifest.json`);
console.log(` Install :  stremio://127.0.0.1:${PORT}/manifest.json`);
if (SYSTEM_CURL) console.log(` anidb fetch via curl: ${SYSTEM_CURL}  (probed, clears Cloudflare)`);
else console.log(" anidb fetch via: Node/axios (no working curl found — may hit Cloudflare; install curl-impersonate)");
console.log("=".repeat(64));
