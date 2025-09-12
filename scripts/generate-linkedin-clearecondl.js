// scripts/generate-linkedin-clearecondl.js
// v18 — Découverte via Google (Puppeteer) → Extraction via r.jina.ai → .md
// Usage local/CI : node scripts/generate-linkedin-clearecondl.js
// (En CI GitHub Actions : Chrome headless avec --no-sandbox)
//
// Prérequis : npm i puppeteer

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
const KEY_TERMS = [
  "#clearecondl",
  "CleaRecon DL",
  "CleaReconDL",
  "clearecon dl",
  "clearecondl",
  "clearecon"
];

const MAX_PAGES_PER_QUERY = 3;     // nb de pages Google à parcourir / requête
const RESULTS_PER_QUERY    = 50;   // Google "num" (souvent plafonné)
const SERP_PAUSE_MS        = 1200; // delai anti-throttle entre pages
const FETCH_TIMEOUT_MS     = 20000;

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1  = (s) => crypto.createHash("sha1").update(s).digest("hex");
const norm  = (s="") => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/\s+/g," ").trim();

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

function keyFrom(urlStr, urn) {
  if (urn) return urn.toLowerCase();
  try { const u = new URL(urlStr); return (u.origin + u.pathname).toLowerCase(); }
  catch { return (urlStr || "").toLowerCase(); }
}

function mdPath(o) {
  const d = new Date(o.date || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  const slug = (norm(o.title).replace(/[^a-z0-9\- ]/g,"").replace(/\s+/g,"-").slice(0,80)) || sha1(o.url).slice(0,8);
  return path.join(OUT_DIR, `${y}-${m}-${day}-${slug}.md`);
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
    ["source", "google-puppeteer"]
  ].filter(([,v]) => v!==undefined && v!==null && v!=="")
   .map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  const desc = o.postText || o.description || "";
  return `---\n${yaml}\n---\n\n${desc}\n`;
}

function writeIfChanged(fp, content) {
  if (fs.existsSync(fp)) {
    const cur = fs.readFileSync(fp, "utf-8");
    if (sha1(cur) === sha1(content)) return false;
  }
  fs.writeFileSync(fp, content);
  return true;
}

/* ---------- HTTP (extraction post via proxy statique) ---------- */
async function fetchText(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA_DESKTOP } , signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(to); }
}

async function getHTML(rawUrl) {
  // rend une version HTML statique (pas besoin d'être loggé)
  const proxied = rawUrl.replace(/^https?:\/\//, (m) => `https://r.jina.ai/${m}`);
  try {
    const t = await fetchText(proxied);
    return t || "";
  } catch {
    return "";
  }
}

function extractFromHTML(html) {
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
  const updateUrn = (html.match(/urn:li:(?:activity|ugcPost):\d+/i) || [])[0] || "";
  const date =
    (html.match(/datetime="(2025-[^"]+)"/i) || [])[1] ||
    (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] ||
    (html.match(/"publishedAt"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i) || [])[1] || "";

  // Nom du profil (patterns courants “Name on LinkedIn”)
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

/* ---------- Google (Puppeteer) ---------- */
function buildGoogleUrl(query, start=0) {
  // Paramètres pour limiter consent + géo : hl=en, pws=0, num=50, tbs cdr=YEAR
  const tbs = `cdr:1,cd_min:1/1/${YEAR},cd_max:12/31/${YEAR}`;
  const params = new URLSearchParams({
    q: query,
    hl: "en",
    pws: "0",
    num: String(RESULTS_PER_QUERY),
    tbs
  });
  if (start > 0) params.set("start", String(start));
  return `https://www.google.com/search?${params.toString()}`;
}

function looksConsent(html) {
  return /consent/i.test(html) && /Agree|Accept all|J'accepte|Tout accepter/i.test(html);
}

async function acceptGoogleConsent(page) {
  // Essaye différents sélecteurs connus
  const buttons = [
    'button[aria-label="Accept all"]',
    'button[aria-label="Agree to the use of cookies and other data for the purposes described"]',
    'button:has-text("I agree")',
    'button:has-text("Accept all")',
    '#L2AGLb', // bouton “Tout accepter” classique
  ];
  for (const sel of buttons) {
    const el = await page.$(sel);
    if (el) { await el.click().catch(()=>{}); await page.waitForTimeout(800); return; }
  }
}

/* Récupère des liens de posts LI sur une page de résultats Google */
async function extractLinkedInLinksFromPage(page) {
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

async function googleDiscoverLinkedInPosts(browser, query) {
  const urls = new Set();
  const page = await browser.newPage();
  await page.setUserAgent(UA_DESKTOP);
  await page.setViewport({ width: 1200, height: 900 });

  for (let p = 0; p < MAX_PAGES_PER_QUERY; p++) {
    const start = p * RESULTS_PER_QUERY;
    const url = buildGoogleUrl(query, start);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
    // Tente d’accepter le consent si visible
    const html = await page.content();
    if (looksConsent(html)) {
      await acceptGoogleConsent(page);
      await page.waitForTimeout(800);
    }
    const found = await extractLinkedInLinksFromPage(page);
    found.forEach((u) => urls.add(u));
    await sleep(SERP_PAUSE_MS);
  }

  await page.close().catch(()=>{});
  return Array.from(urls);
}

/* ---------- Main ---------- */
(async () => {
  console.time("linkedin-puppeteer");
  const browser = await puppeteer.launch({
    headless: true,                   // CI-friendly
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    // Construit les requêtes Google
    const queries = [];
    KEY_TERMS.forEach(term => {
      queries.push(`${term} site:linkedin.com/posts`);
      queries.push(`${term} site:linkedin.com/feed/update`);
      queries.push(`${term} site:linkedin.com`);
      queries.push(`${term} 2025 site:linkedin.com`);
    });

    // Découverte des URLs de posts
    const all = new Set();
    for (const q of queries) {
      const found = await googleDiscoverLinkedInPosts(browser, q);
      found.forEach(u => all.add(u));
    }
    const candidates = Array.from(all);
    console.log(`[INFO] SERP (Google): ${candidates.length} URL(s) candidates.`);

    // Hydrate + filtre + écrit
    const seen = new Set();
    let created=0, updated=0, kept=0, matched=0;

    for (const url of candidates) {
      try {
        const html = await getHTML(url);
        if (!html) continue;

        // filtre sémantique global
        if (!containsClea(html)) continue;

        const meta = extractFromHTML(html);
        if (!containsClea(`${meta.ogTitle} ${meta.ogDesc} ${meta.postText}`)) continue;

        // bornage année si possible
        if (meta.date && !String(meta.date).startsWith(String(YEAR))) continue;

        const u = new URL(url);
        const item = {
          title: (meta.profileName ? `${meta.profileName} — ` : "") + (meta.postText || meta.ogTitle || "(Sans titre)").slice(0, 120),
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
      } catch (e) {
        console.log(`[DEBUG] process error ${url}: ${e.message}`);
      }
    }

    console.log(`[INFO] Résultat — pertinents: ${matched}, créés: ${created}, maj: ${updated}, inchangés: ${kept}`);
  } catch (e) {
    console.error("[ERROR] Fatal:", e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(()=>{});
    console.timeEnd("linkedin-puppeteer");
  }
})();
