// scripts/generate-clearecondl.js
// v2.4 — CleaReconDL colonne gauche (100% auto, sans ENV)
// - + JFR+ (jfr.plus) : scraping de la recherche "ec_news" (sans RSS)
// - UA "navigateur" pour éviter 403 (YouTube) et durcir la compatibilité
// - LinkedIn: AUCUNE requête directe -> tout passe par r.jina.ai (SERP + OG)
// - YouTube GE HealthCare: channel_id officiel + fallback user
// - Dédup, suivi de redirections, OG meta, tri, écriture MD

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

/* ===== Config ===== */
const OUT_DIRS = [
  path.join("src", "content", "clearecondl"),
  path.join("src", "content", "cleareconDL"),
];

const KEY_QUERIES = [
  `"CleaRecon DL"`, `"CleareconDL"`, `#clearecondl`,
  `"CleaRecon"`, `"Clearecon"`, `"Clear Recon DL"`, `"ClearEcon DL"`,
];

const LINKEDIN_PEOPLE = [
  "Charles Nutting",
  "Ioanne Cartier",
];

// YouTube GE HealthCare
const YT_CHANNEL_IDS = ["UC04R4GsgwjtoI28q7F3YrLw"]; // confirmé
const YT_USERS = ["gehealthcare"]; // fallback

const MAX_ITEMS = Infinity;

/* ===== Feeds complémentaires ===== */
const SEARCH_FEEDS = [
  { name: "YouTube Search",         url: "https://www.youtube.com/feeds/videos.xml?search_query={q}" },
  { name: "Google News (web)",      url: "https://news.google.com/rss/search?q={q}&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (web)",        url: "https://www.bing.com/news/search?q={q}&format=RSS" },
  { name: "Reddit",                 url: "https://www.reddit.com/search.rss?q={q}" },
  { name: "Reddit",                 url: "https://www.reddit.com/search.rss?q={q}" },
];

// SERP Bing en HTML (on passera via r.jina.ai)
const BING_WEB = (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=fr`;

/* ===== Utils ===== */
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
// 👇 UA navigateur pour lever les blocages
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function timedFetch(url, opts = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...opts,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "fr,fr-FR;q=0.9,en;q=0.8",
          ...(opts.headers || {}),
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return res;
    } catch (err) {
      clearTimeout(t);
      if (attempt >= retries) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
}
function cleanText(s = "") { return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function normalizeUrl(u) { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return String(u).toLowerCase(); } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter)
    .map(([k, v]) => Array.isArray(v) ? `${k}: [${v.map((x) => `"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`).join("\n") + "\n";
}

/* ===== RSS helpers ===== */
async function fetchFeed(url) {
  const res = await timedFetch(url, { headers: { Accept: "application/rss+xml,text/xml;q=0.9,*/*;q=0.1" } });
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
    typeof e.link === "string" ? e.link :
    e.link?.href || (Array.isArray(e.link) ? e.link.find((x) => x?.href)?.href || e.link[0] : null);
  const pageUrl = link || e.id || "";
  const summary = cleanText(e.description || e.summary || e.content?.["#text"] || e.content);
  const dateISO = (() => {
    const cand = e.pubDate || e.published || e.updated || e["dc:date"];
    const t = Date.parse(cand);
    return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
  })();
  return { title, summary, link: pageUrl, dateISO, source: sourceName };
}

/* ===== Redirections ===== */
const REDIR_HOSTS = new Set(["news.google.com","google.com","www.google.com","www.bing.com","bing.com","t.co","lnkd.in","l.facebook.com","lm.facebook.com"]);
async function resolveFinalUrl(u) {
  try { const res = await timedFetch(u, { method: "GET", headers: { Accept: "text/html" } }); return res.url || u; }
  catch { return u; }
}
function needsResolve(u, sourceName = "") {
  const h = hostOf(u);
  if (REDIR_HOSTS.has(h)) return true;
  if (/LinkedIn/i.test(sourceName)) return true;
  return false;
}

/* ===== OG meta ===== */
async function fetchOgMeta(articleUrl) {
  const h = hostOf(articleUrl);
  // ⚠️ LinkedIn : passer via lecteur r.jina.ai
  const target =
    h.endsWith("linkedin.com")
      ? `https://r.jina.ai/http://${articleUrl.replace(/^https?:\/\//, "")}`
      : articleUrl;

  try {
    const res = await timedFetch(target, { headers: { Accept: "text/html" } });
    if (!res.ok) return { title: "", desc: "", image: null };
    const html = await res.text();
    const pick = (re) => html.match(re)?.[1] || "";
    const image = [ /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
                    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i ]
      .map(re => pick(re))
      .map(u => { try { return new URL(u, articleUrl).href; } catch { return ""; } })
      .find(Boolean) || null;
    const title = pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || "";
    const desc  = pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || "";
    return { title: cleanText(title), desc: cleanText(desc), image };
  } catch {
    return { title: "", desc: "", image: null };
  }
}

/* ===== Matching ===== */
const KEY_PATTERNS = [
  /\bclearecondl\b/i, /#\s*clearecondl\b/i,
  /\bclea\s*recon\s*dl\b/i, /\bclearecon\b/i, /\bclear\s*recon\b/i,
];
function anyKeyMatch(text) { return KEY_PATTERNS.some(re => re.test(text)); }
function anyPersonMatch(text) {
  const t = (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return LINKEDIN_PEOPLE.some(n =>
    t.includes(n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())
  );
}
function classifyLinkedIn(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    if (p.includes("/feed/update/urn:li:activity:")) return "post";
    if (p.startsWith("/posts/")) return "post";
    if (p.startsWith("/in/")) {
      if (p.includes("/recent-activity/") && p.includes("/posts/")) return "profile-posts";
      return "profile";
    }
    return "other";
  } catch { return "none"; }
}

/* ===== YouTube ===== */
async function collectYouTube(raw, bump) {
  for (const ch of YT_CHANNEL_IDS) {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch)}`;
    try {
      const entries = await fetchFeed(url);
      bump(`YouTube Channel: ${ch}`, entries.length);
      for (const e of entries) raw.push(toItem(e, `YouTube Channel: ${ch}`));
    } catch (err) {
      console.error("YouTube channel feed error:", ch, String(err).slice(0, 160));
    }
  }
  for (const user of YT_USERS) {
    const url = `https://www.youtube.com/feeds/videos.xml?user=${encodeURIComponent(user)}`;
    try {
      const entries = await fetchFeed(url);
      bump(`YouTube User: ${user}`, entries.length);
      for (const e of entries) raw.push(toItem(e, `YouTube User: ${user}`));
    } catch (err) {
      console.error("YouTube user feed error:", user, String(err).slice(0, 160));
    }
  }
}

/* ===== LinkedIn discovery via r.jina.ai ===== */
const JINA = (absoluteUrl) => `https://r.jina.ai/http://${absoluteUrl.replace(/^https?:\/\//,"")}`;

// SERP Bing -> extrait des posts linkedin
async function scrapeBingForLinkedInPosts(person, max = 12) {
  const queries = [
    `site:linkedin.com/posts/ "${person}"`,
    `site:linkedin.com/feed/update "${person}"`,
  ];
  const items = [];
  const seen = new Set();

  for (const q of queries) {
    const proxied = JINA(BING_WEB(q));
    try {
      const res = await timedFetch(proxied, { headers: { Accept: "text/plain" } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();

      const push = (u) => {
        const key = normalizeUrl(u);
        if (seen.has(key)) return;
        seen.add(key);
        items.push({
          title: "Post LinkedIn",
          summary: "",
          link: u,
          dateISO: new Date().toISOString(),
          source: `Bing SERP (LI post) — ${person}`,
        });
      };

      for (const m of text.matchAll(/https:\/\/www\.linkedin\.com\/posts\/[^\s")]+/g)) {
        push(m[0]);
        if (items.length >= max) break;
      }
      if (items.length < max) {
        for (const m of text.matchAll(/https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:[0-9A-Za-z_-]+/g)) {
          push(m[0]);
          if (items.length >= max) break;
        }
      }
    } catch (err) {
      console.error("scrapeBingForLinkedInPosts error:", person, q, String(err).slice(0,160));
    }
  }
  return items;
}

// Fallback: trouver /in/… puis parser /recent-activity/posts/
async function findLinkedInProfilesByName(name, max = 2) {
  const proxied = JINA(BING_WEB(`site:linkedin.com/in/ "${name}"`));
  try {
    const res = await timedFetch(proxied, { headers: { Accept: "text/plain" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    const links = [];
    for (const m of text.matchAll(/https:\/\/www\.linkedin\.com\/in\/[^\s")]+/g)) {
      const u = m[0].replace(/[\.,]$/, "");
      if (!links.includes(u)) links.push(u);
      if (links.length >= max) break;
    }
    return links;
  } catch (err) {
    console.error("findLinkedInProfilesByName error:", name, String(err).slice(0,160));
    return [];
  }
}

async function scrapeRecentPostsFromProfile(profileUrl, maxLinks = 10) {
  const proxied = JINA(`${profileUrl}/recent-activity/posts/`);
  try {
    const res = await timedFetch(proxied, { headers: { Accept: "text/plain" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    const links = Array.from(text.matchAll(/https:\/\/www\.linkedin\.com\/posts\/[^\s")]+/g)).map(m => m[0]);

    const seen = new Set(); const out = [];
    for (const u of links) {
      const key = normalizeUrl(u);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title: "Post LinkedIn",
        summary: "",
        link: u,
        dateISO: new Date().toISOString(),
        source: "LinkedIn Profile recent-activity",
      });
      if (out.length >= maxLinks) break;
    }
    return out;
  } catch (err) {
    console.error("scrapeRecentPostsFromProfile error:", profileUrl, String(err).slice(0,160));
    return [];
  }
}

/* ===== JFR+ (sans RSS) ===== */
// Parcourt la recherche filtrée sur le type "ec_news" (Actualités), pages 0..N.
// Utilise r.jina.ai pour obtenir un HTML "plat" sans JS.
const JFR_BASE = "https://www.jfr.plus";
const JFR_SEARCH_BASE = `${JFR_BASE}/recherche?f%5B0%5D=type-bundle%3Aec_news`;

function absolutizeJfr(u) {
  try {
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("//")) return `https:${u}`;
    if (u.startsWith("/")) return `${JFR_BASE}${u}`;
    return `${JFR_BASE}/${u}`;
  } catch { return u; }
}

function extractFirstDateISOFromHtml(html) {
  const pick = (re) => html.match(re)?.[1] || "";
  // 1) meta article:published_time
  const m1 = pick(/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i);
  if (m1) {
    const t = Date.parse(m1);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  // 2) <time datetime="...">
  const m2 = pick(/<time[^>]+datetime=["']([^"']+)["']/i);
  if (m2) {
    const t = Date.parse(m2);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  // 3) fallback: og:updated_time
  const m3 = pick(/<meta[^>]+property=["']og:updated_time["'][^>]*content=["']([^"']+)["']/i);
  if (m3) {
    const t = Date.parse(m3);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

async function fetchJfrArticleMeta(articleUrl) {
  try {
    const res = await timedFetch(JINA(articleUrl), { headers: { Accept: "text/html" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const html = await res.text();
    const { title, desc, image } = await fetchOgMeta(articleUrl);
    const dateISO = extractFirstDateISOFromHtml(html);
    // Si pas de titre OG, tenter <title>
    const titleFallback = title || cleanText(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "") || "Actualité JFR+";
    return { title: titleFallback, desc: desc || "", image: image || null, dateISO };
  } catch (err) {
    console.error("fetchJfrArticleMeta error:", articleUrl, String(err).slice(0,160));
    return { title: "Actualité JFR+", desc: "", image: null, dateISO: new Date().toISOString() };
  }
}

async function collectJFRPlus(raw, bump, maxPages = 3, maxPerPage = 40) {
  const found = new Set();
  for (let page = 0; page < maxPages; page++) {
    const url = page === 0 ? JFR_SEARCH_BASE : `${JFR_SEARCH_BASE}&page=${page}`;
    const proxied = JINA(url);
    try {
      const res = await timedFetch(proxied, { headers: { Accept: "text/plain" } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();

      // Récupère liens absolus et relatifs vers des pages d'actu
      const links = new Set();

      // Liens absolus jfr.plus
      for (const m of text.matchAll(/https?:\/\/(?:www\.)?jfr\.plus\/[^\s"')]+/gi)) {
        const u = m[0].replace(/[\.,]$/, "");
        if (!/\/recherche(\?|$)/i.test(u)) links.add(u);
        if (links.size >= maxPerPage) break;
      }
      // Liens relatifs
      for (const m of text.matchAll(/href=["'](\/[^"']+)["']/gi)) {
        const rel = m[1];
        // heuristique: actualités, jfr-20xx, node…
        if (/^\/(actualites|node|jfr-20\d{2}|.*ec_news)/i.test(rel)) {
          const abs = absolutizeJfr(rel);
          if (!/\/recherche(\?|$)/i.test(abs)) links.add(abs);
          if (links.size >= maxPerPage) break;
        }
      }

      let addedHere = 0;
      for (const u of links) {
        const key = normalizeUrl(u);
        if (found.has(key)) continue;
        found.add(key);

        const meta = await fetchJfrArticleMeta(u);
        raw.push({
          title: meta.title,
          summary: meta.desc,
          link: u,
          dateISO: meta.dateISO,
          source: "JFR+",
          image: meta.image || null,
        });
        addedHere++;
      }
      bump(`JFR+ page ${page}`, addedHere);
      // S’il n’y a presque rien, inutile d’aller plus loin
      if (addedHere === 0) break;
    } catch (err) {
      console.error("JFR+ fetch error:", url, String(err).slice(0,160));
      if (page === 0) break;
    }
  }
}

/* ===== FS ===== */
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

/* ===== MAIN ===== */
async function main() {
  ensureDirs();
  console.log(`[clearecondl] People: ${LINKEDIN_PEOPLE.join(", ")}`);
  console.log(`[clearecondl] YouTube: channel_ids=${YT_CHANNEL_IDS.join(", ")||"(none)"} users=${YT_USERS.join(", ")||"(none)"}`);

  const raw = [];
  const stats = new Map(); const bump = (k,n=1)=>stats.set(k,(stats.get(k)||0)+n);

  /* 0) YouTube (avant tout) */
  await collectYouTube(raw, bump);

  /* 0bis) JFR+ (Actualités) */
  await collectJFRPlus(raw, bump, /*maxPages=*/3);

  /* 1) Compléments (Search/News/Reddit) */
  for (const q of KEY_QUERIES) {
    for (const feed of SEARCH_FEEDS) {
      const url = feed.url.replace("{q}", encodeURIComponent(q));
      try {
        const entries = await fetchFeed(url);
        bump(feed.name, entries.length);
        for (const e of entries) raw.push(toItem(e, feed.name));
      } catch (err) {
        console.error("Feed error:", feed.name, url, String(err).slice(0, 160));
      }
    }
  }

  /* 2) LinkedIn — par personne (SERP Bing via r.jina.ai) */
  for (const person of LINKEDIN_PEOPLE) {
    const posts = await scrapeBingForLinkedInPosts(person, 12);
    bump(`LI SERP — ${person}`, posts.length);
    posts.forEach((it) => raw.push(it));

    if (posts.length === 0) {
      const profiles = await findLinkedInProfilesByName(person, 2);
      for (const p of profiles) {
        const rec = await scrapeRecentPostsFromProfile(p, 8);
        bump(`LI recent-activity — ${person}`, rec.length);
        rec.forEach((it) => raw.push(it));
      }
    }
  }

  console.log("[clearecondl] Raw counts by source:", Object.fromEntries([...stats.entries()].sort()));

  /* 3) Dé-dup brut */
  const prelim = [];
  const seen1 = new Set();
  for (const it of raw) {
    const key = normalizeUrl(it.link);
    if (seen1.has(key)) continue;
    seen1.add(key);
    prelim.push(it);
  }

  /* 4) Résolution URL finale + re-dédoublonnage */
  const resolved = [];
  for (const it of prelim) {
    const finalLink = needsResolve(it.link, it.source) ? await resolveFinalUrl(it.link) : it.link;
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

  /* 5) Filtrage final */
  const filtered = uniq.filter((it) => {
    const host = hostOf(it.link);
    const text = `${it.title || ""} ${it.summary || ""} ${it.link || ""}`;

    // JFR+ : on accepte tout ce qui vient du site officiel (Actualités)
    if (host.endsWith("jfr.plus")) return true;

    if (host.endsWith("linkedin.com")) {
      const cls = classifyLinkedIn(it.link);
      if (!(cls === "post" || cls === "profile-posts")) return false;
      // accepter si mot-clé OU personne OU découvert via SERP/recent-activity
      if (anyKeyMatch(text) || anyPersonMatch(text)) return true;
      if (/LinkedIn Profile recent-activity|Bing SERP \(LI post\)/.test(it.source)) return true;
      return false;
    }
    if (host.includes("youtube.com") || host === "youtu.be") return true;
    return anyKeyMatch(text);
  });

  /* 6) Tri chrono desc */
  filtered.sort((a, b) => new Date(b.dateISO).getTime() - new Date(a.dateISO).getTime());

  /* 7) Écriture */
  const already = readExisting();
  let created = 0;
  for (const it of filtered) {
    if (created >= MAX_ITEMS) break;
    const k = normalizeUrl(it.link);
    if (already.has(k)) continue;

    const d = new Date(it.dateISO);
    const base = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}-${slugify(it.title || "post", { lower: true, strict: true }).slice(0, 80)}`;

    // OG meta (avec proxy automatique pour linkedin)
    const meta = await fetchOgMeta(it.link);
    const imageUrl = it.image || meta.image || "";

    const fm = {
      title: it.title || meta.title || "Post",
      date: d.toISOString(),
      publishedDate: d.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" }),
      summary: it.summary || meta.desc || it.title || "",
      sourceUrl: it.link,
      permalink: `/clearecondl/${base}`,
      tags: ["CleareconDL", it.source],
      imageUrl,
      imageCredit: imageUrl ? `Image — ${it.link}` : "",
    };
    const body =
      (imageUrl ? `![${fm.title}](${imageUrl})\n\n` : "") +
      `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${it.link}\n`;

    for (const dir of OUT_DIRS) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${base}.md`), `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
    }
    created++;
  }

  console.log(`✅ CleaReconDL v2.4: ${created} créé(s) — pertinents: ${filtered.length} — bruts: ${raw.length} — uniq après redirection: ${uniq.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
