// scripts/generate-linkedin-clearecondl.js
// v7 (no-API) — LinkedIn (30 derniers jours) : #cleareconDL | "CleaRecon DL" | "CleaReconDL"
// Sources HTML via proxy r.jina.ai : Google (tbs=qdr:m), Bing (qft age-lt1month), Yahoo (age=1m), DuckDuckGo (df=m)
// Écrit .md dans src/content/li-clearecondl avec vignette (image du post OU avatar du profil/page).

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";

const OUT_DIR = path.join("src", "content", "li-clearecondl");
const UA = "Mozilla/5.0 (compatible; clearecondl-bot/1.0; +https://example.org)";
const TIMEOUT = 15000;
const RETRIES = 1;

/* ---------- Requêtes ---------- */
const QUERY_VARIANTS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  '"CleaReconDL"',
];

// On reste raisonnable (anti-429) mais on balaie plusieurs pages
const GOOGLE_STARTS = [0, 10, 20, 30, 40];
const BING_FIRSTS   = [1, 51, 101, 151, 201];   // count=50
const YAHOO_BS      = [1, 11, 21, 31, 41];      // 1-based
const DDG_STARTS    = [0, 50, 100, 150, 200];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function timedFetch(url, opts = {}, retries = RETRIES) {
  for (let i = 0; ; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...opts,
        headers: { "User-Agent": UA, "Accept-Language": "fr,fr-FR;q=0.9,en;q=0.8", ...(opts.headers || {}) },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return res;
    } catch (e) {
      clearTimeout(t);
      if (i >= retries) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

/* ---------- Utils ---------- */
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function clean(s=""){ return String(s).replace(/\s+/g," ").trim(); }
function normalizeUrl(u){ try{ const x=new URL(u); return (x.origin+x.pathname).replace(/\/+$/,"").toLowerCase(); } catch{ return String(u||"").toLowerCase(); } }
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter).map(([k,v]) =>
    Array.isArray(v) ? `${k}: [${v.map(x=>`"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`
  ).join("\n") + "\n";
}
const JINA = (u) => `https://r.jina.ai/http://${u.replace(/^https?:\/\//, "")}`;
const UNAVATAR_LINKEDIN = (handle) => `https://unavatar.io/linkedin/${encodeURIComponent(handle)}`;
const UNAVATAR_GENERIC  = (link) => `https://unavatar.io/${encodeURIComponent(link)}`;

/* ---------- Reconnaissance d'URL LinkedIn (posts) ---------- */
const LI_POST_RE =
  /(https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:(?:company\/[^/]+\/posts\/[^\s"')<>]+)|(?:posts\/[^\s"')<>]+)|(?:feed\/update\/urn:li:(?:activity|ugcPost|share):[0-9A-Za-z_-]+)))/gi;

function isLikelyPost(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return p.startsWith("/posts/") ||
      p.includes("/feed/update/urn:li:activity:") ||
      p.includes("/feed/update/urn:li:ugcpost:") ||
      p.includes("/feed/update/urn:li:share:") ||
      /\/company\/[^/]+\/posts\//.test(p);
  } catch { return false; }
}

/* ---------- Extraction image (post OU avatar) ---------- */
function pick(re, html){ return html.match(re)?.[1] || ""; }
function absolutize(u, base) { try { return new URL(u, base).href; } catch { return ""; } }

function linkedInHandleFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean);
    // /company/<handle>/posts/...
    const ci = seg.indexOf("company");
    if (ci >= 0 && seg[ci+1]) return seg[ci+1];
    // /in/<handle>/...
    const ii = seg.indexOf("in");
    if (ii >= 0 && seg[ii+1]) return seg[ii+1];
    // /posts/<name-slug>... (souvent "prenom-nom-..."), tente
    if (seg[0] === "posts" && seg[1]) return seg[1].split("-").slice(0,2).join(""); // best-effort
  } catch {}
  return null;
}

function extractLinkedInImage(html, baseUrl) {
  const og = pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i, html);
  const tw = pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i, html);
  const cand = [og, tw].map(u => absolutize(u, baseUrl)).filter(Boolean);
  if (cand.length) return cand[0];
  const m = html.match(/https?:\/\/media\.licdn\.com\/[^\s"'<>]+/i);
  if (m) return m[0];
  return "";
}

async function fetchOgMetaLinkedIn(url) {
  try {
    const res = await timedFetch(JINA(url), { headers: { Accept: "text/html" } });
    if (!res.ok) {
      const handle = linkedInHandleFromUrl(url);
      return { title:"Post LinkedIn", desc:"", image: handle ? UNAVATAR_LINKEDIN(handle) : UNAVATAR_GENERIC(url) };
    }
    const html = await res.text();
    const title = clean(
      pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i, html) ||
      pick(/<meta[^>]+name=["']title["'][^>]*content=["']([^"']+)["']/i, html) ||
      "Post LinkedIn"
    );
    const desc  = clean(
      pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i, html) ||
      pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i, html) || ""
    );
    const imgPost = extractLinkedInImage(html, url);
    if (imgPost) return { title, desc, image: imgPost };
    const handle = linkedInHandleFromUrl(url);
    return { title, desc, image: handle ? UNAVATAR_LINKEDIN(handle) : UNAVATAR_GENERIC(url) };
  } catch {
    const handle = linkedInHandleFromUrl(url);
    return { title:"Post LinkedIn", desc:"", image: handle ? UNAVATAR_LINKEDIN(handle) : UNAVATAR_GENERIC(url) };
  }
}

/* ---------- E/S contenus ---------- */
function readExisting(){
  const set=new Set();
  if(!fs.existsSync(OUT_DIR)) return set;
  for(const f of fs.readdirSync(OUT_DIR)){
    if(!f.endsWith(".md")) continue;
    const txt = fs.readFileSync(path.join(OUT_DIR,f), "utf-8");
    const m = txt.match(/sourceUrl:\s*"([^"]+)"/);
    if(m) set.add(normalizeUrl(m[1]));
  }
  return set;
}

function writeItem(link, meta){
  ensureDir(OUT_DIR);
  const d=new Date(); // date d'indexation (SERP filtrées sur 30j)
  const yyyy=d.getUTCFullYear(), mm=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
  const base = `${yyyy}-${mm}-${dd}-${slugify(meta.title || "post", { lower:true, strict:true }).slice(0,80)}`;
  const file = path.join(OUT_DIR, `${base}.md`);

  const fm = {
    title: meta.title || "Post LinkedIn",
    date: d.toISOString(),
    publishedDate: d.toLocaleDateString("fr-FR", { year:"numeric", month:"long", day:"numeric" }),
    summary: meta.desc || meta.title || "Publication LinkedIn",
    sourceUrl: link,
    permalink: `/li-clearecondl/${base}`,
    tags: ["LinkedIn", "CleaReconDL"],
    imageUrl: meta.image || "",
    imageCredit: meta.image ? `Image — ${link}` : "",
  };
  const body = (fm.imageUrl ? `![${fm.title}](${fm.imageUrl})\n\n` : "") +
               `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${link}\n`;
  fs.writeFileSync(file, `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
}

/* ---------- Collecteurs HTML (30 jours) ---------- */
// Google (tbs=qdr:m)
function GOOGLE_Q(q, start=0){
  return `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&hl=fr&num=10&start=${start}&tbs=qdr:m`;
}
async function collectFromGoogle() {
  const all = new Set();
  for (const q of QUERY_VARIANTS) {
    for (const start of GOOGLE_STARTS) {
      const url = JINA(GOOGLE_Q(q, start));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        // Redirections /url?q=
        for (const m of text.matchAll(/https?:\/\/www\.google\.[^/\s]+\/url\?q=([^&\s]+)/gi)) {
          try { const u = decodeURIComponent(m[1]); if (isLikelyPost(u)) all.add(u); } catch {}
        }
      } catch {}
      await sleep(200);
    }
  }
  return [...all];
}

// Bing (qft=+filterui:age-lt1month)
function BING_Q(q, first=1){
  return `https://www.bing.com/search?q=${encodeURIComponent(`site:linkedin.com (${q})`)}&setlang=fr&count=50&first=${first}&qft=%2Bfilterui%3Aage-lt1month`;
}
async function collectFromBing() {
  const all = new Set();
  for (const q of QUERY_VARIANTS) {
    for (const first of BING_FIRSTS) {
      const url = JINA(BING_Q(q, first));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        for (const m of text.matchAll(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/[^\s"'<>]+/gi)) {
          const u = m[0]; if (isLikelyPost(u)) all.add(u);
        }
      } catch {}
      await sleep(200);
    }
  }
  return [...all];
}

// Yahoo (fr2=time&age=1m)
function YAHOO_Q(q, b=1){
  return `https://search.yahoo.com/search?p=${encodeURIComponent(`site:linkedin.com ${q}`)}&b=${b}&fr2=time&age=1m`;
}
async function collectFromYahoo() {
  const all = new Set();
  for (const q of QUERY_VARIANTS) {
    for (const b of YAHOO_BS) {
      const url = JINA(YAHOO_Q(q, b));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
      } catch {}
      await sleep(200);
    }
  }
  return [...all];
}

// DuckDuckGo (df=m)
function DDG_Q(q, s=0){
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&s=${s}&df=m`;
}
async function collectFromDDG() {
  const all = new Set();
  for (const q of QUERY_VARIANTS) {
    for (const s of DDG_STARTS) {
      const url = JINA(DDG_Q(q, s));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
      } catch {}
      await sleep(200);
    }
  }
  return [...all];
}

/* ---------- MAIN ---------- */
async function main(){
  ensureDir(OUT_DIR);

  // On interroge plusieurs moteurs, puis on fusionne/dédoublonne
  const batches = await Promise.allSettled([
    collectFromGoogle(),
    collectFromBing(),
    collectFromYahoo(),
    collectFromDDG(),
  ]);

  const links = new Set();
  for (const b of batches) {
    if (b.status === "fulfilled" && Array.isArray(b.value)) {
      for (const u of b.value) {
        if (isLikelyPost(u)) links.add(u);
      }
    }
  }

  const allLinks = [...links];
  console.log(`[LI] Liens LinkedIn (30j) collectés: ${allLinks.length}`);

  if (!allLinks.length) {
    console.log("[LI] Aucun lien ce run (ou throttling des moteurs).");
    return;
  }

  const existing = readExisting();
  const seen = new Set();
  let created = 0;

  for (const link of allLinks) {
    const key = normalizeUrl(link);
    if (seen.has(key) || existing.has(key)) continue;
    seen.add(key);

    let meta = await fetchOgMetaLinkedIn(link);
    writeItem(link, meta);
    created++;
  }

  console.log(`✅ LinkedIn (30j) CleaReconDL: ${created} fichier(s) généré(s) → ${OUT_DIR}`);
}

main().catch((e)=>{ console.error(e); process.exit(1); });

