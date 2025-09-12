// scripts/generate-linkedin-clearecondl.js
/* v13 — SERP Google HTML only → posts LinkedIn
   - Cherche via Google (HTML) des URLs de posts LI contenant CleaRecon DL
   - Extrait: profileName + postText (+ image, date, updateUrn)
   - Écrit des .md dans src/content/li-clearecondl/
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
const KEY_TERMS = [
  "#clearecondl",
  "CleaRecon DL",
  "CleaReconDL",
  "clearecon dl",
  "clearecondl",
  "clearecon"
];

const HARD_TIMEOUT_MS = 20000;
const PAUSE_MS = 1200;
const UAS = [
  { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
  { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" },
  { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/123.0", "Accept-Language": "en-US,en;q=0.9,fr;q=0.8" }
];

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const norm = (s="") => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/\s+/g," ").trim();
const containsClea = (txt="") => {
  const t = norm(txt);
  return (
    t.includes("clearecondl") || t.includes("clea recon dl") ||
    t.includes("#clearecondl") || t.includes("clearecon dl") || t.includes("clearecon")
  );
};

function looksLinkedInPost(u) {
  try {
    const url = new URL(u);
    if (!/(\.|^)linkedin\.com$/i.test(url.hostname)) return false;
    const p = url.pathname;
    return /\/feed\/update\/|\/posts\/|activity\/|ugcPost\/|share\/|update\//i.test(p) || /urn%3Ali%3A(ugcPost|activity)%3A/i.test(url.href);
  } catch { return false; }
}

function ensureAbs(img) {
  if (!img) return null;
  if (img.startsWith("//")) return "https:" + img;
  if (/^https?:\/\//i.test(img)) return img;
  return null;
}

async function fetchText(url, uaIndex=0) {
  const headers = UAS[uaIndex % UAS.length];
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HARD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(to); }
}

async function getHTML(rawUrl) {
  // Utilise r.jina.ai pour éviter consent & JS
  const proxied = rawUrl.replace(/^https?:\/\//, (m) => `https://r.jina.ai/${m}`);
  for (let i=0;i<UAS.length;i++) {
    try {
      const txt = await fetchText(proxied, i);
      if (txt && txt.length > 200) return txt;
    } catch {
      await sleep(300);
    }
  }
  return "";
}

/* ---------- Google SERP (HTML) ---------- */
async function searchGoogleHTML(query) {
  // bornage temporel à YEAR
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbs=cdr:1,cd_min:1/1/${YEAR},cd_max:12/31/${YEAR}`;
  const html = await getHTML(url);
  const out = [];
  const re = /<a href="(https?:\/\/[^"]+)"[^>]*>(?:<h3|<span)/ig;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (href.includes("/url?q=")) {
      try {
        const u = new URL(href);
        const real = u.searchParams.get("q");
        if (real) out.push(real);
      } catch {}
    } else {
      out.push(href);
    }
  }
  // Nettoie
  const uniq = Array.from(new Set(out));
  return uniq.filter(looksLinkedInPost);
}

async function gatherCandidates() {
  const queries = [];
  // queries génériques
  KEY_TERMS.forEach(term => {
    queries.push(`${term} site:linkedin.com/posts`);
    queries.push(`${term} site:linkedin.com/feed/update`);
    queries.push(`${term} site:linkedin.com`);
  });
  // variante explicite “2025” (au cas où le tbs cdr ne suffise pas)
  KEY_TERMS.forEach(term => {
    queries.push(`${term} 2025 site:linkedin.com`);
  });

  const urls = new Set();
  for (const q of queries) {
    try {
      const res = await searchGoogleHTML(q);
      res.forEach(u => urls.add(u));
    } catch {}
    await sleep(PAUSE_MS);
  }
  return Array.from(urls);
}

/* ---------- Extraction post LI ---------- */
function extractFromHTML(html) {
  // métas
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
    (html.match(/"publishedAt"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    "";

  // Heuristique nom profil (souvent "Name on LinkedIn: …")
  let profileName = "";
  const m1 = ogTitle.match(/^(.+?) on LinkedIn/i);
  if (m1) profileName = m1[1].trim();
  // autre fallback: balise title classique "Name on LinkedIn: …"
  if (!profileName) {
    const t = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "";
    const m2 = t.match(/^(.+?) on LinkedIn/i);
    if (m2) profileName = m2[1].trim();
  }
  // Texte du post: og:description, sinon un extrait brut
  let postText = ogDesc;
  if (!postText) {
    const body = html.replace(/\s+/g, " ");
    // essaie de capturer un bout de phrase après "says" / “”
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

function keyFrom(urlStr, urn) {
  if (urn) return urn.toLowerCase();
  try { const u = new URL(urlStr); return (u.origin + u.pathname).toLowerCase(); }
  catch { return (urlStr || "").toLowerCase(); }
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
    ["source", "google-serp"]
  ]
  .filter(([,v]) => v !== undefined && v !== null && v !== "")
  .map(([k,v]) => `${k}: ${JSON.stringify(v)}`)
  .join("\n");

  // description = postText (pour être affiché dans index.astro qui lit summary/description)
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
    console.log(`[INFO] SERP: ${candidates.length} URL(s) candidates.`);

    const seen = new Set();
    let created=0, updated=0, kept=0, matched=0;

    for (const [i,url] of candidates.entries()) {
      try {
        const html = await getHTML(url);
        if (!html) { continue; }

        // Filtre sémantique global pour éviter le bruit
        if (!containsClea(html)) continue;

        const meta = extractFromHTML(html);
        // re-filtre sur texte + ogDesc aussi
        if (!containsClea(`${meta.ogTitle} ${meta.postText} ${meta.ogDesc}`)) continue;

        // bornage année si on a la date
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
      } catch {
        // ignore & continue
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
