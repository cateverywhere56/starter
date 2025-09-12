// scripts/generate-linkedin-clearecondl.js
// v19 — Puppeteer multi-SERP (Google → Startpage → DDG) + extraction LI via r.jina.ai
// Prérequis CI: une étape "npm i puppeteer@22 --no-save"
// Usage: node scripts/generate-linkedin-clearecondl.js

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
// Profil ciblé demandé
const PROFILE_SLUG = "charles-nutting-do-fsir-5b18b95a";

const MAX_PAGES_PER_QUERY = 4;      // pages SERP max / requête
const RESULTS_PER_PAGE    = 50;     // Google "num"
const SERP_PAUSE_MS       = 1000;   // délai anti throttling
const FETCH_TIMEOUT_MS    = 20000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
    ["source", o.source || "puppeteer-serp"]
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

/* ---------- Extraction post via proxy statique ---------- */
async function fetchText(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(to); }
}
async function getHTML(rawUrl) {
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

  let profileName = "";
  const titleLike = ogTitle || (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || "";
  const m1 = titleLike.match(/^(.+?) on LinkedIn/i);
  if (m1) profileName = m1[1].trim();

  let postText = ogDesc;
  if (!postText) {
    const body = html.replace(/\s+/g, " ");
    const qm = body.match(/“([^”]{20,280})”/);
    if (qm) postText = qm[1];
  }
  return { ogTitle, ogDesc, image, updateUrn, date, profileName, postText };
}

/* ---------- Puppeteer helpers ---------- */
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 900 });
  return page;
}

/* ---------- GOOGLE ---------- */
function buildGoogleUrl(query, start=0, withDate=false) {
  const params = new URLSearchParams({
    q: query,
    hl: "en",
    pws: "0",
    num: String(RESULTS_PER_PAGE),
    filter: "0",
    safe: "off",
    gl: "us" // neutre
  });
  if (withDate) params.set("tbs", `cdr:1,cd_min:1/1/${YEAR},cd_max:12/31/${YEAR}`);
  if (start > 0) params.set("start", String(start));
  return `https://www.google.com/search?${params.toString()}`;
}
async function primeGoogleConsent(page) {
  // Force domaine .google.com et cookie de consent
  await page.setCookie({
    name: "CONSENT",
    value: "YES+cb.20210328-17-p0.en+FX+123",
    domain: ".google.com",
    path: "/",
  });
  await page.goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(()=>{});
}
async function extractGoogleLinks(page) {
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
async function googleDiscover(browser, queries) {
  const urls = new Set();
  const page = await newPage(browser);
  await primeGoogleConsent(page);

  for (const q of queries) {
    for (const withDate of [false, true]) {
      for (let p = 0; p < MAX_PAGES_PER_QUERY; p++) {
        const start = p * RESULTS_PER_PAGE;
        const url = buildGoogleUrl(q, start, withDate);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
        const found = await extractGoogleLinks(page);
        found.forEach(u => urls.add(u));
        await sleep(SERP_PAUSE_MS);
      }
    }
  }
  await page.close().catch(()=>{});
  return Array.from(urls);
}

/* ---------- STARTPAGE ---------- */
function buildStartpageUrl(query, page=1) {
  const params = new URLSearchParams({ query, prio: "web", page: String(page), segment: "startpage.v2" });
  return `https://www.startpage.com/sp/search?${params.toString()}`;
}
async function extractStartpageLinks(page) {
  const links = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll('a.w-gl__result-url, a.w-gl__result-title, a.result-link').forEach(a => {
      const href = a.getAttribute("href") || "";
      if (href) out.add(href);
    });
    return Array.from(out);
  });
  return links.filter(looksLinkedInPost);
}
async function startpageDiscover(browser, queries) {
  const urls = new Set();
  const page = await newPage(browser);
  for (const q of queries) {
    for (let p=1; p<=MAX_PAGES_PER_QUERY; p++) {
      await page.goto(buildStartpageUrl(q, p), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
      const found = await extractStartpageLinks(page);
      found.forEach(u => urls.add(u));
      await sleep(SERP_PAUSE_MS);
    }
  }
  await page.close().catch(()=>{});
  return Array.from(urls);
}

/* ---------- DUCKDUCKGO HTML ---------- */
function buildDDGUrl(query) {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}
async function extractDDGLinks(page) {
  const links = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll('a.result__a').forEach(a => {
      const href = a.getAttribute("href") || "";
      if (href) out.add(href);
    });
    return Array.from(out);
  });
  return links.filter(looksLinkedInPost);
}
async function ddgDiscover(browser, queries) {
  const urls = new Set();
  const page = await newPage(browser);
  for (const q of queries) {
    await page.goto(buildDDGUrl(q), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
    const found = await extractDDGLinks(page);
    found.forEach(u => urls.add(u));
    await sleep(SERP_PAUSE_MS);
  }
  await page.close().catch(()=>{});
  return Array.from(urls);
}

/* ---------- Main ---------- */
(async () => {
  console.time("linkedin-puppeteer-v19");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=en-US,en"]
  });

  try {
    // 1) Construire les requêtes (génériques + ciblage profil)
    const queries = [];
    KEY_TERMS.forEach(term => {
      queries.push(`${term} site:linkedin.com/posts`);
      queries.push(`${term} site:linkedin.com/feed/update`);
      queries.push(`${term} site:linkedin.com`);
      queries.push(`${term} 2025 site:linkedin.com`);
    });
    // Ciblage profil demandé
    KEY_TERMS.forEach(term => {
      queries.push(`${term} site:linkedin.com/posts ${PROFILE_SLUG}`);
      queries.push(`${term} site:linkedin.com/feed/update ${PROFILE_SLUG}`);
      queries.push(`"${term}" "${PROFILE_SLUG}" site:linkedin.com`);
    });

    // 2) Découverte multi-SERP (Google → Startpage → DDG)
    const all = new Set();
    const g = await googleDiscover(browser, queries);
    g.forEach(u => all.add(u));
    if (all.size === 0) {
      const sp = await startpageDiscover(browser, queries);
      sp.forEach(u => all.add(u));
    }
    if (all.size === 0) {
      const d = await ddgDiscover(browser, queries);
      d.forEach(u => all.add(u));
    }

    const candidates = Array.from(all);
    console.log(`[INFO] SERP: ${candidates.length} URL(s) candidates.`);

    // 3) Hydrate + filtre + écrit
    const seen = new Set();
    let created=0, updated=0, kept=0, matched=0;

    for (const url of candidates) {
      try {
        const html = await getHTML(url);
        if (!html) continue;

        if (!containsClea(html)) continue;

        const meta = extractFromHTML(html);
        if (!containsClea(`${meta.ogTitle} ${meta.ogDesc} ${meta.postText}`)) continue;

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
          updateUrn: meta.updateUrn || undefined,
          source: "puppeteer-google-startpage-ddg"
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
        await sleep(250);
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
    console.timeEnd("linkedin-puppeteer-v19");
  }
})();
