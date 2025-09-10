// scripts/generate-linkedin-clearecondl.js
// v8 — LinkedIn (toute l'année 2025) SANS API
// Moteurs HTML via r.jina.ai :
//   - Google avec filtre de dates 2025 (tbs=cdr:1,cd_min,cd_max)
//   - Bing (fallback) avec "2025" dans la requête
//   - Yahoo (fallback) avec "2025" + age=1y
//   - DuckDuckGo (fallback) avec "2025" + df=y
// On retient uniquement les URL "post-like" LinkedIn + on extrait titre/desc + image (post si dispo, sinon avatar).
// Écrit des .md dans src/content/li-clearecondl

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";

const OUT_DIR = path.join("src", "content", "li-clearecondl");
const UA = "Mozilla/5.0 (compatible; clearecondl-bot/1.0; +https://example.org)";
const TIMEOUT = 15000;
const RETRIES = 1;

const QUERY_VARIANTS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  '"CleaReconDL"',
  "clearecon dl",
  "clearecondl",
  "clearecon",
];

// Ajoute des variantes explicitement marquées 2025 pour les moteurs qui n'ont pas de filtre strict
const QUERY_2025 = QUERY_VARIANTS.map(q => `${q} 2025`);

// Pagination raisonnable
const GOOGLE_STARTS = [0, 10, 20, 30, 40, 50, 60];
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
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter).map(([k,v]) =>
    Array.isArray(v) ? `${k}: [${v.map(x=>`"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`
  ).join("\n") + "\n";
}
const JINA = (u) => `https://r.jina.ai/http://${u.replace(/^https?:\/\//, "")}`;
const UNAVATAR_LINKEDIN = (handle) => `https://unavatar.io/linkedin/${encodeURIComponent(handle)}`;
const UNAVATAR_GENERIC  = (link) => `https://unavatar.io/${encodeURIComponent(link)}`;

const LI_POST_RE =
  /(https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:(?:feed\/update\/urn:li:(?:activity|ugcPost|share):[0-9A-Za-z_-]+)|(?:posts\/[^\s"')<>]+)))/gi;

function isLikelyPost(u) {
  try {
    const url = new URL(u);
    const p = url.pathname.toLowerCase();
    if (p.includes("/feed/update/urn:li:activity:") || p.includes("/feed/update/urn:li:ugcpost:") || p.includes("/feed/update/urn:li:share:")) return true;
    if (p.startsWith("/posts/")) return true; // LinkedIn redirigera vers l'URN, mais on garde
    return false;
  } catch { return false; }
}

function pick(re, html){ return html.match(re)?.[1] || ""; }
function absolutize(u, base) { try { return new URL(u, base).href; } catch { return ""; } }

function linkedInHandleFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean);
    const ii = seg.indexOf("in");      // /in/<handle>/
    if (ii >= 0 && seg[ii+1]) return seg[ii+1];
    const ci = seg.indexOf("company"); // /company/<handle>/
    if (ci >= 0 && seg[ci+1]) return seg[ci+1];
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

function looksRelevant(text="") {
  const t = text.toLowerCase();
  return /\bclearecon\s*dl\b/.test(t) || /\bclearecondl\b/.test(t) || /\bclearecon\b/.test(t);
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
    // Filtre sémantique (sécurité en cas de fallback sans filtre de dates)
    if (!(looksRelevant(title) || looksRelevant(desc))) return { title:"", desc:"", image:"", irrelevant:true };
    const img = extractLinkedInImage(html, url);
    if (img) return { title, desc, image: img };
    const handle = linkedInHandleFromUrl(url);
    return { title, desc, image: handle ? UNAVATAR_LINKEDIN(handle) : UNAVATAR_GENERIC(url) };
  } catch {
    const handle = linkedInHandleFromUrl(url);
    return { title:"Post LinkedIn", desc:"", image: handle ? UNAVATAR_LINKEDIN(handle) : UNAVATAR_GENERIC(url) };
  }
}

function readExisting(){
  const set=new Set();
  if(!fs.existsSync(OUT_DIR)) return set;
  for(const f of fs.readdirSync(OUT_DIR)){
    if(!f.endsWith(".md")) continue;
    const txt = fs.readFileSync(path.join(OUT_DIR,f), "utf-8");
    const m = txt.match(/sourceUrl:\s*"([^"]+)"/);
    if(m) set.add(m[1]); // on garde la query pour différencier les URN
  }
  return set;
}

function writeItem(link, meta){
  ensureDir(OUT_DIR);
  const d=new Date();
  const yyyy=d.getUTCFullYear(), mm=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
  const base = `${yyyy}-${mm}-${dd}-${slugify(meta.title || "post", { lower:true, strict:true }).slice(0,80)}`;
  const file = path.join(OUT_DIR, `${base}.md`);
  const fm = {
    title: meta.title || "Post LinkedIn",
    date: d.toISOString(),
    publishedDate: d.toLocaleDateString("fr-FR", { year:"numeric", month:"long", day:"numeric" }),
    summary: meta.desc || meta.title || "Publication LinkedIn",
    sourceUrl: link, // garde la query pour différencier les posts
    permalink: `/li-clearecondl/${base}`,
    tags: ["LinkedIn", "CleaReconDL", "2025"],
    imageUrl: meta.image || UNAVATAR_GENERIC(link),
    imageCredit: meta.image ? `Image — ${link}` : "",
  };
  const body = (fm.imageUrl ? `![${fm.title}](${fm.imageUrl})\n\n` : "") +
               `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${link}\n`;
  fs.writeFileSync(file, `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
}

/* ---------- Collecte 2025 ---------- */
// Google — Filtre 2025 strict
function GOOGLE_Q_2025(q, start=0){
  const min = "01/01/2025"; const max = "12/31/2025";
  return `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&hl=fr&num=10&start=${start}&tbs=cdr:1,cd_min:${min},cd_max:${max}`;
}
async function collectGoogle2025() {
  const all = new Set(); let pages=0;
  for (const q of QUERY_VARIANTS) {
    for (const start of GOOGLE_STARTS) {
      const url = JINA(GOOGLE_Q_2025(q, start));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        for (const m of text.matchAll(/https?:\/\/www\.google\.[^/\s]+\/url\?q=([^&\s]+)/gi)){
          try{ const u = decodeURIComponent(m[1]); if (isLikelyPost(u)) all.add(u); }catch{}
        }
        pages++;
      } catch {}
      await sleep(160);
    }
  }
  console.log(`[LI] Google 2025 pages=${pages} → ${all.size} liens`);
  return [...all];
}

// Bing — pas de plage custom fiable → on force "2025" dans la requête
function BING_Q_2025(q, first=1){
  return `https://www.bing.com/search?q=${encodeURIComponent(`site:linkedin.com (${q} 2025)`)}&setlang=fr&count=50&first=${first}`;
}
async function collectBing2025() {
  const all = new Set(); let pages=0;
  for (const q of QUERY_VARIANTS) {
    for (const first of BING_FIRSTS) {
      const url = JINA(BING_Q_2025(q, first));
      try{
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        for (const m of text.matchAll(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/[^\s"'<>]+/gi)){
          const u = m[0]; if (isLikelyPost(u)) all.add(u);
        }
        pages++;
      }catch{}
      await sleep(160);
    }
  }
  console.log(`[LI] Bing 2025 pages=${pages} → ${all.size} liens`);
  return [...all];
}

// Yahoo — age=1y + "2025" dans la requête (renforce)
function YAHOO_Q_2025(q, b=1){
  return `https://search.yahoo.com/search?p=${encodeURIComponent(`site:linkedin.com ${q} 2025`)}&b=${b}&fr2=time&age=1y`;
}
async function collectYahoo2025() {
  const all = new Set(); let pages=0;
  for (const q of QUERY_VARIANTS) {
    for (const b of YAHOO_BS) {
      const url = JINA(YAHOO_Q_2025(q, b));
      try{
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        pages++;
      }catch{}
      await sleep(160);
    }
  }
  console.log(`[LI] Yahoo 2025 pages=${pages} → ${all.size} liens`);
  return [...all];
}

// DuckDuckGo — df=y + "2025"
function DDG_Q_2025(q, s=0){
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:linkedin.com ${q} 2025`)}&s=${s}&df=y`;
}
async function collectDDG2025() {
  const all = new Set(); let pages=0;
  for (const q of QUERY_VARIANTS) {
    for (const s of DDG_STARTS) {
      const url = JINA(DDG_Q_2025(q, s));
      try{
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) continue;
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
        pages++;
      }catch{}
      await sleep(160);
    }
  }
  console.log(`[LI] DDG 2025 pages=${pages} → ${all.size} liens`);
  return [...all];
}

/* ---------- MAIN ---------- */
async function main(){
  ensureDir(OUT_DIR);

  const batches = await Promise.allSettled([
    collectGoogle2025(),
    collectBing2025(),
    collectYahoo2025(),
    collectDDG2025(),
  ]);

  const links = new Set();
  for (const b of batches) {
    if (b.status === "fulfilled" && Array.isArray(b.value)) {
      for (const u of b.value) if (isLikelyPost(u)) links.add(u);
    }
  }

  const allLinks = [...links];
  console.log(`[LI] Fusion 2025 uniques: ${allLinks.length}`);

  if (!allLinks.length) {
    console.log("[LI] Aucun lien ce run (throttling probable).");
    return;
  }

  const existing = readExisting(); // garde la query entière pour mieux différencier
  const seen = new Set();
  let created = 0, skippedIrrelevant = 0;

  for (const link of allLinks) {
    if (seen.has(link) || existing.has(link)) continue;
    seen.add(link);

    const meta = await fetchOgMetaLinkedIn(link);
    if (meta.irrelevant) { skippedIrrelevant++; continue; }
    writeItem(link, meta);
    created++;
  }

  console.log(`✅ LinkedIn 2025 CleaReconDL: ${created} nouveau(x) fichier(s) → ${OUT_DIR}`);
  if (skippedIrrelevant) console.log(`ℹ️ Posts ignorés (non pertinents): ${skippedIrrelevant}`);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
