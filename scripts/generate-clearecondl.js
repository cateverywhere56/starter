// scripts/generate-clearecondl.js
// v2.1 — Auto-discovery (pas de seeds) : LinkedIn posts par personnes + YouTube @gehealthcare
// - LinkedIn: Bing Web RSS (site:linkedin.com/posts/ + site:linkedin.com/feed/update) par NOM
//             + fallback: découverte profil (/in/…) -> scrape recent-activity/posts/ via r.jina.ai -> collecte /posts/…
// - YouTube: handle @gehealthcare -> channel_id -> flux officiel + fallback user=gehealthcare
// - Redirections suivies, dédup, OG meta, backfill complet

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

/* -------- Config -------- */
const OUT_DIRS = [
  path.join("src", "content", "clearecondl"),
  path.join("src", "content", "cleareconDL"),
];

// Mots-clés généraux
const KEY_QUERIES = [
  `"CleaRecon DL"`, `"CleareconDL"`, `#clearecondl`,
  `"CleaRecon"`, `"Clearecon"`, `"Clear Recon DL"`, `"ClearEcon DL"`,
];

// Personnes LinkedIn à suivre (on trouve leurs posts automatiquement)
const LINKEDIN_PEOPLE = [
  "Charles Nutting",
  "Philip Rackliff",
  "Helene Zemb",
  "Benjamin Wimille",
  "Celine Lilonni",
  "Ashley Brown Harrison",
  "Ioanne Cartier",
];

// YouTube GE HealthCare (handle + fallback user)
const YT_HANDLES = ["@gehealthcare"];
const YT_USERS   = ["gehealthcare"]; // fallback
const YT_CHANNEL_IDS = [];           // ajoute d'éventuels UC… si besoin

// Pas de limite d’écriture
const MAX_ITEMS = Infinity;

/* -------- Feeds -------- */
// Bing Web (RSS) — utile pour LinkedIn (posts + profils)
const BING_WEB_RSS = (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`;

// Google News / Bing News / YouTube Search / Reddit (compléments)
const SEARCH_FEEDS = [
  { name: "Google News (web)",      url: "https://news.google.com/rss/search?q={q}&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (web)",        url: "https://www.bing.com/news/search?q={q}&format=RSS" },
  { name: "YouTube Search",         url: "https://www.youtube.com/feeds/videos.xml?search_query={q}" },
  { name: "Reddit",                 url: "https://www.reddit.com/search.rss?q={q}" },
];

/* -------- Utils -------- */
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;
const USER_AGENT = "clearecondl/2.1 (+https://github.com/)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
function cleanText(s = "") { return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function normalizeUrl(u) { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return String(u).toLowerCase(); } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter)
    .map(([k, v]) => Array.isArray(v) ? `${k}: [${v.map((x) => `"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`).join("\n") + "\n";
}

/* -------- RSS helpers -------- */
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

/* -------- Redirections -------- */
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

/* -------- OG meta -------- */
async function fetchOgMeta(articleUrl) {
  try {
    const res = await timedFetch(articleUrl, { headers: { Accept: "text/html" } });
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
  } catch { return { title: "", desc: "", image: null }; }
}

/* -------- Matching -------- */
const KEY_PATTERNS = [
  /\bclearecondl\b/i,
  /#\s*clearecondl\b/i,
  /\bclea\s*recon\s*dl\b/i,
  /\bclearecon\b/i,
  /\bclear\s*recon\b/i,
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
    if (p.startsWith("/company/")) return "company";
    if (p.startsWith("/jobs")) return "jobs";
    if (p.startsWith("/learning")) return "learning";
    if (p.startsWith("/pulse/")) return "pulse";
    return "other";
  } catch { return "none"; }
}
function isRelevant(it) {
  const host = hostOf(it.link);
  const text = `${it.title || ""} ${it.summary || ""} ${it.link || ""}`;

  if (host.endsWith("linkedin.com")) {
    const cls = classifyLinkedIn(it.link);
    if (!(cls === "post" || cls === "profile-posts")) return false;
    return anyKeyMatch(text) || anyPersonMatch(text) || true; // posts découverts automatiquement => OK
  }
  if (host.includes("youtube.com") || host === "youtu.be") return true;
  return anyKeyMatch(text);
}

/* -------- YouTube handle -> channel_id -------- */
async function resolveYouTubeChannelIdFromHandle(handle) {
  let h = handle.trim();
  if (!h.startsWith("@")) h = "@" + h;
  const url = `https://www.youtube.com/${encodeURIComponent(h)}`;
  try {
    const res = await timedFetch(url, { headers: { Accept: "text/html" } });
    if (!res.ok) throw new Error(String(res.status));
    const html = await res.text();
    let m = html.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/);
    if (m?.[1]) return m[1];
    m = html.match(/href="\/channel\/(UC[0-9A-Za-z_-]{22})"/);
    if (m?.[1]) return m[1];
    m = html.match(/property="og:url"[^>]+content="https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})"/i);
    if (m?.[1]) return m[1];
  } catch (e) {
    console.error("resolveYouTubeChannelIdFromHandle error:", handle, String(e).slice(0,160));
  }
  return null;
}

/* -------- LinkedIn discovery helpers -------- */
// 1) Cherche des POSTS LinkedIn via Bing Web RSS
async function searchLinkedInPostsByName(name) {
  const queries = [
    `site:linkedin.com/posts/ "${name}"`,
    `site:linkedin.com/feed/update "${name}"`,
  ];
  const items = [];
  for (const q of queries) {
    try {
      const arr = await fetchFeed(BING_WEB_RSS(q));
      for (const e of arr) items.push(toItem(e, `Bing Web (LI post) — ${name}`));
    } catch (err) {
      console.error("Bing Web (LI post) error:", name, q, String(err).slice(0,160));
    }
  }
  return items;
}

// 2) Si rien, trouve un profil /in/ et tente de scraper recent-activity/posts/
async function findLinkedInProfilesByName(name, max = 2) {
  const q = `site:linkedin.com/in/ "${name}"`;
  try {
    const arr = await fetchFeed(BING_WEB_RSS(q));
    const links = [];
    for (const e of arr) {
      const it = toItem(e, `Bing Web (LI profile) — ${name}`);
      if (it.link && /linkedin\.com\/in\//i.test(it.link)) links.push(it.link);
      if (links.length >= max) break;
    }
    return links;
  } catch (err) {
    console.error("Bing Web (LI profile) error:", name, String(err).slice(0,160));
    return [];
  }
}

async function scrapeRecentPostsFromProfile(profileUrl, maxLinks = 10) {
  // r.jina.ai renvoie une version textuelle du HTML -> on peut y retrouver des URLs /posts/…
  const proxied = `https://r.jina.ai/http://${profileUrl.replace(/^https?:\/\//,"")}/recent-activity/posts/`;
  try {
    const res = await timedFetch(proxied, { headers: { Accept: "text/plain" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    const links = Array.from(text.matchAll(/https:\/\/www\.linkedin\.com\/posts\/[^\s")]+/g)).map(m => m[0]);
    // dédup + coupe
    const seen = new Set(); const out = [];
    for (const u of links) {
      const key = normalizeUrl(u);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
      if (out.length >= maxLinks) break;
    }
    // map en items "simples" (on enrichira via OG meta à l’écriture)
    return out.map(link => ({
      title: "Post LinkedIn",
      summary: "",
      link,
      dateISO: new Date().toISOString(),
      source: "LinkedIn Profile recent-activity",
    }));
  } catch (err) {
    console.error("scrape recent-activity error:", profileUrl, String(err).slice(0,160));
    return [];
  }
}

/* -------- FS -------- */
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

/* -------- MAIN -------- */
async function main() {
  ensureDirs();
  console.log(`[clearecondl] People: ${LINKEDIN_PEOPLE.join(", ")}`);
  console.log(`[clearecondl] YT: handles=${YT_HANDLES.join(", ")||"(none)"} users=${YT_USERS.join(", ")||"(none)"} channels=${YT_CHANNEL_IDS.join(", ")||"(none)"}`);

  const raw = [];
  const stats = new Map(); const bump = (k,n=1)=>stats.set(k,(stats.get(k)||0)+n);

  /* 0) Recherche générale (YouTube Search / News / Reddit) */
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

  /* 1) LinkedIn — posts par personne (Bing Web RSS) */
  for (const person of LINKEDIN_PEOPLE) {
    const hits = await searchLinkedInPostsByName(person);
    bump(`LI posts (search) — ${person}`, hits.length);
    hits.forEach(it => raw.push(it));

    // fallback si rien trouvé : profil -> scrape recent-activity/posts/
    if (hits.length === 0) {
      const profiles = await findLinkedInProfilesByName(person, 2);
      for (const purl of profiles) {
        const posts = await scrapeRecentPostsFromProfile(purl, 8);
        bump(`LI posts (scrape) — ${person}`, posts.length);
        posts.forEach(it => raw.push(it));
      }
    }
  }

  /* 2) YouTube: users + channel_ids + handles -> channel_id */
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
  for (const h of YT_HANDLES) {
    const id = await resolveYouTubeChannelIdFromHandle(h);
    if (!id) { console.error("YT handle -> channel_id introuvable:", h); continue; }
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`;
    try {
      const entries = await fetchFeed(url);
      bump(`YouTube Handle: ${h} (${id})`, entries.length);
      for (const e of entries) raw.push(toItem(e, `YouTube Handle: ${h} (${id})`));
    } catch (err) {
      console.error("YouTube handle feed error:", h, String(err).slice(0, 160));
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

  /* 5) Filtrage final (posts LinkedIn / YouTube OK / autres = mots-clés) */
  const filtered = uniq.filter((it) => {
    const host = hostOf(it.link);
    const text = `${it.title || ""} ${it.summary || ""} ${it.link || ""}`;

    if (host.endsWith("linkedin.com")) {
      const cls = classifyLinkedIn(it.link);
      if (!(cls === "post" || cls === "profile-posts")) return false;
      // accepter : mots-clés OU nom de personne (les posts découverts automatiquement passent)
      if (anyKeyMatch(text) || anyPersonMatch(text)) return true;
      // si c'est venu du scrape recent-activity, on garde
      if (/LinkedIn Profile recent-activity/.test(it.source)) return true;
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
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const base = `${yyyy}-${mm}-${dd}-${slugify(it.title || "post", { lower: true, strict: true }).slice(0, 80)}`;
    const meta = await fetchOgMeta(it.link);
    const imageUrl = meta.image || null;

    const fm = {
      title: it.title || meta.title || "Post",
      date: d.toISOString(),
      publishedDate: d.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" }),
      summary: it.summary || meta.desc || it.title || "",
      sourceUrl: it.link,
      permalink: `/clearecondl/${base}`,
      tags: ["CleareconDL", it.source],
      imageUrl: imageUrl || "",
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

  console.log(`✅ CleaReconDL v2.1: ${created} créé(s) — pertinents: ${filtered.length} — bruts: ${raw.length} — uniq après redirection: ${uniq.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
