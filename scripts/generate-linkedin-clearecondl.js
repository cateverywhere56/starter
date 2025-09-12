// scripts/generate-linkedin-clearecondl.js
/* v15 — SERP HTML (Mojeek + Qwant Lite) → posts LinkedIn (sans Google, sans profils)
   - Cherche des URLs LI via moteurs HTML légers (pas d'API)
   - Variantes avec/ sans site:linkedin.com pour récupérer des backlinks qui pointent sur LI
   - Extrait: profileName, postText, image, date, updateUrn
   - Dédoublonnage: updateUrn puis origin+pathname
   Usage: node scripts/generate-linkedin-clearecondl.js
*/
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OUT_DIR = path.join(__dirname, "..", "src", "content", "li-clearecondl");
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------- Config ---------- */
const YEAR = 2025;
const TERMS = [
  "#clearecondl",
  "CleaRecon DL",
  "CleaReconDL",
  "clearecon dl",
  "clearecondl",
  "clearecon"
];

const TIMEOUT_MS = 20000;
const PAUSE_MS = Number(process.env.PAUSE_MS || 1200);
const UAS = [
  { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
  { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
  { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/123.0", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" }
];

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha1  = (s) => crypto.createHash("sha1").update(s).digest("hex");
const norm  = (s="") => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/\s+/g," ").trim();

const containsClea = (txt="") => {
  const t = norm(txt);
  return (
    t.includes("clearecondl") || t.includes("clea recon dl") ||
    t.includes("#clearecondl") || t.includes("clearecon dl") || t.includes("clearecon")
  );
};

function looksLI(u) {
  try {
    const x = new URL(u);
    if (!/(\.|^)linkedin\.com$/i.test(x.hostname)) return false;
    const p = x.pathname;
    return /\/feed\/update\/|\/posts\/|activity\/|ugcPost\/|share\/|update\//i.test(p) || /urn%3Ali%3A(ugcPost|activity)%3A/i.test(x.href);
  } catch { return false; }
}
function ensureAbs(img) {
  if (!img) return null;
  if (img.startsWith("//")) return "https:" + img;
  if (/^https?:\/\//i.test(img)) return img;
  return null;
}
function keyFrom(urlStr, urn) {
  if (urn) return urn.toLowerCase();
  try { const u = new URL(urlStr); return (u.origin + u.pathname).toLowerCase(); }
  catch { return (urlStr||"").toLowerCase(); }
}

/* ---------- Fetch helpers (via r.jina.ai proxy pour HTML statique) ---------- */
async function fetchText(url, i=0) {
  const h = UAS[i % UAS.length];
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: h, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(to); }
}
async function getHTML(rawUrl) {
  const proxied = rawUrl.replace(/^https?:\/\//, (m) => `https://r.jina.ai/${m}`);
  for (let i=0;i<UAS.length;i++){
    try {
      const t = await fetchText(proxied, i);
      if (t && t.length > 200) return t;
    } catch { await sleep(250); }
  }
  return "";
}

/* ---------- SERP: Mojeek + Qwant Lite ---------- */
async function mojeek(q) {
  // Mojeek HTML
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`;
  const html = await getHTML(url);
  const links = [];
  // résultats: <a class="result-title" href="...">
  const re = /<a[^>]+class="result-title"[^>]+href="([^"]+)"/ig;
  let m; while ((m = re.exec(html))) links.push(m[1]);
  return links;
}
async function qwantLite(q) {
  // Qwant Lite (HTML)
  const url = `https://lite.qwant.com/?q=${encodeURIComponent(q)}`;
  const html = await getHTML(url);
  const links = [];
  // résultats: <a class="result__a" href="..."> ou <a class="web-result__title" href="...">
  const re1 = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/ig;
  const re2 = /<a[^>]+class="web-result__title"[^>]+href="([^"]+)"/ig;
  let m; while ((m = re1.exec(html))) links.push(m[1]);
  while ((m = re2.exec(html))) links.push(m[1]);
  return links;
}

async function gatherCandidates() {
  const queries = [];
  // ciblage direct LI
  TERMS.forEach(t => {
    queries.push(`${t} site:linkedin.com`);
    queries.push(`${t} site:linkedin.com/posts`);
    queries.push(`${t} site:linkedin.com/feed/update`);
  });
  // sans site: (on récupère des pages qui pointent sur LI)
  TERMS.forEach(t => {
    queries.push(`${t} linkedin`);
    queries.push(`${t} "on LinkedIn"`);
  });
  // variante 2025
  TERMS.forEach(t => {
    queries.push(`${t} 2025 site:linkedin.com`);
    queries.push(`${t} 2025 linkedin`);
  });

  const engines = [
    { name: "mojeek", fn: mojeek },
    { name: "qwant",  fn: qwantLite }
  ];

  const urls = new Set();
  for (const q of queries) {
    for (const eng of engines) {
      try {
        const raw = (await eng.fn(q)).slice(0, 60);
        // si pas de site:, on filtre après coup
        const filtered = raw.filter(u => u.includes("linkedin.com"));
        const liOnly  = filtered.filter(looksLI);
        liOnly.forEach(u => urls.add(u));
        console.log(`[DEBUG] SERP ${eng.name} "${q}" -> ${liOnly.length}/${raw.length}`);
      } catch (e) {
        console.log(`[DEBUG] SERP ${eng.name} error "${q}": ${e.message}`);
      }
      await sleep(PAUSE_MS);
    }
  }
  const out = Array.from(urls);
  console.log(`[INFO] SERP: ${out.length} URL(s) candidates.`);
  return out;
}

/* ---------- Extraction d'un post LI ---------- */
function extractFromHTML(html) {
  const grab = (name) => {
    const re = new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    const re2= new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    return (html.match(re) || html.match(re2) || [])[1] || "";
  };

  const ogTitle = grab("og:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || "";
  const ogDesc  = grab("og:description") || grab("description") || "";
  let image     = ensureAbs(grab("og:image") || grab("twitter:image"));
  if (!image) {
    const m = html.match(/https?:\/\/media\.licdn\.com\/[^"' >]+/i);
    if (m) image = m[0];
  }
  const updateUrn = (html.match(/urn:li:(?:activity|ugcPost):\d+/i) || [])[0] || "";
  const date =
    (html.match(/datetime="(2025-[^"]+)"/i) || [])[1] ||
    (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"publishedAt"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] || "";

  // Nom du profil (patterns courants)
  let profileName = "";
  const titleLike = ogTitle || (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || "";
  const m1 = titleLike.match(/^(.+?) on LinkedIn/i);
  if (m1) profileName = m1[1].trim();

  // Texte du post
  let postText = ogDesc;
  if (!postText) {
    const body = html.replace(/\s+/g, " ");
    const qm = body.match(/“([^”]{20,280})”/);
    if (qm) postText = qm[1];
  }

  return { ogTitle, ogDesc, image, updateUrn, date, profileName, postText };
}

function titleFor(profileName, ogTitle, postText) {
  const base = postText || ogTitle || "";
  const head = profileName ? `${profileName} — ` : "";
  const t = (head + base).trim();
  return t.length > 120 ? t.slice(0,117) + "…" : t || "(Sans titre)";
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
    ["profileName", o.profileName || null],
    ["postText", o.postText || null],
    ["source", "serp-moJeek-qwant"]
  ]
  .filter(([,v]) => v !== undefined && v !== null && v !== "")
  .map(([k,v]) => `${k}: ${JSON.stringify(v)}`)
  .join("\n");

  const desc = o.postText || o.description || "";
  return `---\n${yaml}\n---\n\n${desc}\n`;
}

function mdPath(o) {
  const d = new Date(o.date || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
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

/* ---------- Main ---------- */
(async () => {
  console.time("li");
  try {
    const candidates = await gatherCandidates();
    const seen = new Set();
    let created=0, updated=0, kept=0, matched=0;

    for (const url of candidates) {
      try {
        const html = await getHTML(url);
        if (!html) continue;

        // Filtre sémantique
        if (!containsClea(html)) continue;

        const meta = extractFromHTML(html);
        if (!containsClea(`${meta.ogTitle} ${meta.ogDesc} ${meta.postText}`)) continue;

        // bornage année si date trouvée
        if (meta.date && !String(meta.date).startsWith(String(YEAR))) continue;

        const u = new URL(url);
        const item = {
          title: titleFor(meta.profileName, meta.ogTitle, meta.postText),
          description: meta.ogDesc || "",
          postText: meta.postText || meta.ogDesc || "",
          profileName: meta.profileName || "",
          date: meta.date || new Date().toISOString(),
          url,
          origin: u.origin,
          pathname: u.pathname,
          host: u.hostname,
          image: meta.image || `https://unavatar.io/host/${u.hostname}`,
          updateUrn: meta.updateUrn || undefined
        };

        const key = keyFrom(item.url, item.updateUrn);
        if (seen.has(key)) continue;
        seen.add(key);

        const content = fm(item);
        const fp = mdPath(item);
        const existed = fs.existsSync(fp);
        const changed = writeIfChanged(fp, content);

        if (!existed && changed) { created++; console.log(`[INFO] CREATED: ${fp}`); }
        else if (existed && changed) { updated++; console.log(`[INFO] UPDATED: ${fp}`); }
        else { kept++; }
        matched++;

        await sleep(PAUSE_MS);
      } catch (e) {
        console.log(`[DEBUG] process error ${url}: ${e.message}`);
      }
    }

    console.log(`[INFO] Résultat — pertinents: ${matched}, créés: ${created}, maj: ${updated}, inchangés: ${kept}`);
  } catch (e) {
    console.error("[ERROR] Fatal:", e);
    process.exitCode = 1;
  } finally {
    console.timeEnd("li");
  }
})();
