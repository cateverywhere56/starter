// scripts/generate-linkedin-clearecondl.js
// v19.1 — SERP via Puppeteer (Google) → Filtre URL "clearecon" → Hydratation via r.jina.ai → .md
// - Corrige l'erreur "No usable sandbox" avec args puppeteer (--no-sandbox, etc.)
// - Garde seulement les URLs contenant "clearecon" (insensible à la casse)
// - Extrait meta (titre, desc/texte, image, profil, date) via fetch r.jina.ai (pas besoin d'être loggé)
// - Trie par date DESC et loggue les posts avec miniature

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OUT_DIR = path.join(__dirname, "..", "src", "content", "li-clearecondl");
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------- Config ---------- */
const YEAR = 2025;
const PAUSE_MS = Number(process.env.PAUSE_MS || 1000);
const RESULTS_PER_PAGE = 50;   // Google num
const MAX_PAGES_PER_QUERY = 4; // nb de pages SERP par requête
const FETCH_TIMEOUT_MS = 20000;

const QUERIES = [
  'site:linkedin.com/posts "#clearecondl"',
  'site:linkedin.com/posts "CleaRecon DL"',
  'site:linkedin.com/feed/update "#clearecondl"',
  'site:linkedin.com/feed/update "CleaRecon DL"',
  'site:linkedin.com "CleaReconDL"',
  // variantes 2025
  '"#clearecondl" 2025 site:linkedin.com',
  '"CleaRecon DL" 2025 site:linkedin.com',
  'CleaReconDL 2025 site:linkedin.com'
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha1  = (s) => crypto.createHash("sha1").update(s).digest("hex");
const norm  = (s="") => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/\s+/g," ").trim();

function looksLinkedInPost(u) {
  try {
    const url = new URL(u);
    if (!/(\.|^)linkedin\.com$/i.test(url.hostname)) return false;
    const p = url.pathname;
    return /\/feed\/update\/|\/posts\/|activity\/|ugcPost\/|share\/|update\//i.test(p) ||
           /urn%3Ali%3A(ugcPost|activity)%3A/i.test(url.href);
  } catch { return false; }
}
function ensureAbs(img) {
  if (!img) return null;
  if (img.startsWith("//")) return "https:" + img;
  if (/^https?:\/\//i.test(img)) return img;
  return null;
}
function brandNewDateISO() {
  return new Date().toISOString();
}

/* ---------- Frontmatter / fichiers ---------- */
function slugify(s="") {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g,"").slice(0,80) || "post";
}
function mdPath(item) {
  const d = item.date ? new Date(item.date) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  const base = `${y}-${m}-${day}-${slugify(item.title)}`;
  return path.join(OUT_DIR, `${base}.md`);
}
function toMarkdown(item) {
  const fm = [
    ["title", item.title],
    ["date", item.date],
    ["sourceUrl", item.url],
    ["summary", item.summary || item.postText || ""],
    ["imageUrl", item.image || ""],
    ["profileName", item.profileName || ""]
  ]
  .filter(([,v]) => v!==undefined && v!==null && v!=="")
  .map(([k,v]) => `${k}: ${JSON.stringify(v)}`)
  .join("\n");
  const body = item.postText || item.summary || "";
  return `---\n${fm}\n---\n\n${body}\n`;
}
function writeIfChanged(fp, content) {
  if (fs.existsSync(fp)) {
    const old = fs.readFileSync(fp, "utf8");
    if (sha1(old) === sha1(content)) return false;
  }
  fs.writeFileSync(fp, content);
  return true;
}

/* ---------- Hydratation via r.jina.ai ---------- */
async function fetchText(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(to); }
}
async function getStaticHTML(rawUrl) {
  const proxied = rawUrl.replace(/^https?:\/\//, (m) => `https://r.jina.ai/${m}`);
  try {
    const t = await fetchText(proxied);
    return t || "";
  } catch { return ""; }
}
function extractMeta(html) {
  const grab = (name) => {
    const re  = new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    return (html.match(re) || html.match(re2) || [])[1] || "";
  };
  const ogTitle = grab("og:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || "";
  const ogDesc  = grab("og:description") || grab("description") || "";
  let image     = ensureAbs(grab("og:image") || grab("twitter:image"));
  if (!image) {
    const m = html.match(/https?:\/\/media\.licdn\.com\/[^"' >]+/i);
    if (m) image = m[0];
  }
  // Nom du profil : pattern "Name on LinkedIn"
  let profileName = "";
  const titleLike = ogTitle || (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || "";
  const m1 = titleLike.match(/^(.+?) on LinkedIn/i);
  if (m1) profileName = m1[1].trim();

  // Date (si exposée en microdata/jsonld)
  const date =
    (html.match(/datetime="(2025-[^"]+)"/i) || [])[1] ||
    (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"publishedAt"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] || "";

  // Texte du post: on prend la description OG par défaut
  const postText = ogDesc;

  return { ogTitle, ogDesc, image, profileName, date, postText };
}

/* ---------- SERP Puppeteer (Google) ---------- */
function buildGoogleUrl(query, start=0) {
  const tbs = `cdr:1,cd_min:1/1/${YEAR},cd_max:12/31/${YEAR}`;
  const params = new URLSearchParams({
    q: query,
    hl: "en",
    pws: "0",
    num: String(RESULTS_PER_PAGE),
    tbs
  });
  if (start > 0) params.set("start", String(start));
  return `https://www.google.com/search?${params.toString()}`;
}
async function acceptGoogleConsent(page) {
  // place un cookie CONSENT et force NCR
  await page.setCookie({
    name: "CONSENT",
    value: "YES+cb.20210328-17-p0.en+FX+123",
    domain: ".google.com",
    path: "/"
  });
  await page.goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(()=>{});
}
async function extractLinkedInLinksFromSERP(page) {
  const links = await page.evaluate(() => {
    const out = new Set();
    const as = document.querySelectorAll('a[href^="http"], a[href^="/url?q="]');
    for (const a of as) {
      let href = a.getAttribute("href") || "";
      if (href.startsWith("/url?q=")) {
        try {
          const u = new URL(href, location.origin);
          const real = u.searchParams.get("q");
          if (real) href = real;
        } catch {}
      }
      if (!href) continue;
      if (href.includes("linkedin.com") &&
          (/\/feed\/update\/|\/posts\/|activity\/|ugcPost\/|share\/|update\//i.test(href) ||
           /urn%3Ali%3A(ugcPost|activity)%3A/i.test(href))) {
        out.add(href.split("#")[0]);
      }
    }
    return Array.from(out);
  });
  return links.filter(looksLinkedInPost);
}

/* ---------- Main ---------- */
(async () => {
  console.time("linkedin-puppeteer-v19.1");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--lang=en-US,en"]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 900 });
    await acceptGoogleConsent(page);

    // 1) Découverte SERP
    const found = new Set();
    for (const q of QUERIES) {
      for (let p=0; p<MAX_PAGES_PER_QUERY; p++) {
        const start = p * RESULTS_PER_PAGE;
        const url = buildGoogleUrl(q, start);
        console.log(`[SERP] ${q} (start=${start})`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
        const links = await extractLinkedInLinksFromSERP(page);
        links.forEach(u => found.add(u));
        await sleep(PAUSE_MS);
      }
    }
    await page.close().catch(()=>{});

    const candidates = Array.from(found);
    console.log(`[INFO] SERP: ${candidates.length} URL(s) candidates.`);
    candidates.forEach((u, i) => console.log(`CANDIDATE[${String(i+1).padStart(2,"0")}]: ${u}`));

    // 2) Filtre: garder uniquement les URLs contenant "clearecon"
    const filteredByUrl = candidates.filter(u => /clearecon/i.test(u));
    console.log(`[INFO] URL filter (contains "clearecon"): kept ${filteredByUrl.length}/${candidates.length}`);
    filteredByUrl.forEach((u, i) => console.log(`KEEP[${String(i+1).padStart(2,"0")}]: ${u}`));

    // 3) Hydratation via r.jina.ai + génération
    const keptItems = [];
    let created=0, updated=0, unchanged=0;

    for (const url of filteredByUrl) {
      try {
        const html = await getStaticHTML(url);
        if (!html) continue;

        const meta = extractMeta(html);

        // si la date est dispo et n'est pas 2025, on skip
        if (meta.date && !String(meta.date).startsWith(String(YEAR))) continue;

        const titleBase = meta.postText || meta.ogTitle || "(Sans titre)";
        const title = (meta.profileName ? `${meta.profileName} — ` : "") + titleBase.slice(0, 120);

        const item = {
          title,
          date: meta.date || brandNewDateISO(),
          url,
          profileName: meta.profileName || "",
          postText: meta.postText || meta.ogDesc || "",
          summary: meta.ogDesc || "",
          image: meta.image || `https://unavatar.io/host/linkedin.com`
        };

        const fp = mdPath(item);
        const existed = fs.existsSync(fp);
        const changed = writeIfChanged(fp, toMarkdown(item));
        if (!existed && changed) created++;
        else if (existed && changed) updated++;
        else unchanged++;

        keptItems.push(item);
        await sleep(200);
      } catch (e) {
        console.log(`[DEBUG] process error ${url}: ${e.message}`);
      }
    }

    // 4) Tri par date DESC + logs avec miniature
    keptItems.sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    console.log(`[INFO] Kept posts sorted by date (${keptItems.length}):`);
    keptItems.forEach((it, idx) => {
      console.log(`POST[${String(idx+1).padStart(2,"0")}] ${new Date(it.date).toISOString()} | ${it.title} | ${it.url} | thumb=${it.image}`);
    });

    console.log(`[INFO] Résultat — conservés: ${keptItems.length}, créés: ${created}, maj: ${updated}, inchangés: ${unchanged}`);
  } catch (e) {
    console.error("[ERROR] Fatal:", e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(()=>{});
    console.timeEnd("linkedin-puppeteer-v19.1");
  }
})();
