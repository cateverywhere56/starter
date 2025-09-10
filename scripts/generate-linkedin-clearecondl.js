// scripts/generate-linkedin-clearecondl.js
// v7.4 (no-API, robuste) — LinkedIn (30 derniers jours si possible)
// Moteurs HTML via r.jina.ai : Google (tbs=qdr:m), Bing (qft age-lt1month), Yahoo (age=1m), DuckDuckGo (df=m)
// Si 0 résultat, fallback SANS filtre de temps (toujours filtré côté nôtre par pertinence).
// On ne retient que les liens LinkedIn "post-like" ET dont (title+desc) contiennent "clearecon" (avec/sans espace) et/ou "clearecondl".
// Image garantie : og:image / media.licdn.com sinon avatar (unavatar.io).

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
  // variantes tolérantes pour augmenter le rappel
  "clearecon dl",
  "clearecondl",
  "clearecon",
];

const GOOGLE_STARTS = [0, 10, 20, 30, 40];
const BING_FIRSTS   = [1, 51, 101, 151, 201];
const YAHOO_BS      = [1, 11, 21, 31, 41];
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

/* ---------- Pertinence contenu ---------- */
function looksRelevant(text="") {
  const t = text.toLowerCase();
  // tolère "clearecon dl", "clearecondl", "clearecon" simple
  return /\bclearecon\s*dl\b/.test(t) || /\bclearecondl\b/.test(t) || /\bclearecon\b/.test(t);
}

/* ---------- Extraction image (post OU avatar) ---------- */
function pick(re, html){ return html.match(re)?.[1] || ""; }
function absolutize(u, base) { try { return new URL(u, base).href; } catch { return ""; } }

function linkedInHandleFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean);
    const ci = seg.indexOf("company");
    if (ci >= 0 && seg[ci+1]) return seg[ci+1];
    const ii = seg.indexOf("in");
    if (ii >= 0 && seg[ii+1]) return seg[ii+1];
    if (seg[0] === "posts" && seg[1]) return seg[1].split("-").slice(0,2).join("");
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

    // Filtre sémantique ici (évite les faux positifs des SERP)
    if (!(looksRelevant(title) || looksRelevant(desc))) {
      return { title:"", desc:"", image:"", irrelevant:true };
    }

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
  const d=new Date(); // date d'indexation (SERP déjà ~30j)
  const yyyy=d.getUTCFullYear(), mm=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
  const base = `${yyyy}-${mm}-${dd}-${slugify(meta.title || "post", { lower:true, strict:true }).slice(0,80)}`;
  const file = path.join(OUT_DIR, `${base}.md`);

  const imageFinal = meta.image || UNAVATAR_GENERIC(link);
  const fm = {
    title: meta.title || "Post LinkedIn",
    date: d.toISOString(),
    publishedDate: d.toLocaleDateString("fr-FR", { year:"numeric", month:"long", day:"numeric" }),
    summary: meta.desc || meta.title || "Publication LinkedIn",
    sourceUrl: link,
    permalink: `/li-clearecondl/${base}`,
    tags: ["LinkedIn", "CleaReconDL"],
    imageUrl: imageFinal,
    imageCredit: imageFinal ? `Image — ${link}` : "",
  };
  const body = (fm.imageUrl ? `![${fm.title}](${fm.imageUrl})\n\n` : "") +
               `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${link}\n`;
  ensureDir(OUT_DIR);
  fs.writeFileSync(file, `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
}

/* ---------- Collecteurs HTML (30 jours) ---------- */
// Google (tbs=qdr:m)
const GOOGLE_Q = (q, start=0) =>
  `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&hl=fr&num=10&start=${start}&tbs=qdr:m`;
// Google (fallback sans filtre)
const GOOGLE_Q_ALL = (q, start=0) =>
  `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&hl=fr&num=10&start=${start}`;

async function collectGoogle({withTime=true}={}) {
  const all = new Set(); let pages=0;
  for (const q of QUERY_VARIANTS) {
    for (const start of GOOGLE_STARTS) {
      const url = JINA((withTime ? GOOGLE_Q : GOOGLE_Q_ALL)(q, start));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        for (const m of text.matchAll(/https?:\/\/www\.google\.[^/\s]+\/url\?q=([^&\s]+)/gi)) {
          try { const u = decodeURIComponent(m[1]); if (isLikelyPost(u)) all.add(u); } catch {}
        }
        pages++;
      } catch {}
      await sleep(180);
    }
  }
  console.log(`[LI] Google ${withTime?'30j':'(no time)'} pages=${pages} → ${all.size} liens`);
  return [...all];
}

// Bing (qft=+filterui:age-lt1month) / fallback sans qft
const BING_Q = (q, first=1) =>
  `https://www.bing.com/search?q=${encodeURIComponent(`site:linkedin.com (${q})`)}&setlang=fr&count=50&first=${first}&qft=%2Bfilterui%3Aage-lt1month`;
const BING_Q_ALL = (q, first=1) =>
  `https://www.bing.com/search?q=${encodeURIComponent(`site:linkedin.com (${q})`)}&setlang=fr&count=50&first=${first}`;

async function collectBing({withTime=true}={}) {
  const all = new Set(); let pages=0;
  for (const q of QUERY_VARIANTS) {
    for (const first of BING_FIRSTS) {
      const url = JINA((withTime ? BING_Q : BING_Q_ALL)(q, first));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        for (const m of text.matchAll(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/[^\s"'<>]+/gi)) {
          const u = m[0]; if (isLikelyPost(u)) all.add(u);
        }
        pages++;
      } catch {}
      await sleep(180);
    }
  }
  console.log(`[LI] Bing ${withTime?'30j':'(no time)'} pages=${pages} → ${all.size} liens`);
  return [...all];
}

// Yahoo (fr2=time&age=1m) / fallback
const YAHOO_Q = (q, b=1) =>
  `https://search.yahoo.com/search?p=${encodeURIComponent(`site:linkedin.com ${q}`)}&b=${b}&fr2=time&age=1m`;
const YAHOO_Q_ALL = (q, b=1) =>
  `https://search.yahoo.com/search?p=${encodeURIComponent(`site:linkedin.com ${q}`)}&b=${b}`;

async function collectYahoo({withTime=true}={}) {
  const all = new Set(); let pages=0;
  for (const q of QUERY_VARIANTS) {
    for (const b of YAHOO_BS) {
      const url = JINA((withTime ? YAHOO_Q : YAHOO_Q_ALL)(q, b));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        pages++;
      } catch {}
      await sleep(180);
    }
  }
  console.log(`[LI] Yahoo ${withTime?'30j':'(no time)'} pages=${pages} → ${all.size} liens`);
  return [...all];
}

// DuckDuckGo (df=m) / fallback
const DDG_Q = (q, s=0) =>
  `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&s=${s}&df=m`;
const DDG_Q_ALL = (q, s=0) =>
  `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&s=${s}`;

async function collectDDG({withTime=true}={}) {
  const all = new Set(); let pages=0;
  for (const q of QUERY_VARIANTS) {
    for (const s of DDG_STARTS) {
      const url = JINA((withTime ? DDG_Q : DDG_Q_ALL)(q, s));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        pages++;
      } catch {}
      await sleep(180);
    }
  }
  console.log(`[LI] DDG ${withTime?'30j':'(no time)'} pages=${pages} → ${all.size} liens`);
  return [...all];
}

/* ---------- MAIN ---------- */
async function main(){
  ensureDir(OUT_DIR);

  // 1) Essai avec filtres "dernier mois"
  const batches30 = await Promise.allSettled([
    collectGoogle({withTime:true}),
    collectBing({withTime:true}),
    collectYahoo({withTime:true}),
    collectDDG({withTime:true}),
  ]);

  const linksSet = new Set();
  const addAll = (arr) => Array.isArray(arr) && arr.forEach(u => { if (isLikelyPost(u)) linksSet.add(u); });

  let total30 = 0;
  for (const b of batches30) {
    if (b.status === "fulfilled") { addAll(b.value); total30 += (b.value?.length || 0); }
  }
  console.log(`[LI] Fusion 30j uniques: ${linksSet.size} (bruts: ${total30})`);

  // 2) Si rien → fallback sans filtre de temps (pour casser un throttling trop agressif)
  if (linksSet.size === 0) {
    const batchesAll = await Promise.allSettled([
      collectGoogle({withTime:false}),
      collectBing({withTime:false}),
      collectYahoo({withTime:false}),
      collectDDG({withTime:false}),
    ]);
    let totalAll = 0;
    for (const b of batchesAll) {
      if (b.status === "fulfilled") { addAll(b.value); totalAll += (b.value?.length || 0); }
    }
    console.log(`[LI] Fusion fallback uniques: ${linksSet.size} (bruts: ${totalAll})`);
  }

  const allLinks = [...linksSet];
  console.log(`[LI] Liens LinkedIn collectés (après fusion): ${allLinks.length}`);
  if (!allLinks.length) {
    console.log("[LI] Aucun lien ce run (throttling probable).");
    return;
  }

  const existing = readExisting();
  const seen = new Set();
  let created = 0, skippedIrrelevant = 0;

  for (const link of allLinks) {
    const key = normalizeUrl(link);
    if (seen.has(key) || existing.has(key)) continue;
    seen.add(key);

    const meta = await fetchOgMetaLinkedIn(link);
    if (meta.irrelevant) { skippedIrrelevant++; continue; }

    writeItem(link, meta);
    created++;
  }

  console.log(`✅ LinkedIn CleaReconDL: ${created} fichier(s) nouvellement généré(s) → ${OUT_DIR}`);
  if (skippedIrrelevant) console.log(`ℹ️  Posts ignorés (non pertinents après lecture OG): ${skippedIrrelevant}`);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
