// scripts/generate-linkedin-clearecondl.js
/* v10 — +scrape profil(s) ciblé(s) (ex: Charles Nutting) avec filtres #clearecondl/CleaRecon DL/CleaReconDL en 2025
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
fs.mkdirSync(OUT_DIR, { recursive: true });

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

// ⚠️ Profils à forcer (scrape direct des “recent activity”)
const PROFILE_TARGETS = [
  // transmis par l'utilisateur
  "https://www.linkedin.com/in/charles-nutting-do-fsir-5b18b95a/",
  // optionnel: variable d'env (séparée par des virgules)
  ...(process.env.PROFILE_URLS ? process.env.PROFILE_URLS.split(",").map(s => s.trim()).filter(Boolean) : []),
];

const HARD_TIMEOUT_MS = 20000;
const PAUSE_MS = 1200; // throttling douceur
const HEADERS = [
  { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36" },
  { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15" },
  { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/123.0" },
];

const BING_KEY = process.env.AZURE_BING_KEY || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

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

function ensureAbsolute(imgUrl) {
  if (!imgUrl) return null;
  if (/^https?:\/\//i.test(imgUrl)) return imgUrl;
  if (imgUrl.startsWith("//")) return "https:" + imgUrl;
  return null;
}

async function fetchWithUA(url, i = 0) {
  const h = HEADERS[i % HEADERS.length];
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HARD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: h, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

async function getHTML(url) {
  // via r.jina.ai pour contourner JS/consent
  const proxied = url.replace(/^https?:\/\//, (m) => `https://r.jina.ai/${m}`);
  for (let i = 0; i < HEADERS.length; i++) {
    try {
      const html = await fetchWithUA(proxied, i);
      if (html && html.length > 200) return html;
    } catch {
      await sleep(500);
    }
  }
  return "";
}

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
  // updateUrn si présent
  const urn = (html.match(/urn:li:(?:activity|ugcPost):\d+/i) || [])[0] || "";
  m.updateUrn = urn;

  // 1re image media.licdn.com si pas d'og:image
  if (!m.image) {
    const mImg = html.match(/https?:\/\/media\.licdn\.com\/[^"' >]+/i);
    if (mImg) m.image = mImg[0];
  }
  // date (essaie plusieurs patterns)
  m.date =
    (html.match(/datetime="(2025-[^"]+)"/i) || [])[1] ||
    (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"publishedAt"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    "";
  return m;
}

function passesSemanticFilter(title, desc) {
  const t = normalizeText(`${title} ${desc}`);
  return (
    t.includes("clearecondl") ||
    t.includes("clearecon dl") ||
    t.includes("clea recon dl") ||
    t.includes("#clearecondl") ||
    t.includes("clearecon")
  );
}

function isYearOK(dateStr) {
  if (!dateStr) return true; // si inconnu, on garde (faute d'API)
  const y = Number(String(dateStr).slice(0, 4));
  return y === YEAR;
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

function writeIfChanged(fp, content) {
  if (fs.existsSync(fp)) {
    const cur = fs.readFileSync(fp, "utf-8");
    if (sha1(cur) === sha1(content)) return false;
  }
  fs.writeFileSync(fp, content);
  return true;
}

/* ---------- Searchers (SERP) ---------- */
async function searchDuckDuckGo(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const html = await getHTML(url);
  const links = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/ig;
  let m;
  while ((m = re.exec(html))) links.push(m[1]);
  return links;
}

async function searchBingHTML(q) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
  const html = await getHTML(url);
  const links = [];
  const re = /<li class="b_algo".*?<a href="([^"]+)"/igs;
  let m;
  while ((m = re.exec(html))) links.push(m[1]);
  return links;
}

async function searchGoogleHTML(q) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbs=cdr:1,cd_min:1/1/${YEAR},cd_max:12/31/${YEAR}`;
  const html = await getHTML(url);
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

async function searchBingAPI(q) {
  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": BING_KEY } });
  if (!res.ok) throw new Error(`Bing API ${res.status}`);
  const j = await res.json();
  return (j.webPages?.value || []).map(v => v.url);
}

async function searchSerpAPI(q) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&tbs=cdr:1,cd_min:1/1/${YEAR},cd_max:12/31/${YEAR}&api_key=${SERPAPI_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  const j = await res.json();
  const links = [];
  (j.organic_results || []).forEach(r => r.link && links.push(r.link));
  return links;
}

async function gatherCandidatesFromSERP() {
  const engines = [];
  if (SERPAPI_KEY) engines.push(async q => (await searchSerpAPI(q)));
  if (BING_KEY) engines.push(async q => (await searchBingAPI(q)));
  // HTML fallbacks
  engines.push(searchGoogleHTML, searchBingHTML, searchDuckDuckGo);

  const urls = new Set();
  for (const kw of KEYWORDS) {
    for (const eng of engines) {
      try {
        const results = (await eng(`${kw} site:linkedin.com`)).slice(0, 50);
        results.forEach(u => { if (looksLinkedInPost(u)) urls.add(u); });
      } catch {}
      await sleep(PAUSE_MS);
    }
    for (const eng of engines) {
      try {
        const results = (await eng(`${kw} 2025 site:linkedin.com`)).slice(0, 50);
        results.forEach(u => { if (looksLinkedInPost(u)) urls.add(u); });
      } catch {}
      await sleep(PAUSE_MS);
    }
  }
  return Array.from(urls);
}

/* ---------- Profil scraping ---------- */
/** Construit les URLs “recent activity” d’un profil */
function profileActivityPages(profileUrl) {
  // normalise /in/xxx/
  const base = profileUrl.replace(/(\?|#).*$/, "").replace(/\/+$/, "") + "/";
  return [
    base + "recent-activity/all/",
    base + "recent-activity/shares/",
    base + "recent-activity/posts/",
  ];
}

/** Extrait des URLs de posts LI depuis la page recent-activity */
function extractPostLinksFromActivityHTML(html) {
  const links = new Set();

  // liens bruts “/feed/update/urn:li:activity:XXXXXXXXXXXX”
  const reUpdate = /https?:\/\/www\.linkedin\.com\/feed\/update\/[^\s"'<>]+/ig;
  let m;
  while ((m = reUpdate.exec(html))) links.add(m[0]);

  // liens “/posts/...” (format “créateur/posts/...”)
  const rePosts = /https?:\/\/www\.linkedin\.com\/posts\/[^\s"'<>]+/ig;
  while ((m = rePosts.exec(html))) links.add(m[0]);

  // liens encodés “urn%3Ali%3Aactivity%3A...”
  const reUrnEnc = /https?:\/\/www\.linkedin\.com\/feed\/update\/[^\s"'<>]*urn%3Ali%3Aactivity%3A\d+/ig;
  while ((m = reUrnEnc.exec(html))) links.add(m[0]);

  return Array.from(links).filter(looksLinkedInPost);
}

/** Va chercher tous les posts d'un profil (via pages recent-activity), puis filtre par mots-clés */
async function gatherCandidatesFromProfiles() {
  const urls = new Set();
  for (const profile of PROFILE_TARGETS) {
    const pages = profileActivityPages(profile);
    for (const p of pages) {
      try {
        const html = await getHTML(p);
        if (!html) continue;
        const links = extractPostLinksFromActivityHTML(html);
        links.forEach(u => urls.add(u));
      } catch {}
      await sleep(PAUSE_MS);
    }
  }
  return Array.from(urls);
}

/* ---------- Pipeline Post ---------- */
function textForFilter(meta, html) {
  // parfois og:title/desc sont creux ; on concatène un échantillon brut
  const raw = (html || "").replace(/\s+/g, " ").slice(0, 2000);
  return `${meta.title || ""} ${meta.description || ""} ${raw}`;
}

async function processURL(url, sourceEngine = "multi") {
  const html = await getHTML(url);
  if (!html) return null;

  const meta = extractMeta(html);
  const text = textForFilter(meta, html);
  if (!passesSemanticFilter(meta.title, text)) return null;
  if (!isYearOK(meta.date)) return null;

  const u = new URL(url);
  const item = {
    title: meta.title?.trim() || "(Sans titre)",
    description: meta.description?.trim() || "",
    date: meta.date || new Date().toISOString(),
    url,
    origin: u.origin,
    pathname: u.pathname,
    host: u.hostname,
    image: meta.image || fallbackAvatar(url),
    updateUrn: meta.updateUrn || undefined,
    sourceEngine,
  };
  return item;
}

/* ---------- Main ---------- */
(async () => {
  const candidatesSet = new Set();

  // 1) SERP (moteurs)
  const serp = await gatherCandidatesFromSERP();
  serp.forEach(u => candidatesSet.add(u));

  // 2) Profils ciblés (ex: Charles Nutting)
  const fromProfiles = await gatherCandidatesFromProfiles();
  fromProfiles.forEach(u => candidatesSet.add(u));

  // Pipeline
  const candidates = Array.from(candidatesSet);
  const seenKeys = new Set();
  let created = 0, updated = 0, kept = 0, matched = 0;

  for (const url of candidates) {
    try {
      const item = await processURL(url, "multi+profile");
      if (!item) { continue; }
      matched++;

      const key = keyFromUrlOrUrn(item.url, item.updateUrn);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const md = frontmatter(item);
      const fp = mdPathFor(item);
      const existed = fs.existsSync(fp);
      const changed = writeIfChanged(fp, md);
      if (!existed && changed) created++;
      else if (existed && changed) updated++;
      else kept++;
    } catch {
      // ignore et continue
    }
    await sleep(PAUSE_MS);
  }

  console.log(`LinkedIn 2025 — candidats totaux: ${candidates.length}, pertinents: ${matched}, créés: ${created}, maj: ${updated}, inchangés: ${kept}`);
})();
