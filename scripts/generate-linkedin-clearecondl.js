// scripts/generate-linkedin-clearecondl.js
// v4 — LinkedIn posts contenant : #cleareconDL | "CleaRecon DL" | "CleaReconDL"
// Ordre des sources : 1) Bing Web Search API (AZURE_BING_KEY)  2) SerpAPI (SERPAPI_KEY)  3) Slow-crawl (fallback)
// Écrit des .md dans src/content/li-clearecondl et persiste la pagination de l’API choisie.

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";

/* ---------- Config ---------- */
const OUT_DIR = path.join("src", "content", "li-clearecondl");
const STATE_FILE = path.join(OUT_DIR, ".serp-state.json"); // stocke offsets/pagination
const UA = "Mozilla/5.0 (compatible; clearecondl-bot/1.0; +https://example.org)";
const TIMEOUT = 15000;
const RETRIES = 1;

// Variantes de requêtes (on laisse les mots-clés aux SERP/API)
const QUERY_VARIANTS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  '"CleaReconDL"',
];

// Pagination par source
const BING_OFFSETS = [0, 50, 100, 150, 200]; // 'offset' (count=50)
const SERPAPI_STARTS = [0, 100, 200, 300];   // 'start' (num=100)

/* ---------- Helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function timedFetch(url, opts = {}, retries = RETRIES) {
  for (let i = 0; ; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...opts,
        headers: {
          "User-Agent": UA,
          "Accept-Language": "fr,fr-FR;q=0.9,en;q=0.8",
          ...(opts.headers || {}),
        },
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
function clean(s = "") { return String(s).replace(/\s+/g, " ").trim(); }
function normalizeUrl(u) { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return String(u || "").toLowerCase(); } }
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter).map(([k,v]) =>
    Array.isArray(v) ? `${k}: [${v.map(x=>`"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`
  ).join("\n") + "\n";
}

// Reconnaître les posts LinkedIn (plusieurs formats)
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

/* ---------- State ---------- */
function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        source: null, // "bing" | "serpapi" | "fallback"
        bing: Object.fromEntries(QUERY_VARIANTS.map(q => [q, 0])),
        serpapi: Object.fromEntries(QUERY_VARIANTS.map(q => [q, 0])),
        fallback: { step: 0 }
      };
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {
      source: null,
      bing: Object.fromEntries(QUERY_VARIANTS.map(q => [q, 0])),
      serpapi: Object.fromEntries(QUERY_VARIANTS.map(q => [q, 0])),
      fallback: { step: 0 }
    };
  }
}
function writeState(s) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf-8");
}

/* ---------- Enrichissement OG via proxy ---------- */
const JINA = (u) => `https://r.jina.ai/http://${u.replace(/^https?:\/\//, "")}`;
async function fetchOgMetaLinkedIn(url) {
  try {
    const res = await timedFetch(JINA(url), { headers: { Accept: "text/html" } });
    if (!res.ok) return { title: "", desc: "", image: null };
    const html = await res.text();
    const pick = (re) => html.match(re)?.[1] || "";
    const image = [
      /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
    ].map(re => pick(re))
     .map(u => { try { return new URL(u, url).href; } catch { return ""; } })
     .find(Boolean) || null;
    const title = pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || "";
    const desc  = pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || "";
    return { title: clean(title), desc: clean(desc), image };
  } catch {
    return { title: "", desc: "", image: null };
  }
}

/* ---------- E/S contenus ---------- */
function readExisting() {
  const set = new Set();
  if (!fs.existsSync(OUT_DIR)) return set;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.endsWith(".md")) continue;
    const txt = fs.readFileSync(path.join(OUT_DIR, f), "utf-8");
    const m = txt.match(/sourceUrl:\s*"([^"]+)"/);
    if (m) set.add(normalizeUrl(m[1]));
  }
  return set;
}
function writeItem(link, meta) {
  ensureDir(OUT_DIR);
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth()+1).padStart(2,"0");
  const dd = String(d.getUTCDate()).padStart(2,"0");
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

/* ---------- 1) Bing Web Search API ---------- */
async function collectFromBingApi(state) {
  const key = process.env.AZURE_BING_KEY;
  if (!key) return null;

  const all = new Set();
  for (const q of QUERY_VARIANTS) {
    const idx = state.bing[q] || 0;
    const offset = BING_OFFSETS[idx % BING_OFFSETS.length];
    const params = new URLSearchParams({
      q: `site:linkedin.com (${q})`,
      mkt: "fr-FR",
      count: "50",
      offset: String(offset),
      responseFilter: "Webpages",
      textDecorations: "false",
      textFormat: "Raw",
    });
    const url = `https://api.bing.microsoft.com/v7.0/search?${params.toString()}`;
    const res = await timedFetch(url, { headers: { "Ocp-Apim-Subscription-Key": key } });
    if (!res.ok) {
      const body = await res.text().catch(()=> "");
      console.error(`[LI] Bing API ${res.status} offset=${offset} q=${q} :: ${body.slice(0,180)}`);
      continue;
    }
    const data = await res.json();
    const items = data?.webPages?.value || [];
    for (const it of items) {
      const u = it.url;
      if (typeof u === "string" && isLikelyPost(u)) all.add(u);
      // parfois le snippet contient d'autres liens : on tente un match
      const sn = `${it.snippet || ""} ${it.name || ""}`;
      for (const m of sn.matchAll(LI_POST_RE)) all.add(m[1]);
    }
    // avance pagination pour ce q
    state.bing[q] = (idx + 1) % BING_OFFSETS.length;
  }
  state.source = "bing";
  return [...all];
}

/* ---------- 2) SerpAPI (Google) ---------- */
async function collectFromSerpApi(state) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return null;

  const all = new Set();
  for (const q of QUERY_VARIANTS) {
    const idx = state.serpapi[q] || 0;
    const start = SERPAPI_STARTS[idx % SERPAPI_STARTS.length];
    const params = new URLSearchParams({
      engine: "google",
      q: `site:linkedin.com ${q}`,
      hl: "fr",
      gl: "fr",
      num: "100",
      start: String(start),
      api_key: key,
    });
    const url = `https://serpapi.com/search.json?${params.toString()}`;
    const res = await timedFetch(url);
    if (!res.ok) {
      const body = await res.text().catch(()=> "");
      console.error(`[LI] SerpAPI ${res.status} start=${start} q=${q} :: ${body.slice(0,180)}`);
      continue;
    }
    const data = await res.json();
    const org = data?.organic_results || [];
    for (const r of org) {
      const u = r.link;
      if (typeof u === "string" && isLikelyPost(u)) all.add(u);
      const rich = r.rich_snippet || {};
      const html = [r.snippet, rich.top?.extensions?.join(" "), rich.top?.detected_extensions?.join(" ")].filter(Boolean).join(" ");
      for (const m of html.matchAll(LI_POST_RE)) all.add(m[1]);
    }
    state.serpapi[q] = (idx + 1) % SERPAPI_STARTS.length;
  }
  state.source = "serpapi";
  return [...all];
}

/* ---------- 3) Fallback slow-crawl (dernier recours) ---------- */
const BING_HTML = (q, first=1) => `https://www.bing.com/search?q=${encodeURIComponent(`site:linkedin.com (${q})`)}&setlang=fr&count=50&first=${first}`;
const DDG_HTML  = (q, s=0)       => `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&s=${s}`;
async function collectFromFallback(state) {
  const step = state.fallback.step || 0;
  const pages = [
    ...QUERY_VARIANTS.map((q,i)=>({ type:"bing", q, first: BING_OFFSETS[(step+i)%BING_OFFSETS.length] || 0 })),
    ...QUERY_VARIANTS.map((q,i)=>({ type:"ddg",  q, s:     SERPAPI_STARTS[(step+i)%SERPAPI_STARTS.length] || 0 })),
  ];

  const all = new Set();
  for (const p of pages) {
    const url = p.type === "bing" ? BING_HTML(p.q, p.first || 1) : DDG_HTML(p.q, p.s || 0);
    const proxied = JINA(url);
    try {
      const res = await timedFetch(proxied, { headers: { Accept: "text/plain" } });
      if (!res.ok) { console.error(`[LI] Fallback ${p.type} ${res.status} q=${p.q}`); continue; }
      const text = await res.text();
      for (const m of text.matchAll(LI_POST_RE)) {
        const u = m[1].replace(/[\.,]$/, "");
        if (isLikelyPost(u)) all.add(u);
      }
    } catch (e) {
      console.error("[LI] Fallback error:", String(e).slice(0,160));
    }
    await sleep(250);
  }
  state.fallback.step = (step + 1) % 8;
  state.source = "fallback";
  return [...all];
}

/* ---------- MAIN ---------- */
async function main() {
  ensureDir(OUT_DIR);
  const state = readState();

  let links = null;

  // 1) Bing API si clé présente
  links = await collectFromBingApi(state);
  if (!links || links.length === 0) {
    // 2) SerpAPI si clé présente
    const l2 = await collectFromSerpApi(state);
    if (l2 && l2.length) links = l2;
  }
  if (!links || links.length === 0) {
    // 3) Fallback (lent, sujet aux 429)
    const l3 = await collectFromFallback(state);
    links = l3 || [];
  }

  writeState(state);
  console.log(`[LI] Source utilisée: ${state.source || "none"} — ${links.length} lien(s) collecté(s) ce run.`);

  if (!links.length) {
    console.log("[LI] Aucun lien ce run. Réessaiera au prochain.");
    return;
  }

  const existing = readExisting();
  const seen = new Set();
  let created = 0;

  for (const link of links) {
    const key = normalizeUrl(link);
    if (seen.has(key) || existing.has(key)) continue;
    seen.add(key);

    // Enrichissement OG (non bloquant)
    let meta = { title: "", desc: "", image: null };
    try { meta = await fetchOgMetaLinkedIn(link); } catch {}

    writeItem(link, meta);
    created++;
  }

  console.log(`✅ LinkedIn CleaReconDL: ${created} fichier(s) généré(s) → ${OUT_DIR}`);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
