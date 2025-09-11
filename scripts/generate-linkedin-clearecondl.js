// scripts/generate-linkedin-clearecondl.js
/* v12 — profils LI robustifiés + SERP avec nom + logs
   Usage (debug ciblé) :
   LOG_LEVEL=debug DEBUG_SAVE_HTML=1 PROFILE_ONLY=1 PROFILE_URLS="https://www.linkedin.com/in/charles-nutting-do-fsir-5b18b95a/" node scripts/generate-linkedin-clearecondl.js
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
const CLEA_TERMS = [
  "#clearecondl",
  "clearecon dl",
  "clea recon dl",
  "clearecondl",
  "clearecon"
];
const KEYWORDS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  "CleaReconDL",
  "clearecon dl",
  "clearecondl",
  "clearecon",
];

const DEFAULT_PROFILES = [
  "https://www.linkedin.com/in/charles-nutting-do-fsir-5b18b95a/",
];
const PROFILE_TARGETS = [
  ...DEFAULT_PROFILES,
  ...(process.env.PROFILE_URLS ? process.env.PROFILE_URLS.split(",").map(s => s.trim()).filter(Boolean) : []),
];

const HARD_TIMEOUT_MS = 20000;
let PAUSE_MS = Number(process.env.PAUSE_MS || 1300);
const HEADERS = [
  { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
  { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
  { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/123.0", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
];

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const DEBUG_SAVE_HTML = !!process.env.DEBUG_SAVE_HTML;
const PROFILE_ONLY = !!process.env.PROFILE_ONLY;
const CANDIDATE_LIMIT = Number(process.env.CANDIDATE_LIMIT || 300);

/* ---------- Log ---------- */
const log = {
  info: (...a) => console.log("[INFO]", ...a),
  warn: (...a) => console.warn("[WARN]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
  debug: (...a) => { if (LOG_LEVEL === "debug") console.log("[DEBUG]", ...a); },
};

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const norm = (s="") => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/\s+/g," ").trim();

const ensureAbs = (u) => u ? (u.startsWith("//") ? "https:"+u : (/^https?:\/\//i.test(u)?u:null)) : null;
const liPostLike = (u) => {
  try {
    const x = new URL(u);
    if (!/(\.|^)linkedin\.com$/i.test(x.hostname)) return false;
    const p = x.pathname;
    return /\/feed\/update\/|\/posts\/|activity\/|ugcPost\/|share\/|update\//i.test(p) || /urn%3Ali%3A(ugcPost|activity)%3A/i.test(x.href);
  } catch { return false; }
};

function keyFrom(urlStr, urn) {
  if (urn) return urn.toLowerCase();
  try { const u = new URL(urlStr); return (u.origin + u.pathname).toLowerCase(); }
  catch { return (urlStr||"").toLowerCase(); }
}

function fm(o) {
  const yaml = [
    ["title", o.title],
    ["date", o.date],
    ["url", o.url],
    ["origin", o.origin],
    ["pathname", o.pathname],
    ["host", o.host],
    ["image", o.image],
    ["updateUrn", o.updateUrn || null],
    ["source", o.sourceEngine]
  ].filter(([,v]) => v!==undefined && v!=="" && v!==null)
   .map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  return `---\n${yaml}\n---\n\n${o.description || ""}\n`;
}
function mdPath(o){
  const d = new Date(o.date || Date.now());
  const y = d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  const slug = (norm(o.title).replace(/[^a-z0-9\- ]/g,"").replace(/\s+/g,"-").slice(0,80)) || sha1(o.url).slice(0,8);
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

/* ---------- Fetch ---------- */
async function fetchText(url, i=0){
  const h = HEADERS[i % HEADERS.length];
  const ctrl = new AbortController();
  const to = setTimeout(()=>ctrl.abort(), HARD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {headers:h, signal:ctrl.signal});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const t = await res.text();
    return t;
  } finally { clearTimeout(to); }
}
async function getHTML(raw, label="page"){
  // proxy lecture via r.jina.ai (stateless HTML)
  const proxied = raw.replace(/^https?:\/\//, (m)=>`https://r.jina.ai/${m}`);
  for (let i=0;i<HEADERS.length;i++){
    try {
      const text = await fetchText(proxied, i);
      if (text && text.length>200) {
        if (DEBUG_SAVE_HTML) {
          const fn = `${Date.now()}-${label}-${sha1(raw).slice(0,8)}.html`;
          fs.writeFileSync(path.join(CACHE_DIR, fn), text);
          log.debug(`HTML saved: .cache/li/${fn}`);
        }
        return text;
      }
    } catch(e){ log.debug(`getHTML(${label})#${i+1}: ${e.message}`); await sleep(300); }
  }
  return "";
}

/* ---------- Extract ---------- */
function extractMeta(html){
  const grab = (name) => {
    const re = new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    const re2= new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    return (html.match(re)||html.match(re2)||[])[1] || "";
  };
  const title = grab("og:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || "";
  const description = grab("og:description") || grab("description") || "";
  let image = ensureAbs(grab("og:image") || grab("twitter:image"));
  if (!image){
    const m = html.match(/https?:\/\/media\.licdn\.com\/[^"' >]+/i);
    if (m) image = m[0];
  }
  const updateUrn = (html.match(/urn:li:(?:activity|ugcPost):\d+/i)||[])[0] || "";
  const date =
    (html.match(/datetime="(2025-[^"]+)"/i)||[])[1] ||
    (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i)||[])[1] ||
    (html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i)||[])[1] ||
    (html.match(/"publishedAt"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i)||[])[1] || "";

  return { title, description, image, updateUrn, date };
}
const containsClea = (txt="") => {
  const t = norm(txt);
  return CLEA_TERMS.some(term => t.includes(norm(term)));
};
const yearOk = (d) => !d || String(d).startsWith(String(YEAR));

/* ---------- SERP (Google + DDG) ---------- */
async function google(q){
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbs=cdr:1,cd_min:1/1/${YEAR},cd_max:12/31/${YEAR}`;
  const html = await getHTML(url, "google-serp");
  const out = [];
  const re = /<a href="(https?:\/\/[^"]+)"[^>]*>(?:<h3|<span)/ig;
  let m; while((m=re.exec(html))) {
    const href = m[1];
    if (href.includes("/url?q=")) {
      try { const u = new URL(href); const real = u.searchParams.get("q"); if (real) out.push(real); } catch {}
    } else out.push(href);
  }
  return out;
}
async function ddg(q){
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const html = await getHTML(url, "ddg-serp");
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/ig;
  let m; while((m=re.exec(html))) out.push(m[1]);
  return out;
}

async function gatherSERP(){
  if (PROFILE_ONLY) { log.info("SERP disabled (PROFILE_ONLY=1)"); return []; }
  log.info("Recherche SERP…");
  const queries = [];

  // Requêtes génériques
  KEYWORDS.forEach(k => {
    queries.push(`${k} site:linkedin.com`);
    queries.push(`${k} 2025 site:linkedin.com`);
  });

  // Requêtes nom + mots-clés (profil ciblé)
  const names = ["\"Charles Nutting\"","\"Charles R. Nutting\"","Nutting DO FSIR"];
  names.forEach(n => {
    KEYWORDS.forEach(k => {
      queries.push(`${n} ${k} site:linkedin.com`);
      queries.push(`${n} ${k} site:linkedin.com/feed/update`);
      queries.push(`${n} ${k} site:linkedin.com/posts`);
    });
  });

  const engines = [google, ddg];
  const urls = new Set();

  for (const q of queries) {
    for (const eng of engines) {
      try {
        const r = (await eng(q)).slice(0,50);
        r.forEach(u => { if (liPostLike(u)) urls.add(u); });
        log.debug(`SERP ${eng.name} "${q}" -> ${r.length}`);
      } catch(e) {
        log.debug(`SERP ${eng.name} error: ${e.message}`);
      }
      await sleep(PAUSE_MS);
    }
  }
  log.info(`SERP: ${urls.size} URL(s) candidates.`);
  return Array.from(urls);
}

/* ---------- Profile scraping ---------- */
function normProfile(u){
  try{
    const x = new URL(u);
    const parts = x.pathname.replace(/\/+$/,"").split("/").filter(Boolean);
    if (parts[0] !== "in") return u.replace(/\/+$/,"") + "/";
    return `${x.origin}/in/${parts[1]}/`;
  } catch { return u; }
}
function profileActivityVariants(profileUrl){
  const base = normProfile(profileUrl);
  // 6 variantes connues
  return [
    base + "recent-activity/all/",
    base + "recent-activity/shares/",
    base + "recent-activity/posts/",
    base + "detail/recent-activity/all/",
    base + "detail/recent-activity/shares/",
    base + "detail/recent-activity/posts/",
  ].flatMap(u => [u, u + "?feedView=all"]);
}
function extractLinksFromActivity(html){
  const links = new Set();
  const reA = /https?:\/\/www\.linkedin\.com\/feed\/update\/[^\s"'<>]+/ig;
  const reB = /https?:\/\/www\.linkedin\.com\/posts\/[^\s"'<>]+/ig;
  const reC = /https?:\/\/www\.linkedin\.com\/feed\/update\/[^\s"'<>]*urn%3Ali%3A(activity|ugcPost)%3A\d+/ig;
  let m; while((m=reA.exec(html))) links.add(m[0]);
  while((m=reB.exec(html))) links.add(m[0]);
  while((m=reC.exec(html))) links.add(m[0]);
  return Array.from(links).filter(liPostLike);
}
async function gatherFromProfiles(){
  if (PROFILE_TARGETS.length===0){ log.info("Aucun profil ciblé."); return []; }
  log.info(`Scrape profils ciblés (${PROFILE_TARGETS.length})…`);
  const urls = new Set();
  for (const p of PROFILE_TARGETS) {
    const variants = profileActivityVariants(p);
    log.info(`Profil: ${normProfile(p)} (variantes: ${variants.length})`);
    for (const v of variants) {
      const html = await getHTML(v, "profile-activity");
      if (!html) { log.warn(`  vide: ${v}`); await sleep(PAUSE_MS); continue; }
      const links = extractLinksFromActivity(html);
      log.info(`  ${new URL(v).pathname}${new URL(v).search} -> ${links.length} lien(s)`);
      links.forEach(u => urls.add(u));
      await sleep(PAUSE_MS);
    }
  }
  log.info(`Profils: ${urls.size} URL(s) candidates.`);
  return Array.from(urls);
}

/* ---------- Process URL ---------- */
function textForFilter(meta, html){
  const raw = (html||"").replace(/\s+/g," ").slice(0,4000);
  return `${meta.title || ""} ${meta.description || ""} ${raw}`;
}
async function processURL(url, source="multi"){
  const html = await getHTML(url, "post");
  if (!html) { log.debug(`IGNORED(nohtml): ${url}`); return null; }
  const meta = extractMeta(html);
  const text = textForFilter(meta, html);

  if (!containsClea(text)) { log.debug(`IGNORED(nokey): ${url}`); return null; }
  if (!yearOk(meta.date))  { log.debug(`IGNORED(not${YEAR}): ${url} (date=${meta.date})`); return null; }

  const u = new URL(url);
  return {
    title: (meta.title || "(Sans titre)").trim(),
    description: (meta.description || "").trim(),
    date: meta.date || new Date().toISOString(),
    url,
    origin: u.origin,
    pathname: u.pathname,
    host: u.hostname,
    image: meta.image || `https://unavatar.io/host/${u.hostname}`,
    updateUrn: meta.updateUrn || undefined,
    sourceEngine: source
  };
}

/* ---------- Main ---------- */
(async () => {
  console.time("total");
  try {
    const set = new Set();

    const pUrls = await gatherFromProfiles();
    pUrls.forEach(u => set.add(u));

    const sUrls = await gatherSERP();
    sUrls.forEach(u => set.add(u));

    let candidates = Array.from(set);
    if (candidates.length > CANDIDATE_LIMIT) {
      candidates = candidates.slice(0, CANDIDATE_LIMIT);
      log.info(`Candidats tronqués à ${CANDIDATE_LIMIT}.`);
    }

    log.info(`Total candidats: ${candidates.length}`);
    let created=0, updated=0, kept=0, matched=0;
    const seen = new Set();

    for (const [i,u] of candidates.entries()){
      log.debug(`Process [${i+1}/${candidates.length}] ${u}`);
      try {
        const item = await processURL(u, "multi+profile");
        if (!item) continue;
        matched++;
        const key = keyFrom(item.url, item.updateUrn);
        if (seen.has(key)) { log.debug(`DEDUP: ${u}`); continue; }
        seen.add(key);
        const content = fm(item);
        const fp = mdPath(item);
        const existed = fs.existsSync(fp);
        const changed = writeIfChanged(fp, content);
        if (!existed && changed) { created++; log.info(`CREATED: ${fp}`); }
        else if (existed && changed) { updated++; log.info(`UPDATED: ${fp}`); }
        else { kept++; log.debug(`UNCHANGED: ${fp}`); }
      } catch(e){
        log.warn(`ERROR(process): ${u} -> ${e.message}`);
      }
      await sleep(PAUSE_MS);
    }

    log.info(`Résultat — pertinents: ${matched}, créés: ${created}, maj: ${updated}, inchangés: ${kept}`);
  } catch(e){
    log.error("Fatal:", e);
    process.exitCode = 1;
  } finally {
    console.timeEnd("total");
  }
})();
