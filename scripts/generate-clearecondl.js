// scripts/generate-clearecondl.js
// Colonne “CleaRecon DL / CleareconDL / #clearecondl” — v1.5
// - Résout les redirections (news.google.com / bing.com/news / t.co, etc.)
// - Filtre LinkedIn : n’accepte que des POSTS (activity / posts / profil + recent-activity/posts)
// - Backfill (pas de filtre de date) + dédous après résolution

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

/* ---- CONFIG ---- */
const OUT_DIR_MAIN = path.join("src", "content", "clearecondl");
const OUT_DIR_ALT  = path.join("src", "content", "cleareconDL");
const OUT_DIRS = [OUT_DIR_MAIN, OUT_DIR_ALT];

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const USER_AGENT = "clearecondl/1.5 (+https://github.com/)";

// Requêtes (variantes)
const QUERIES = [
  `"CleaRecon DL"`,
  `"CleareconDL"`,
  `#clearecondl`,
  `"CleaRecon"`,
  `"Clearecon"`,
  `"Clear Recon DL"`,
  `"ClearEcon DL"`
];

// (optionnel) chaînes YouTube à pinner, format: YT_CHANNEL_IDS="UCxxxx,UCyyyy"
const YT_CHANNEL_IDS = (process.env.YT_CHANNEL_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

// (optionnel) LinkedIn via RSSHub (pages ENTREPRISE uniquement)
const RSSHUB_BASE = (process.env.RSSHUB_BASE || "").replace(/\/+$/, "");
const LINKEDIN_COMPANY_IDS = (process.env.LINKEDIN_COMPANY_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

// (optionnel) borne d’écriture
const MAX_ITEMS = parseInt(process.env.CLEARECONDL_MAX_ITEMS || "", 10) || Infinity;

/* ---- SEARCH FEEDS ---- */
const SEARCH_FEEDS = [
  { name: "Google News (web)",     url: "https://news.google.com/rss/search?q={q}&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (web)",       url: "https://www.bing.com/news/search?q={q}&format=RSS" },
  { name: "Google News (LinkedIn)",url: "https://news.google.com/rss/search?q={q}+site%3Alinkedin.com&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (LinkedIn)",  url: "https://www.bing.com/news/search?q={q}+site%3Alinkedin.com&format=RSS" },
  { name: "YouTube Search",        url: "https://www.youtube.com/feeds/videos.xml?search_query={q}" },
  { name: "Reddit",                url: "https://www.reddit.com/search.rss?q={q}" },
];

/* ---- utils ---- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function timedFetch(url, opts = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...opts,
        headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return res;
    } catch (err) {
      clearTimeout(t);
      if (attempt >= retries) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
}
function cleanText(s = "") {
  return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch { return String(u).toLowerCase(); }
}
function hostnameOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter)
    .map(([k, v]) => Array.isArray(v)
      ? `${k}: [${v.map((x) => `"${esc(x)}"`).join(", ")}]`
      : `${k}: "${esc(v)}"`).join("\n") + "\n";
}

/* ---- RSS ---- */
async function fetchFeed(url) {
  const res = await timedFetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed?.rss?.channel || parsed?.feed;
  const raw = channel?.item || channel?.entry || [];
  return Array.isArray(raw) ? raw : [raw].filter(Boolean);
}
function toItem(e, sourceName) {
  const title = cleanText(e.title?.["#text"] || e.title);
  const link =
    typeof e.link === "string"
      ? e.link
      : e.link?.href || (Array.isArray(e.link) ? e.link.find(x => x?.href)?.href || e.link[0] : null);
  const pageUrl = link || e.id || "";
  const summary = cleanText(e.description || e.summary || e.content?.["#text"] || e.content);
  const dateISO = (() => {
    const cand = e.pubDate || e.published || e.updated || e["dc:date"];
    const t = Date.parse(cand);
    return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
  })();
  return { title, summary, link: pageUrl, dateISO, source: sourceName };
}

/* ---- Résolution d'URL finale (suivre redirections) ---- */
const REDIR_HOSTS = new Set([
  "news.google.com", "www.google.com", "google.com",
  "www.bing.com", "bing.com",
  "t.co", "lnkd.in", "l.facebook.com", "lm.facebook.com"
]);

async function resolveFinalUrl(u) {
  try {
    const res = await timedFetch(u, { method: "GET", headers: { Accept: "text/html" } });
    // node-fetch suit déjà les redirections; res.url est l’URL finale
    return res.url || u;
  } catch {
    return u;
  }
}
function needsResolve(u, sourceName = "") {
  const h = hostnameOf(u);
  if (REDIR_HOSTS.has(h)) return true;
  if (/linkedIn/i.test(sourceName)) return true;
  return false;
}

/* ---- Image OG ---- */
async function fetchOgImage(articleUrl) {
  try {
    const res = await timedFetch(articleUrl, { headers: { Accept: "text/html" } });
    if (!res.ok) return null;
    const html = await res.text();
    const pick = (re) => html.match(re)?.[1];
    const og = pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const tw = pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i);
    const cands = [og, tw].filter(Boolean).map(u => { try { return new URL(u, articleUrl).href; } catch { return null; } }).filter(Boolean);
    return cands[0] || null;
  } catch { return null; }
}

/* ---- Filtrage dur LinkedIn + mots-clés ---- */
const STRICT_KEYWORD_RE = /\b(clearecondl|clea\s*recon\s*dl)\b/i;
function classifyLinkedIn(u) {
  try {
    const { pathname } = new URL(u);
    const p = pathname.toLowerCase();
    if (p.includes("/feed/update/urn:li:activity:")) return "post";
    if (p.startsWith("/posts/")) return "post";
    if (p.startsWith("/in/")) {
      if (p.includes("/recent-activity/") && p.includes("/posts/")) return "profile-posts";
      return "profile";
    }
    if (p.startsWith("/company/"))  return "company";
    if (p.startsWith("/jobs"))      return "jobs";
    if (p.startsWith("/learning"))  return "learning";
    if (p.startsWith("/pulse/"))    return "pulse";
    return "other";
  } catch { return "none"; }
}
function isRelevantItem(it) {
  const text = `${it.title || ""} ${it.summary || ""} ${it.link || ""}`.toLowerCase();
  if (!STRICT_KEYWORD_RE.test(text)) return false;

  const host = hostnameOf(it.link);
  if (host.endsWith("linkedin.com")) {
    const cls = classifyLinkedIn(it.link);
    if (!(cls === "post" || cls === "profile-posts")) return false;
  }
  return true;
}

function ensureDirs() { for (const d of OUT_DIRS) fs.mkdirSync(d, { recursive: true }); }
function readExisting() {
  const seen = new Set();
  for (const dir of OUT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const txt = fs.readFileSync(path.join(dir, f), "utf-8");
      const m = txt.match(/sourceUrl:\s*"([^"]+)"/);
      if (m) seen.add(normalizeUrl(m[1]));
    }
  }
  return seen;
}

async function main() {
  ensureDirs();
  const seenExisting = readExisting();

  // 1) Collecte brute
  const raw = [];
  for (const q of QUERIES) {
    for (const feed of SEARCH_FEEDS) {
      const url = feed.url.replace("{q}", encodeURIComponent(q));
      try {
        const entries = await fetchFeed(url);
        for (const e of entries) {
          const it = toItem(e, feed.name);
          if (it.title && it.link) raw.push(it);
        }
      } catch (err) {
        console.error("Feed error:", feed.name, url, String(err).slice(0, 160));
      }
    }
  }

  // 2) + YouTube (chaînes)
  for (const ch of YT_CHANNEL_IDS) {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch)}`;
    try {
      const entries = await fetchFeed(url);
      for (const e of entries) {
        const it = toItem(e, "YouTube Channel");
        if (it.title && it.link) raw.push(it);
      }
    } catch (err) {
      console.error("YouTube channel feed error:", ch, String(err).slice(0, 160));
    }
  }

  // 3) + LinkedIn via RSSHub (entreprises)
  if (RSSHUB_BASE && LINKEDIN_COMPANY_IDS.length) {
    for (const id of LINKEDIN_COMPANY_IDS) {
      const url = `${RSSHUB_BASE}/linkedin/company/${encodeURIComponent(id)}/posts`;
      try {
        const entries = await fetchFeed(url);
        for (const e of entries) {
          const it = toItem(e, "LinkedIn (RSSHub)");
          if (it.title && it.link) raw.push(it);
        }
      } catch (err) {
        console.error("RSSHub LinkedIn error:", id, String(err).slice(0, 160));
      }
    }
  }

  // 4) Dé-dup préliminaire (lien tel-quel)
  const prelim = [];
  const seen1 = new Set();
  for (const it of raw) {
    const key = normalizeUrl(it.link);
    if (seen1.has(key)) continue;
    seen1.add(key);
    prelim.push(it);
  }

  // 5) Résoudre l’URL FINALE si besoin, puis re-dédoublonner
  const resolved = [];
  for (const it of prelim) {
    let finalLink = it.link;
    if (needsResolve(it.link, it.source)) {
      finalLink = await resolveFinalUrl(it.link);
    }
    resolved.push({ ...it, link: finalLink });
  }
  const uniq = [];
  const seen2 = new Set();
  for (const it of resolved) {
    const key = normalizeUrl(it.link);
    if (seen2.has(key)) continue;
    seen2.add(key);
    uniq.push(it);
  }

  // 6) Filtrage strict (mots-clés + LinkedIn posts uniquement)
  const filtered = uniq.filter(isRelevantItem);

  // 7) Tri chrono desc
  filtered.sort((a, b) => new Date(b.dateISO).getTime() - new Date(a.dateISO).getTime());

  // 8) Écriture (dans les 2 dossiers)
  let created = 0;
  for (const it of filtered) {
    if (created >= MAX_ITEMS) break;
    const key = normalizeUrl(it.link);
    if (seenExisting.has(key)) continue;

    const d = new Date(it.dateISO);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const niceDate = `${yyyy}-${mm}-${dd}`;
    const base = `${niceDate}-${slugify(it.title, { lower: true, strict: true }).slice(0, 80)}`;
    const imageUrl = await fetchOgImage(it.link);

    const fm = {
      title: it.title,
      date: d.toISOString(),
      publishedDate: d.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" }),
      summary: it.summary || it.title,
      sourceUrl: it.link,
      permalink: `/clearecondl/${base}`,
      tags: ["CleareconDL", it.source],
      imageUrl: imageUrl || "",
      imageCredit: imageUrl ? `Image de l’article — ${it.link}` : "",
    };

    const body =
      (imageUrl ? `![${it.title}](${imageUrl})\n\n` : "") +
      `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${it.link}\n`;

    const fileName = `${base}.md`;
    for (const dir of OUT_DIRS) {
      fs.writeFileSync(path.join(dir, fileName), `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
    }
    created++;
  }

  console.log(`✅ CleaReconDL v1.5: ${created} fichier(s) ajouté(s) sur ${filtered.length} pertinents (bruts: ${raw.length}, uniques avant filtre: ${uniq.length}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
