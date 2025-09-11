// scripts/generate-linkedin-clearecondl.js
/* v11 — logs détaillés + debug HTML + profil(s) ciblé(s)
   - LOG_LEVEL=debug|info (def: info)
   - DEBUG_SAVE_HTML=1 (sauve HTML dans .cache/li/)
   - PROFILE_URLS="https://www.linkedin.com/in/foo/,https://www.linkedin.com/in/bar/"
   - PROFILE_ONLY=1 (désactive les SERP, ne scrape que les profils)
   - CANDIDATE_LIMIT=200 (borne max URLs à traiter)
   Usage: node scripts/generate-linkedin-clearecondl.js
*/
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = path.join(__dirname, "..", "src", "content", "li-clearecondl");
const CACHE_DIR = path.join(__dirname, "..", ".cache", "li");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

/* ---------- Config ---------- */
const YEAR = 2025;
const KEYWORDS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  "CleaReconDL",
  "clearecon dl",
  "clearecondl",
  "clearecon",
];

// Profil explicitement demandé par toi
const DEFAULT_PROFILES = [
  "https://www.linkedin.com/in/charles-nutting-do-fsir-5b18b95a/",
];

const PROFILE_TARGETS = [
  ...DEFAULT_PROFILES,
  ...(process.env.PROFILE_URLS ? process.env.PROFILE_URLS.split(",").map(s => s.trim()).filter(Boolean) : []),
];

const HARD_TIMEOUT_MS = 20000;
let   PAUSE_MS = 1200; // douceur anti-throttling (ajustable via env)
if (process.env.PAUSE_MS) PAUSE_MS = Math.max(400, Number(process.env.PAUSE_MS) || 1200);

const HEADERS = [
  { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
  { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
  { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/123.0", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
];

const BING_KEY = process.env.AZURE_BING_KEY || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const DEBUG_SAVE_HTML = !!process.env.DEBUG_SAVE_HTML;
const PROFILE_ONLY = !!process.env.PROFILE_ONLY;
const CANDIDATE_LIMIT = Number(process.env.CANDIDATE_LIMIT || 300);

/* ---------- Log helpers ---------- */
const log = {
  info: (...a) => console.log("[INFO]", ...a),
  warn: (...a) => console.warn("[WARN]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
  debug: (...a) => { if (LOG_LEVEL === "debug") console.log("[DEBUG]", ...a); },
};

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

function normalizeText(s = "") {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
function ensureAbsolute(imgUrl) {
  if (!imgUrl) return null;
  if (/^https?:\/\//i.test(imgUrl)) return imgUrl;
  if (imgUrl.startsWith("//")) return "https:" + imgUrl;
  return null;
}
function looksLinkedInPost(u) {
  try {
    const url = new URL(u);
    if (!/(\.|^)linkedin\.com$/i.test(url.hostname)) return false;
    const p = url.pathname;
    return /\/feed\/update\/|\/posts\/|activity\/|ugcPost\/|share\/|update\//i.test(p) || /urn%3Ali%3A(ugcPost|activity)%3A/i.test(url.href);
  } catch { return false; }
}
function keyFromUrlOrUrn(urlStr, urn) {
  if (urn) return urn;
  try {
    const u = new URL(urlStr);
    return `${u.origin}${u.pathname}`;
  } catch { return urlStr; }
}
function fallbackAvatar(urlStr) {
  try {
    const u = new URL(urlStr);
    return `https://unavatar.io/host/${u.hostname}`;
  } catch {
    return "https://unavatar.io/linkedin";
  }
}
function mdPathFor(item) {
  const d = new Date(item.date || Date.now());
  const y = d.getFullYear();
  const m = `${d.getMonth()+1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  const slug = normalizeText(item.title).replace(/[^a-z0-9\- ]/g, "").replace(/\s+/g, "-").slice(0, 80) || sha1(item.url).slice(0, 8);
  return path.join(OUT_DIR, `${y}-${m}-${day}-${slug}.md`);
}
function writeIfChanged(fp, content) {
  if (fs.existsSync(fp)) {
    const cur = fs.readFileSync(fp, "utf-8");
    if (sha1(cur) === sha1(content)) return false;
  }
  fs.writeFileSync(fp, content);
  return true;
}

/* ---------- Fetch helpers ---------- */
async function fetchWithUA(url, i = 0) {
  const h = HEADERS[i % HEADERS.length];
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HARD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: h, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(to);
  }
}
async function getHTML(rawUrl, label = "page") {
  const proxied = rawUrl.replace(/^https?:\/\//, (m) => `https://r.jina.ai/${m}`);
  for (let i = 0; i < HEADERS.length; i++) {
    try {
      const { text } = await fetchWithUA(proxied, i);
      if (text && text.length > 200) {
        if (DEBUG_SAVE_HTML) {
          const name = `${Date.now()}-${label}-${sha1(rawUrl).slice(0,8)}.html`;
          fs.writeFileSync(path.join(CACHE_DIR, name), text);
          log.debug(`HTML sauvegardé: ${name}`);
        }
        return text;
      }
    } catch (e) {
      log.debug(`getHTML(${label}) tentative#${i+1} erreur: ${e.message}`);
      await sleep(500);
    }
  }
  return "";
}

/* ---------- Extraction ---------- */
function extractMeta(html) {
  const m = {};
  const get = (name) => {
    const re = new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    return (html.match(re) || html.match(re2) || [])[1] || "";
  };
  m.title = get("og:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "";
  m.description = get("og:description") || get("description") || "";
  m.image = ensureAbsolute(get("og:image") || get("twitter:image"));
  m.updateUrn = (html.match(/urn:li:(?:activity|ugcPost):\d+/i) || [])[0] || "";
  if (!m.image) {
    const mImg = html.match(/https?:\/\/media\.licdn\.com\/[^"' >]+/i);
    if (mImg) m.image = mImg[0];
  }
  // Dates potentielles
  m.date =
    (html.match(/datetime="(2025-[^"]+)"/i) || [])[1] ||
    (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"publishedAt"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    "";
  return m;
}
function passesSemanticFilter(text) {
  const t = normalizeText(text || "");
  return (
    t.includes("clearecondl") ||
    t.includes("clea recon dl") ||
    t.includes("#clearecondl") ||
    t.includes("clearecon dl") ||
    t.includes("clearecon")
  );
}
function isYearOK(dateStr) {
  if (!dateStr) return true;
  const y = Number(String(dateStr).slice(0, 4));
  return y === YEAR;
}

/* ---------- SERP (optionnel) ---------- */
async function searchGoogleHTML(q) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbs=cdr:1,cd_min:1/1/${YEAR},cd_max:12/31/${YEAR}`;
  const html = await getHTML(url, "google-serp");
  const links = [];
  const re = /<a href="(https?:\/\/[^"]+)"[^>]*>(?:<h3|<span)/ig;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (href.includes("/url?q=")) {
      try {
        const u = new URL(href);
        const real = u.searchParams.get("q");
        if (real) links.push(real);
      } catch {}
    } else {
      links.push(href);
    }
  }
  return links;
}
async function searchDuckDuckGo(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const html = await getHTML(url, "ddg-serp");
  const links = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/ig;
  let m;
  while ((m = re.exec(html))) links.push(m[1]);
  return links;
}
async function gatherCandidatesFromSERP() {
  if (PROFILE_ONLY) {
    log.info("SERP désactivé (PROFILE_ONLY=1).");
    return [];
  }
  log.info("Recherche SERP…");
  const urls = new Set();
  const engines = [searchGoogleHTML, searchDuckDuckGo]; // Bing HTML souvent 451 -> on évite
  let totalAdds = 0;

  for (const kw of KEYWORDS) {
    for (const eng of engines) {
      try {
        const q1 = `${kw} site:linkedin.com`;
        const r1 = (await eng(q1)).slice(0, 50);
        r1.forEach(u => { if (looksLinkedInPost(u)) urls.add(u); });
        log.debug(`SERP ${eng.name} ${q1} -> ${r1.length}`);

        await sleep(PAUSE_MS);

        const q2 = `${kw} 2025 site:linkedin.com`;
        const r2 = (await eng(q2)).slice(0, 50);
        r2.forEach(u => { if (looksLinkedInPost(u)) urls.add(u); });
        log.debug(`SERP ${eng.name} ${q2} -> ${r2.length}`);
      } catch (e) {
        log.warn(`SERP ${eng.name} erreur: ${e.message}`);
      }
      await sleep(PAUSE_MS);
    }
  }
  totalAdds = urls.size;
  log.info(`SERP: ${totalAdds} URL(s) candidates.`);
  return Array.from(urls);
}

/* ---------- Profil scraping ---------- */
function normalizeProfileUrl(u) {
  try {
    const x = new URL(u);
    // impose /in/.../ (avec trailing slash)
    const parts = x.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts[0] !== "in") return u.replace(/\/+$/, "") + "/";
    return `${x.origin}/in/${parts[1]}/`;
  } catch { return u; }
}
function profileActivityPages(profileUrl) {
  const base = normalizeProfileUrl(profileUrl);
  return [
    base + "recent-activity/all/",
    base + "recent-activity/shares/",
    base + "recent-activity/posts/",
  ];
}
function extractPostLinksFromActivityHTML(html) {
  const links = new Set();
  const reUpdate = /https?:\/\/www\.linkedin\.com\/feed\/update\/[^\s"'<>]+/ig;
  const rePosts  = /https?:\/\/www\.linkedin\.com\/posts\/[^\s"'<>]+/ig;
  const reUrnEnc = /https?:\/\/www\.linkedin\.com\/feed\/update\/[^\s"'<>]*urn%3Ali%3Aactivity%3A\d+/ig;
  let m;
  while ((m = reUpdate.exec(html))) links.add(m[0]);
  while ((m = rePosts.exec(html)))  links.add(m[0]);
  while ((m = reUrnEnc.exec(html))) links.add(m[0]);
  return Array.from(links).filter(looksLinkedInPost);
}
async function gatherCandidatesFromProfiles() {
  if (PROFILE_TARGETS.length === 0) {
    log.info("Aucun profil ciblé.");
    return [];
  }
  log.info(`Scrape profils ciblés (${PROFILE_TARGETS.length})…`);
  const urls = new Set();
  for (const profile of PROFILE_TARGETS) {
    const pages = profileActivityPages(profile);
    log.info(`Profil: ${normalizeProfileUrl(profile)} (pages: ${pages.length})`);
    for (const p of pages) {
      try {
        const html = await getHTML(p, "profile-activity");
        if (!html) { log.warn(`Profil activity vide: ${p}`); continue; }
        const links = extractPostLinksFromActivityHTML(html);
        links.forEach(u => urls.add(u));
        log.info(`  ${new URL(p).pathname} -> ${links.length} lien(s)`);
      } catch (e) {
        log.warn(`  Erreur activity ${p}: ${e.message}`);
      }
      await sleep(PAUSE_MS);
    }
  }
  log.info(`Profils: ${urls.size} URL(s) candidates.`);
  return Array.from(urls);
}

/* ---------- Filtrage & Hydratation ---------- */
function frontmatter(o) {
  const fm = {
    title: o.title,
    date: o.date,
    url: o.url,
    origin: o.origin,
    pathname: o.pathname,
    host: o.host,
    image: o.image,
    updateUrn: o.updateUrn || null,
    source: o.sourceEngine,
  };
  const yaml = Object.entries(fm)
    .filter(([_, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${o.description || ""}\n`;
}

function textForFilter(meta, html) {
  const raw = (html || "").replace(/\s+/g, " ").slice(0, 4000);
  return `${meta.title || ""} ${meta.description || ""} ${raw}`;
}

async function processURL(url, sourceEngine = "multi") {
  const html = await getHTML(url, "post");
  if (!html) { log.debug(`IGNORED(nohtml): ${url}`); return { item:null, reason:"nohtml" }; }

  const meta = extractMeta(html);
  const text = textForFilter(meta, html);

  if (!passesSemanticFilter(text)) {
    log.debug(`IGNORED(nokey): ${url}`);
    return { item:null, reason:"nokey" };
  }
  if (!isYearOK(meta.date)) {
    log.debug(`IGNORED(not${YEAR}): ${url} (date=${meta.date})`);
    return { item:null, reason:`not${YEAR}` };
  }

  const u = new URL(url);
  const item = {
    title: (meta.title || "(Sans titre)").trim(),
    description: (meta.description || "").trim(),
    date: meta.date || new Date().toISOString(),
    url,
    origin: u.origin,
    pathname: u.pathname,
    host: u.hostname,
    image: meta.image || fallbackAvatar(url),
    updateUrn: meta.updateUrn || undefined,
    sourceEngine,
  };
  return { item, reason:"ok" };
}

/* ---------- Main ---------- */
(async () => {
  console.time("total");
  try {
    const set = new Set();

    const fromProfiles = await gatherCandidatesFromProfiles();
    fromProfiles.forEach(u => set.add(u));

    const fromSerp = await gatherCandidatesFromSERP();
    fromSerp.forEach(u => set.add(u));

    let candidates = Array.from(set);
    if (candidates.length > CANDIDATE_LIMIT) {
      candidates = candidates.slice(0, CANDIDATE_LIMIT);
      log.info(`Candidats tronqués à ${CANDIDATE_LIMIT} (env CANDIDATE_LIMIT).`);
    }

    log.info(`Total candidats: ${candidates.length}`);
    let created = 0, updated = 0, kept = 0, matched = 0;
    const seenKeys = new Set();

    for (const [idx, url] of candidates.entries()) {
      log.debug(`Process [${idx+1}/${candidates.length}] ${url}`);
      try {
        const { item, reason } = await processURL(url, "multi+profile");
        if (!item) { /* reason already logged */ }
        else {
          matched++;
          const key = keyFromUrlOrUrn(item.url, item.updateUrn);
          if (seenKeys.has(key)) { log.debug(`DEDUP: ${url}`); }
          else {
            seenKeys.add(key);
            const md = frontmatter(item);
            const fp = mdPathFor(item);
            const existed = fs.existsSync(fp);
            const changed = writeIfChanged(fp, md);
            if (!existed && changed) { created++; log.info(`CREATED: ${fp}`); }
            else if (existed && changed) { updated++; log.info(`UPDATED: ${fp}`); }
            else { kept++; log.debug(`UNCHANGED: ${fp}`); }
          }
        }
      } catch (e) {
        log.warn(`ERROR(process): ${url} -> ${e.message}`);
      }
      await sleep(PAUSE_MS);
    }

    log.info(`Résultat — pertinents: ${matched}, créés: ${created}, maj: ${updated}, inchangés: ${kept}`);
  } catch (e) {
    log.error("Fatal:", e);
    process.exitCode = 1;
  } finally {
    console.timeEnd("total");
  }
})();
