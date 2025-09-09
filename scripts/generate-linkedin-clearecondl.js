// scripts/generate-linkedin-clearecondl.js
// v3.1 "slow crawl" — LinkedIn posts contenant : #cleareconDL | CleaRecon DL | CleaReconDL
// - 6 requêtes SERP max par run (Bing + DuckDuckGo × 3 variantes) via r.jina.ai
// - Pagination PERSISTANTE dans src/content/li-clearecondl/.serp-state.json (committé par CI)
// - Dédup, enrichissement OG (proxy), écriture .md → src/content/li-clearecondl

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";

/* -------- Config -------- */
const OUT_DIR = path.join("src", "content", "li-clearecondl");
const STATE_FILE = path.join(OUT_DIR, ".serp-state.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TIMEOUT = 15000;
const RETRIES = 2;

// Variantes de requêtes (on reste strict : la SERP porte les mots-clés)
const QUERY_VARIANTS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  '"CleaReconDL"',
];

// Offsets que l'on va parcourir progressivement (pas tous d’un coup)
const BING_OFFSETS = [1, 51, 101, 151, 201];       // ~5 pages par variante au total
const DDG_OFFSETS  = [0, 50, 100, 150, 200, 250];  // idem

const BING_Q = (q, first) =>
  `https://www.bing.com/search?q=${encodeURIComponent(`site:linkedin.com (${q})`)}&setlang=fr&count=50&first=${first}`;
const DDG_Q = (q, s) =>
  `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&s=${s}`;
const JINA = (u) => `https://r.jina.ai/http://${u.replace(/^https?:\/\//, "")}`;

/* -------- Utils HTTP -------- */
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

/* -------- Helpers -------- */
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function clean(s = "") { return String(s).replace(/\s+/g, " ").trim(); }
function normalizeUrl(u) { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return String(u || "").toLowerCase(); } }
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter).map(([k,v]) => Array.isArray(v)
    ? `${k}: [${v.map(x=>`"${esc(x)}"`).join(", ")}]`
    : `${k}: "${esc(v)}"`).join("\n") + "\n";
}

/* -------- Détection d'URL de post -------- */
const LI_POST_RE =
  /(https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:posts\/[^\s"')<>]+|feed\/update\/urn:li:(?:activity|ugcPost|share):[0-9A-Za-z_-]+))/gi;

function isLikelyPost(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return p.startsWith("/posts/") ||
      p.includes("/feed/update/urn:li:activity:") ||
      p.includes("/feed/update/urn:li:ugcpost:") ||
      p.includes("/feed/update/urn:li:share:");
  } catch { return false; }
}

/* -------- État persistant -------- */
function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        bing: Object.fromEntries(QUERY_VARIANTS.map(q => [q, 0])),
        ddg:  Object.fromEntries(QUERY_VARIANTS.map(q => [q, 0])),
      };
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {
      bing: Object.fromEntries(QUERY_VARIANTS.map(q => [q, 0])),
      ddg:  Object.fromEntries(QUERY_VARIANTS.map(q => [q, 0])),
    };
  }
}
function writeState(state) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/* -------- Enrichissement OG (proxy) -------- */
async function fetchOgMetaLinkedIn(url) {
  const proxied = JINA(url);
  try {
    const res = await timedFetch(proxied, { headers: { Accept: "text/html" } });
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

/* -------- IO des fichiers existants -------- */
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
  const d = new Date(); // timestamp d'indexation
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

/* -------- Collecte “slow crawl” -------- */
async function collectOneBing(q, idx) {
  const first = BING_OFFSETS[idx % BING_OFFSETS.length];
  const url = JINA(BING_Q(q, first));
  try {
    const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
    if (!res.ok) { console.error(`[LI] Bing ${res.status} first=${first} q=${q}`); return []; }
    const text = await res.text();
    const out = [];
    for (const m of text.matchAll(LI_POST_RE)) {
      const u = m[1].replace(/[\.,]$/, "");
      if (isLikelyPost(u)) out.push(u);
    }
    console.log(`[LI] Bing page first=${first} q=${q} → ${out.length} lien(s)`);
    return out;
  } catch (e) {
    console.error("[LI] Bing error:", String(e).slice(0, 160));
    return [];
  }
}

async function collectOneDDG(q, idx) {
  const s = DDG_OFFSETS[idx % DDG_OFFSETS.length];
  const url = JINA(DDG_Q(q, s));
  try {
    const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
    if (!res.ok) { console.error(`[LI] DDG ${res.status} s=${s} q=${q}`); return []; }
    const text = await res.text();
    const out = [];
    for (const m of text.matchAll(LI_POST_RE)) {
      const u = m[1].replace(/[\.,]$/, "");
      if (isLikelyPost(u)) out.push(u);
    }
    console.log(`[LI] DDG page s=${s} q=${q} → ${out.length} lien(s)`);
    return out;
  } catch (e) {
    console.error("[LI] DDG error:", String(e).slice(0, 160));
    return [];
  }
}

/* -------- MAIN -------- */
async function main() {
  ensureDir(OUT_DIR);

  // Charger/initialiser l'état
  const state = readState();

  // Collecte LIMITÉE par run (6 requêtes max)
  const tasks = [];
  for (const q of QUERY_VARIANTS) {
    tasks.push(collectOneBing(q, state.bing[q] || 0));
    tasks.push(collectOneDDG(q, state.ddg[q] || 0));
  }
  const results = await Promise.all(tasks);
  const links = [...new Set(results.flat())];
  console.log(`[LI] Liens uniques collectés ce run: ${links.length}`);

  // Avancer l'état (pagination pour le prochain run)
  for (const q of QUERY_VARIANTS) {
    state.bing[q] = ((state.bing[q] || 0) + 1) % BING_OFFSETS.length;
    state.ddg[q]  = ((state.ddg[q]  || 0) + 1) % DDG_OFFSETS.length;
  }
  writeState(state);

  if (!links.length) {
    console.log("[LI] Rien trouvé ce run (probable throttling). Le slow crawl avancera au prochain run.");
    return;
  }

  // Dé-dup avec existants
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

main().catch((e) => { console.error(e); process.exit(1); });
