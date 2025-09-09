// scripts/generate-clearecondl.js
// v1.8 — CleaRecon DL column
// - LinkedIn persons: ajoute recherche SANS mots-clés (site:linkedin.com "Nom Prénom"), n'accepte que de vrais posts
// - YouTube: recherche + user=gehealthcare (+ YT_USERS / YT_CHANNEL_IDS via env)
// - Redirections suivies, dédup, logs par source

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

/* ---- CONFIG ---- */
const OUT_DIRS = [
  path.join("src", "content", "clearecondl"),
  path.join("src", "content", "cleareconDL"),
];

const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;
const USER_AGENT = "clearecondl/1.8 (+https://github.com/)";

// Mots-clés généraux
const KEY_QUERIES = [
  `"CleaRecon DL"`,
  `"CleareconDL"`,
  `#clearecondl`,
  `"CleaRecon"`,
  `"Clearecon"`,
  `"Clear Recon DL"`,
  `"ClearEcon DL"`
];

// ➕ Liste des personnes LinkedIn (ENV > défauts)
//   Fournis LINKEDIN_PEOPLE en repo variable/secret (séparateur: virgule, point-virgule, ou retour ligne)
const DEFAULT_LINKEDIN_PEOPLE = [
  "Charles Nutting",
  "Philip Rackliff",
  "Helene Zemb",
  "Benjamin Wimille",
  "Celine Lilonni",
  "Ashley Brown Harrison",
  "Ioanne Cartier",
];
function parsePeopleEnv(envVal, fallback) {
  if (!envVal || !envVal.trim()) return fallback;
  const parts = envVal.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const seen = new Set(); const out = [];
  for (const p of parts) { const k = norm(p); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out.length ? out : fallback;
}
const LINKEDIN_PEOPLE = parsePeopleEnv(process.env.LINKEDIN_PEOPLE, DEFAULT_LINKEDIN_PEOPLE);

// YouTube
const YT_DEFAULT_USERS = ["gehealthcare"]; // GE HealthCare
const YT_USERS = parsePeopleEnv(process.env.YT_USERS, YT_DEFAULT_USERS);
const YT_CHANNEL_IDS = (process.env.YT_CHANNEL_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

// LinkedIn entreprises (optionnel via RSSHub)
const RSSHUB_BASE = (process.env.RSSHUB_BASE || "").replace(/\/+$/, "");
const LINKEDIN_COMPANY_IDS = (process.env.LINKEDIN_COMPANY_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

// Limite écriture (optionnelle)
const MAX_ITEMS = parseInt(process.env.CLEARECONDL_MAX_ITEMS || "", 10) || Infinity;

/* ---- FEEDS ---- */
const SEARCH_FEEDS = [
  { name: "Google News (web)",      url: "https://news.google.com/rss/search?q={q}&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (web)",        url: "https://www.bing.com/news/search?q={q}&format=RSS" },
  { name: "Google News (LinkedIn)", url: "https://news.google.com/rss/search?q={q}+site%3Alinkedin.com&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (LinkedIn)",   url: "https://www.bing.com/news/search?q={q}+site%3Alinkedin.com&format=RSS" },
  { name: "YouTube Search",         url: "https://www.youtube.com/feeds/videos.xml?search_query={q}" },
  { name: "Reddit",                 url: "https://www.reddit.com/search.rss?q={q}" },
];

// LinkedIn PAR PERSONNE : 2 modes
//  A) ciblé = nom + mots-clés (déjà en place)
//  B) large = nom SEUL (sans mots-clés) — on filtrera en ne gardant que de vrais posts
const LI_PERSON_FEEDS_NARROW = [
  { name: "Google News (LI person+narrow)", url: "https://news.google.com/rss/search?q={q}+%22{person}%22+site%3Alinkedin.com&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (LI person+narrow)",   url: "https://www.bing.com/news/search?q={q}+%22{person}%22+site%3Alinkedin.com&format=RSS" },
];
const LI_PERSON_FEEDS_WIDE = [
  { name: "Google News (LI person+wide)", url: "https://news.google.com/rss/search?q=%22{person}%22+site%3Alinkedin.com&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (LI person+wide)",   url: "https://www.bing.com/news/search?q=%22{person}%22+site%3Alinkedin.com&format=RSS" },
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
function cleanText(s = "") { return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function normalizeUrl(u) { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return String(u).toLowerCase(); } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter)
    .map(([k, v]) => Array.isArray(v) ? `${k}: [${v.map((x) => `"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`).join("\n") + "\n";
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
    typeof e.link === "string" ? e.link :
    e.link?.href || (Array.isArray(e.link) ? e.link.find(x => x?.href)?.href || e.link[0] : null);
  const pageUrl = link || e.id || "";
  const summary = cleanText(e.description || e.summary || e.content?.["#text"] || e.content);
  const dateISO = (() => {
    const cand = e.pubDate || e.published || e.updated || e["dc:date"];
    const t = Date.parse(cand);
    return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
  })();
  return { title, summary, link: pageUrl, dateISO, source: sourceName };
}

/* ---- Redirections ---- */
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

/* ---- Image OG ---- */
async function fetchOgImage(articleUrl) {
  try {
    const res = await timedFetch(articleUrl, { headers: { Accept: "text/html" } });
    if (!res.ok) return null;
    const html = await res.text();
    const pick = (re) => html.match(re)?.[1];
    const og = pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const tw = pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i);
    const c = [og, tw].filter(Boolean).map(u => { try { return new URL(u, articleUrl).href; } catch { return null; } }).filter(Boolean);
    return c[0] || null;
  } catch { return null; }
}

/* ---- Matching ---- */
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

// Pertinence finale
function isRelevant(it) {
  const host = hostOf(it.link);
  const text = `${it.title || ""} ${it.summary || ""} ${it.link || ""}`;

  if (host.endsWith("linkedin.com")) {
    const cls = classifyLinkedIn(it.link);
    // Garder UNIQUEMENT des posts
    if (!(cls === "post" || cls === "profile-posts")) return false;
    // Autoriser si mot-clé OU personne ciblée
    return anyKeyMatch(text) || anyPersonMatch(text);
  }

  // YouTube: garder la recherche + users/chaînes
  if (host.includes("youtube.com") || host === "youtu.be") return true;

  // Autres: besoin d'un mot-clé
  return anyKeyMatch(text);
}

/* ---- FS ---- */
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

/* ---- MAIN ---- */
async function main() {
  ensureDirs();
  console.log(`[clearecondl] People: ${LINKEDIN_PEOPLE.length} -> ${LINKEDIN_PEOPLE.join(", ")}`);
  console.log(`[clearecondl] YT users: ${YT_USERS.join(", ") || "(none)"} | YT channels: ${YT_CHANNEL_IDS.join(", ") || "(none)"}`);
  const seenExisting = readExisting();

  const raw = [];
  const stats = new Map(); // sourceName -> count
  const bump = (name, n=1) => stats.set(name, (stats.get(name)||0)+n);

  // 1) Recherche générale (mots-clés)
  for (const q of KEY_QUERIES) {
    for (const feed of SEARCH_FEEDS) {
      const url = feed.url.replace("{q}", encodeURIComponent(q));
      try {
        const entries = await fetchFeed(url);
        bump(feed.name, entries.length);
        for (const e of entries) {
          const it = toItem(e, feed.name);
          if (it.title && it.link) raw.push(it);
        }
      } catch (err) {
        console.error("Feed error:", feed.name, url, String(err).slice(0, 160));
      }
    }
  }

  // 2) LinkedIn par personne : narrow (nom + mots-clés)
  for (const person of LINKEDIN_PEOPLE) {
    for (const q of KEY_QUERIES) {
      for (const feed of LI_PERSON_FEEDS_NARROW) {
        const url = feed.url.replace("{q}", encodeURIComponent(q)).replace("{person}", encodeURIComponent(person));
        try {
          const entries = await fetchFeed(url);
          bump(`${feed.name}`, entries.length);
          for (const e of entries) {
            const it = toItem(e, `${feed.name} — ${person}`);
            if (it.title && it.link) raw.push(it);
          }
        } catch (err) {
          console.error("LI person narrow error:", person, feed.name, String(err).slice(0, 160));
        }
      }
    }
  }

  // 3) LinkedIn par personne : WIDE (nom seul, pas de mots-clés)
  for (const person of LINKEDIN_PEOPLE) {
    for (const feed of LI_PERSON_FEEDS_WIDE) {
      const url = feed.url.replace("{person}", encodeURIComponent(person));
      try {
        const entries = await fetchFeed(url);
        bump(`${feed.name}`, entries.length);
        for (const e of entries) {
          const it = toItem(e, `${feed.name} — ${person}`);
          if (it.title && it.link) raw.push(it);
        }
      } catch (err) {
        console.error("LI person wide error:", person, feed.name, String(err).slice(0, 160));
      }
    }
  }

  // 4) YouTube: users + channel_ids
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

  // 5) LinkedIn via RSSHub (entreprises) — optionnel
  if (RSSHUB_BASE && LINKEDIN_COMPANY_IDS.length) {
    for (const id of LINKEDIN_COMPANY_IDS) {
      const url = `${RSSHUB_BASE}/linkedin/company/${encodeURIComponent(id)}/posts`;
      try {
        const entries = await fetchFeed(url);
        bump("LinkedIn (RSSHub)", entries.length);
        for (const e of entries) raw.push(toItem(e, "LinkedIn (RSSHub)"));
      } catch (err) {
        console.error("RSSHub LinkedIn error:", id, String(err).slice(0, 160));
      }
    }
  }

  console.log("[clearecondl] Raw counts by source:", Object.fromEntries([...stats.entries()].sort()));

  // 6) Dé-dup brut
  const prelim = [];
  const seen1 = new Set();
  for (const it of raw) {
    const key = normalizeUrl(it.link);
    if (seen1.has(key)) continue;
    seen1.add(key);
    prelim.push(it);
  }

  // 7) Résoudre URL finale si nécessaire + re-dédoublonner
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

  // 8) Filtrage (LinkedIn: posts only; YouTube: OK; autres: mots-clés)
  const filtered = uniq.filter(isRelevant);

  // 9) Tri chrono desc
  filtered.sort((a, b) => new Date(b.dateISO).getTime() - new Date(a.dateISO).getTime());

  // 10) Écriture
  let created = 0;
  for (const it of filtered) {
    if (created >= MAX_ITEMS) break;
    const k = normalizeUrl(it.link);
    if (readExisting().has(k)) continue; // re-lire au cas où une 2e dir a écrit

    const d = new Date(it.dateISO);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const base = `${yyyy}-${mm}-${dd}-${slugify(it.title, { lower: true, strict: true }).slice(0, 80)}`;
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

    for (const dir of OUT_DIRS) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${base}.md`), `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
    }
    created++;
  }

  console.log(`✅ CleaReconDL v1.8: ${created} créé(s) — pertinents: ${filtered.length} — bruts: ${raw.length} — uniq après redirection: ${uniq.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
