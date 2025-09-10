// scripts/generate-twitter-clearecondl.js
// Tweets (X) sur 1 mois glissant contenant : #cleareconDL | "CleaRecon DL" | "CleaReconDL"
// 1) SerpAPI (si SERPAPI_KEY) avec tbs=qdr:m  2) Google HTML (via r.jina.ai) avec tbs=qdr:m (fallback)
// Écrit des .md dans src/content/tweets-clearecondl + vignettes (image pbs.twimg.com si trouvée, sinon avatar)

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";

/* ---------- Config ---------- */
const OUT_DIR = path.join("src", "content", "tweets-clearecondl");
const STATE_FILE = path.join(OUT_DIR, ".serp-state.json");
const UA = "Mozilla/5.0 (compatible; clearecondl-bot/1.0; +https://example.org)";
const TIMEOUT = 15000;
const RETRIES = 1;

// Variantes de requêtes
const QUERY_VARIANTS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  '"CleaReconDL"',
];

// Pagination
const SERPAPI_STARTS = [0, 100, 200, 300];
const GOOGLE_STARTS  = [0, 10, 20, 30, 40];

/* ---------- Utils ---------- */
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
function clean(s = "") { return String(s).replace(/\s+/g, " ").trim(); }
function normalizeUrl(u) { try { const x=new URL(u); return (x.origin+x.pathname).replace(/\/+$/,"").toLowerCase(); } catch { return String(u||"").toLowerCase(); } }
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter).map(([k,v]) =>
    Array.isArray(v) ? `${k}: [${v.map(x=>`"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`
  ).join("\n") + "\n";
}
const JINA = (u) => `https://r.jina.ai/http://${u.replace(/^https?:\/\//, "")}`;

/* ---------- Reconnaissance d'URL de tweet ---------- */
const TWEET_URL_RE = /(https?:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+))/gi;
function parseTweetUrl(u) {
  const m = String(u).match(/https?:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
  if (!m) return null;
  return { username: m[1], id: m[2] };
}

/* ---------- State avec migration ---------- */
function defaultState() {
  return {
    serpapi: Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
    google:  Object.fromEntries(QUERY_VARIANTS.map(q=>[q,0])),
  };
}
function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    // migration douce
    const d = defaultState();
    const out = { ...d, ...s };
    for (const q of QUERY_VARIANTS) {
      if (!Number.isInteger(out.serpapi[q])) out.serpapi[q] = 0;
      if (!Number.isInteger(out.google[q]))  out.google[q]  = 0;
    }
    if (JSON.stringify(out) !== JSON.stringify(s)) writeState(out);
    return out;
  } catch {
    return defaultState();
  }
}
function writeState(s) { ensureDir(OUT_DIR); fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2),"utf-8"); }

/* ---------- Enrichissement : titre/desc + vignette ---------- */
async function fetchTweetMeta(url, username) {
  try {
    const res = await timedFetch(JINA(url), { headers: { Accept: "text/html" } });
    if (!res.ok) return fallbackMeta(username);
    const html = await res.text();

    const pick = (re) => html.match(re)?.[1] || "";
    const title = clean(
      pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
      pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)
    );
    const desc = clean(
      pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
      pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)
    );

    // Tente d'attraper une image du tweet (pbs.twimg.com)
    let media = "";
    const mediaMatch = html.match(/https?:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_\-]+\.[a-zA-Z0-9?=.&_%+-]+/i);
    if (mediaMatch) media = mediaMatch[0];

    const ogimg = pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const image = media || ogimg || `https://unavatar.io/twitter/${username}`;

    return {
      title: title || `Tweet de @${username}`,
      desc: desc || title || "",
      image
    };
  } catch {
    return fallbackMeta(username);
  }
}
function fallbackMeta(username) {
  return { title: `Tweet de @${username}`, desc: "", image: `https://unavatar.io/twitter/${username}` };
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
  const d = new Date(); // pas de date fiable → timestamp d'indexation (recherche déjà limitée à 1 mois)
  const yyyy = d.getUTCFullYear(), mm = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
  const base = `${yyyy}-${mm}-${dd}-${slugify(meta.title || "tweet", { lower:true, strict:true }).slice(0,80)}`;
  const file = path.join(OUT_DIR, `${base}.md`);
  const fm = {
    title: meta.title || "Tweet",
    date: d.toISOString(),
    publishedDate: d.toLocaleDateString("fr-FR", { year:"numeric", month:"long", day:"numeric" }),
    summary: meta.desc || meta.title || "",
    sourceUrl: link,
    permalink: `/tweets-clearecondl/${base}`,
    tags: ["Twitter", "CleaReconDL"],
    imageUrl: meta.image || "",
    imageCredit: meta.image ? `Image — ${link}` : "",
  };
  const body = (fm.imageUrl ? `![${fm.title}](${fm.imageUrl})\n\n` : "") +
               `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${link}\n`;
  fs.writeFileSync(file, `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
}

/* ---------- 1) SerpAPI (Google) ---------- */
async function collectFromSerpApi(state) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return null;

  const all = new Set();
  for (const q of QUERY_VARIANTS) {
    const idx = Number.isInteger(state.serpapi?.[q]) ? state.serpapi[q] : 0;
    const start = SERPAPI_STARTS[idx % SERPAPI_STARTS.length];

    for (const domain of ["twitter.com", "x.com"]) {
      const params = new URLSearchParams({
        engine: "google",
        q: `site:${domain} ${q}`,
        hl: "fr",
        gl: "fr",
        num: "100",
        start: String(start),
        tbs: "qdr:m", // ← 1 mois
        api_key: key,
      });
      const url = `https://serpapi.com/search.json?${params.toString()}`;
      const res = await timedFetch(url);
      if (!res.ok) { console.error(`[TW] SerpAPI ${res.status} start=${start} q=${q} site:${domain}`); continue; }
      const data = await res.json();
      for (const r of data?.organic_results || []) {
        const text = [r.link, r.title, r.snippet].filter(Boolean).join(" ");
        for (const m of text.matchAll(TWEET_URL_RE)) all.add(m[1]);
      }
      await sleep(250);
    }

    state.serpapi ??= {}; state.serpapi[q] = (idx + 1) % SERPAPI_STARTS.length;
  }
  return [...all];
}

/* ---------- 2) Google HTML (via r.jina.ai) ---------- */
function GOOGLE_Q(q, domain, start=0) {
  // tbs=qdr:m → dernier mois
  return `https://www.google.com/search?q=${encodeURIComponent(`site:${domain} ${q}`)}&hl=fr&num=10&start=${start}&tbs=qdr:m`;
}
async function collectFromGoogleHtml(state) {
  const all = new Set();
  for (const q of QUERY_VARIANTS) {
    const idx = Number.isInteger(state.google?.[q]) ? state.google[q] : 0;
    const start = GOOGLE_STARTS[idx % GOOGLE_STARTS.length];

    for (const domain of ["twitter.com", "x.com"]) {
      const prox = JINA(GOOGLE_Q(q, domain, start));
      try {
        const res = await timedFetch(prox, { headers: { Accept: "text/plain" } });
        if (!res.ok) { console.error(`[TW] Google HTML ${res.status} start=${start} q=${q} site:${domain}`); continue; }
        const text = await res.text();
        for (const m of text.matchAll(TWEET_URL_RE)) all.add(m[1]);
      } catch (e) {
        console.error("[TW] Google HTML error:", String(e).slice(0,160));
      }
      await sleep(300);
    }

    state.google ??= {}; state.google[q] = (idx + 1) % GOOGLE_STARTS.length;
  }
  return [...all];
}

/* ---------- MAIN ---------- */
async function main() {
  ensureDir(OUT_DIR);
  const state = readState();

  let links = null;

  // 1) SerpAPI si dispo
  try { links = await collectFromSerpApi(state); } catch (e) { console.error(e); }

  // 2) Google HTML sinon
  if (!links || !links.length) {
    try { links = await collectFromGoogleHtml(state); } catch (e) { console.error(e); links = []; }
  }

  writeState(state);
  console.log(`[TW] Liens collectés ce run: ${links.length}`);

  if (!links.length) {
    console.log("[TW] Aucun tweet trouvé ce run (ou throttling). On réessaiera au prochain run.");
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

    const parsed = parseTweetUrl(link);
    if (!parsed) continue;

    const meta = await fetchTweetMeta(link, parsed.username);
    writeItem(link, meta);
    created++;
  }

  console.log(`✅ Twitter CleaReconDL: ${created} fichier(s) généré(s) → ${OUT_DIR}`);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
