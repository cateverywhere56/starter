// scripts/generate-linkedin-clearecondl.js
// v5 — LinkedIn posts contenant : #cleareconDL | "CleaRecon DL" | "CleaReconDL"
// Ordre : 1) Bing API 2) SerpAPI 3) Google HTML 4) Yahoo HTML 5) Fallback Bing/DDG HTML (slow)
// Pagination PERSISTANTE (./src/content/li-clearecondl/.serp-state.json) pour éviter les 429.

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";

const OUT_DIR = path.join("src", "content", "li-clearecondl");
const STATE_FILE = path.join(OUT_DIR, ".serp-state.json");
const UA = "Mozilla/5.0 (compatible; clearecondl-bot/1.0; +https://example.org)";
const TIMEOUT = 15000;
const RETRIES = 1;

/* ----------------- Requêtes ----------------- */
const QUERY_VARIANTS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  '"CleaReconDL"',
];

// Pagination par source (on avance à chaque run)
const BING_OFFSETS   = [0, 50, 100, 150, 200];
const SERPAPI_STARTS = [0, 100, 200, 300];
const GOOGLE_STARTS  = [0, 10, 20, 30, 40];
const YAHOO_BS       = [1, 11, 21, 31, 41]; // Yahoo: param 'b' (1-based)

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

/* ----------------- Utils ----------------- */
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

/* --------- Reconnaissance d'URL LinkedIn (posts) --------- */
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

/* ----------------- State ----------------- */
function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        source: null,
        bing:    Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
        serpapi: Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
        google:  Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
        yahoo:   Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
        fallback: { step: 0 },
      };
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {
      source: null,
      bing:    Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
      serpapi: Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
      google:  Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
      yahoo:   Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
      fallback: { step: 0 },
    };
  }
}
function writeState(s){ ensureDir(OUT_DIR); fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2),"utf-8"); }

/* ----------------- OG via proxy ----------------- */
async function fetchOgMetaLinkedIn(url) {
  try {
    const res = await timedFetch(JINA(url), { headers: { Accept: "text/html" } });
    if (!res.ok) return { title:"", desc:"", image:null };
    const html = await res.text();
    const pick = (re) => html.match(re)?.[1] || "";
    const image = [
      /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
    ].map(re=>pick(re))
     .map(u=>{ try{ return new URL(u,url).href; } catch { return ""; } })
     .find(Boolean) || null;
    const title = pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || "";
    const desc  = pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || "";
    return { title: clean(title), desc: clean(desc), image };
  } catch { return { title:"", desc:"", image:null }; }
}

/* ----------------- E/S contenus ----------------- */
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
  const d=new Date();
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

/* ----------------- 1) Bing Web Search API ----------------- */
async function collectFromBingApi(state){
  const key = process.env.AZURE_BING_KEY;
  if(!key) return null;
  const all = new Set();
  for(const q of QUERY_VARIANTS){
    const idx = state.bing[q] || 0;
    const offset = BING_OFFSETS[idx % BING_OFFSETS.length];
    const params = new URLSearchParams({
      q: `site:linkedin.com (${q})`, mkt:"fr-FR", count:"50", offset:String(offset),
      responseFilter:"Webpages", textFormat:"Raw"
    });
    const url = `https://api.bing.microsoft.com/v7.0/search?${params.toString()}`;
    const res = await timedFetch(url, { headers: { "Ocp-Apim-Subscription-Key": key } });
    if(!res.ok){ console.error(`[LI] Bing API ${res.status} offset=${offset} q=${q}`); continue; }
    const data = await res.json();
    const items = data?.webPages?.value || [];
    for(const it of items){
      const u = it.url;
      if (typeof u === "string" && isLikelyPost(u)) all.add(u);
      const sn = `${it.snippet || ""} ${it.name || ""}`;
      for (const m of sn.matchAll(LI_POST_RE)) all.add(m[1]);
    }
    state.bing[q] = (idx + 1) % BING_OFFSETS.length;
    await sleep(300);
  }
  state.source = "bing";
  return [...all];
}

/* ----------------- 2) SerpAPI (Google) ----------------- */
async function collectFromSerpApi(state){
  const key = process.env.SERPAPI_KEY;
  if(!key) return null;
  const all = new Set();
  for(const q of QUERY_VARIANTS){
    const idx = state.serpapi[q] || 0;
    const start = SERPAPI_STARTS[idx % SERPAPI_STARTS.length];
    const params = new URLSearchParams({
      engine:"google", q:`site:linkedin.com ${q}`, hl:"fr", gl:"fr", num:"100", start:String(start), api_key:key
    });
    const url = `https://serpapi.com/search.json?${params.toString()}`;
    const res = await timedFetch(url);
    if(!res.ok){ console.error(`[LI] SerpAPI ${res.status} start=${start} q=${q}`); continue; }
    const data = await res.json();
    for(const r of data?.organic_results || []){
      const u = r.link;
      if(typeof u === "string" && isLikelyPost(u)) all.add(u);
      const text = [r.snippet, r.title].filter(Boolean).join(" ");
      for(const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
    }
    state.serpapi[q] = (idx + 1) % SERPAPI_STARTS.length;
    await sleep(300);
  }
  state.source = "serpapi";
  return [...all];
}

/* ----------------- 3) Google HTML (via r.jina.ai) ----------------- */
function GOOGLE_Q(q, start=0){
  return `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&hl=fr&num=10&start=${start}`;
}
function extractGoogleUrls(txt){
  const out = new Set();
  // Liens directs linkedin
  for(const m of txt.matchAll(LI_POST_RE)) out.add(m[1]);
  // Liens google redirect (/url?q=...)
  for(const m of txt.matchAll(/https?:\/\/www\.google\.[^/\s]+\/url\?q=([^&\s]+)/gi)){
    try{
      const u = decodeURIComponent(m[1]);
      if(isLikelyPost(u)) out.add(u);
    }catch{}
  }
  return [...out];
}
async function collectFromGoogleHtml(state){
  const all = new Set();
  for(const q of QUERY_VARIANTS){
    const idx = state.google[q] || 0;
    const start = GOOGLE_STARTS[idx % GOOGLE_STARTS.length];
    const prox = JINA(GOOGLE_Q(q, start));
    try{
      const res = await timedFetch(prox, { headers: { Accept: "text/plain" } });
      if(!res.ok){ console.error(`[LI] Google HTML ${res.status} start=${start} q=${q}`); continue; }
      const text = await res.text();
      extractGoogleUrls(text).forEach(u => all.add(u));
    }catch(e){ console.error("[LI] Google HTML error:", String(e).slice(0,160)); }
    state.google[q] = (idx + 1) % GOOGLE_STARTS.length;
    await sleep(500);
  }
  state.source = "google-html";
  return [...all];
}

/* ----------------- 4) Yahoo HTML (via r.jina.ai) ----------------- */
function YAHOO_Q(q, b=1){
  return `https://search.yahoo.com/search?p=${encodeURIComponent(`site:linkedin.com ${q}`)}&b=${b}`;
}
async function collectFromYahooHtml(state){
  const all = new Set();
  for(const q of QUERY_VARIANTS){
    const idx = state.yahoo[q] || 0;
    const b = YAHOO_BS[idx % YAHOO_BS.length];
    const prox = JINA(YAHOO_Q(q, b));
    try{
      const res = await timedFetch(prox, { headers: { Accept: "text/plain" } });
      if(!res.ok){ console.error(`[LI] Yahoo HTML ${res.status} b=${b} q=${q}`); continue; }
      const text = await res.text();
      for(const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
    }catch(e){ console.error("[LI] Yahoo HTML error:", String(e).slice(0,160)); }
    state.yahoo[q] = (idx + 1) % YAHOO_BS.length;
    await sleep(500);
  }
  state.source = "yahoo-html";
  return [...all];
}

/* ----------------- 5) Fallback Bing/DDG HTML (lent) ----------------- */
const BING_HTML = (q, first=1) => `https://www.bing.com/search?q=${encodeURIComponent(`site:linkedin.com (${q})`)}&setlang=fr&count=50&first=${first}`;
const DDG_HTML  = (q, s=0)       => `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&s=${s}`;
async function collectFromFallback(state){
  const step = state.fallback.step || 0;
  const pages = [
    ...QUERY_VARIANTS.map((q,i)=>({ type:"bing", q, first: BING_OFFSETS[(step+i)%BING_OFFSETS.length] || 1 })),
    ...QUERY_VARIANTS.map((q,i)=>({ type:"ddg",  q, s:     SERPAPI_STARTS[(step+i)%SERPAPI_STARTS.length] || 0 })),
  ];
  const all = new Set();
  for(const p of pages){
    const url = p.type === "bing" ? BING_HTML(p.q, p.first) : DDG_HTML(p.q, p.s);
    const prox = JINA(url);
    try{
      const res = await timedFetch(prox, { headers: { Accept: "text/plain" } });
      if(!res.ok){ console.error(`[LI] Fallback ${p.type} ${res.status} q=${p.q}`); continue; }
      const text = await res.text();
      for(const m of text.matchAll(LI_POST_RE)) all.add(m[1]);
    }catch(e){ console.error("[LI] Fallback error:", String(e).slice(0,160)); }
    await sleep(400);
  }
  state.fallback.step = (step + 1) % 8;
  state.source = "fallback";
  return [...all];
}

/* ----------------- MAIN ----------------- */
async function main(){
  ensureDir(OUT_DIR);
  const state = readState();

  let links = null;

  // 1) Bing API
  links = await collectFromBingApi(state);
  if(!links || !links.length){
    // 2) SerpAPI
    const l2 = await collectFromSerpApi(state);
    if(l2 && l2.length) links = l2;
  }
  if(!links || !links.length){
    // 3) Google HTML
    const l3 = await collectFromGoogleHtml(state);
    if(l3 && l3.length) links = l3;
  }
  if(!links || !links.length){
    // 4) Yahoo HTML
    const l4 = await collectFromYahooHtml(state);
    if(l4 && l4.length) links = l4;
  }
  if(!links || !links.length){
    // 5) Fallback Bing/DDG
    const l5 = await collectFromFallback(state);
    links = l5 || [];
  }

  writeState(state);
  console.log(`[LI] Source utilisée: ${state.source || "none"} — ${links.length} lien(s) collecté(s) ce run.`);

  if(!links.length){
    console.log("[LI] Aucun lien ce run. Le crawler avancera à la prochaine exécution.");
    return;
  }

  const existing = readExisting();
  const seen = new Set();
  let created = 0;

  for(const link of links){
    const key = normalizeUrl(link);
    if(seen.has(key) || existing.has(key)) continue;
    seen.add(key);

    let meta = { title:"", desc:"", image:null };
    try{ meta = await fetchOgMetaLinkedIn(link); }catch{}

    writeItem(link, meta);
    created++;
  }

  console.log(`✅ LinkedIn CleaReconDL: ${created} fichier(s) généré(s) → ${OUT_DIR}`);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
