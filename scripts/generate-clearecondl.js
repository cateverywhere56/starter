// scripts/generate-clearecondl.js
// Colonne “CleaRecon DL / CleareconDL / #clearecondl” — backfill + filtre LinkedIn strict
// Sources : Google News (web + LinkedIn via site:), Bing News, YouTube Search (+ chaînes optionnelles),
//           Reddit (optionnel), LinkedIn via RSSHub (optionnel). Filtrage LinkedIn => ne garder que des POSTS.

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

/* ---- CONFIG ---- */
const OUT_DIR_MAIN = path.join("src", "content", "clearecondl"); // minuscule
const OUT_DIR_ALT  = path.join("src", "content", "cleareconDL"); // camel (si ta page l’utilise)
const OUT_DIRS = [OUT_DIR_MAIN, OUT_DIR_ALT];

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const USER_AGENT = "clearecondl/1.4 (+https://github.com/)";

// Variantes de mots-clés (insensibles à la casse côté moteurs)
const QUERIES = [
  `"CleaRecon DL"`,
  `"CleareconDL"`,
  `#clearecondl`,
  `"CleaRecon"`,
  `"Clearecon"`,
  `"Clear Recon DL"`,
  `"ClearEcon DL"`
];

// (Optionnel) YouTube : tu peux pinner des chaînes en plus de la recherche
const YT_CHANNEL_IDS = (process.env.YT_CHANNEL_IDS || "") // "UCxxxx,UCyyyy"
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// (Optionnel) LinkedIn via RSSHub (self-host conseillé).
// export RSSHUB_BASE="https://rsshub.example.com"
// export LINKEDIN_COMPANY_IDS="1337,2414183"
const RSSHUB_BASE = (process.env.RSSHUB_BASE || "").replace(/\/+$/, "");
const LINKEDIN_COMPANY_IDS = (process.env.LINKEDIN_COMPANY_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// (Optionnel) Limite max d’items écrits (sinon illimité)
const MAX_ITEMS = parseInt(process.env.CLEARECONDL_MAX_ITEMS || "", 10) || Infinity;

/* ---- SEARCH FEEDS ----
   {q} sera remplacé par encodeURIComponent(query)
*/
const SEARCH_FEEDS = [
  // Web (actu) — Google News et Bing News (les deux !)
  { name: "Google News (web)",   url: "https://news.google.com/rss/search?q={q}&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (web)",     url: "https://www.bing.com/news/search?q={q}&format=RSS" },

  // LinkedIn via Google/Bing (filtre domaine) — on filtrera ensuite côté URL
  { name: "Google News (LinkedIn)", url: "https://news.google.com/rss/search?q={q}+site%3Alinkedin.com&hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Bing News (LinkedIn)",   url: "https://www.bing.com/news/search?q={q}+site%3Alinkedin.com&format=RSS" },

  // YouTube : recherche (flux officiel)
  { name: "YouTube Search", url: "https://www.youtube.com/feeds/videos.xml?search_query={q}" },

  // Reddit (facultatif)
  { name: "Reddit", url: "https://www.reddit.com/search.rss?q={q}" },
];

/* ---- utils ---- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function timedFetch(url, opts = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
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

// RSS → items
async function fetchFeed(url) {
  const res = await timedFetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed?.rss?.channel || parsed?.feed;
  const raw = channel?.item || channel?.entry || [];
  const arr = Array.isArray(raw) ? raw : [raw].filter(Boolean);
  return arr;
}
function toItem(e, sourceName) {
  const title = cleanText(e.title?.["#text"] || e.title);
  const link =
    typeof e.link === "string"
      ? e.link
      : e.link?.href || (Array.isArray(e.link) ? e.link.find((x) => x?.href)?.href || e.link[0] : null);
  const pageUrl = link || e.id || "";
  const summary = cleanText(e.description || e.summary || e.content?.["#text"] || e.content);
  const dateISO = (() => {
    const cand = e.pubDate || e.published || e.updated || e["dc:date"];
    const t = Date.parse(cand);
    return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
  })();
  return { title, summary, link: pageUrl, dateISO, source: sourceName };
}

// og:image (simple)
async function fetchOgImage(articleUrl) {
  try {
    const res = await timedFetch(articleUrl, { headers: { Accept: "text/html" } });
    if (!res.ok) return null;
    const html = await res.text();
    const pick = (re) => html.match(re)?.[1];
    const og = pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const tw = pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i);
    const candidates = [og, tw]
      .filter(Boolean)
      .map((u) => { try { return new URL(u, articleUrl).href; } catch { return null; } })
      .filter(Boolean);
    return candidates[0] || null;
  } catch { return null; }
}

/* ---- Filtrage dur LinkedIn + mots-clés ---- */

// mots-clés stricts dans titre/summary/link
const STRICT_KEYWORD_RE = /\b(clearecondl|clea\s*recon\s*dl)\b/i;

function classifyLinkedIn(u) {
  try {
    const { pathname } = new URL(u);
    const p = pathname.toLowerCase();

    if (p.includes("/feed/update/urn:li:activity:")) return "post";
    if (p.startsWith("/posts/")) return "post"; // format /posts/<handle>_<id>...

    if (p.startsWith("/in/")) {
      // profil perso ; on évite sauf si sous-chemin "recent-activity" ou "posts"
      if (p.includes("/recent-activity/") || p.includes("/posts/")) return "profile-posts";
      return "profile";
    }

    if (p.startsWith("/company/"))  return "company";
    if (p.startsWith("/jobs"))      return "jobs";
    if (p.startsWith("/learning"))  return "learning";
    if (p.startsWith("/pulse/"))    return "pulse";
    if (p.startsWith("/school/"))   return "school";
    if (p.startsWith("/events/"))   return "events";
    if (p.startsWith("/showcase/")) return "showcase";

    return "other";
  } catch { return "none"; }
}

function isRelevantItem(it) {
  const text = `${it.title || ""} ${it.summary || ""}`.toLowerCase();
  // Vérif mots-clés (sécurité : certains moteurs renvoient du bruit)
  if (!STRICT_KEYWORD_RE.test(text) && !STRICT_KEYWORD_RE.test((it.link || "").toLowerCase())) {
    return false;
  }

  // Filtre spécifique LinkedIn
  const host = hostnameOf(it.link);
  if (host.endsWith("linkedin.com")) {
    const cls = classifyLinkedIn(it.link);
    // n’accepter que de vrais posts (ou pages "recent-activity/posts" d’un profil)
    if (!(cls === "post" || cls === "profile-posts")) return false;
  }
  return true;
}

function ensureDirs() {
  for (const d of OUT_DIRS) fs.mkdirSync(d, { recursive: true });
}
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

  const all = [];

  // 1) Google News / Bing News / YouTube Search / Reddit
  for (const q of QUERIES) {
    for (const feed of SEARCH_FEEDS) {
      const url = feed.url.replace("{q}", encodeURIComponent(q));
      try {
        const entries = await fetchFeed(url);
        for (const e of entries) {
          const it = toItem(e, feed.name);
          if (it.title && it.link) all.push(it);
        }
      } catch (err) {
        console.error("Feed error:", feed.name, url, String(err).slice(0, 160));
      }
    }
  }

  // 2) (Optionnel) YouTube : chaînes spécifiques
  for (const ch of YT_CHANNEL_IDS) {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch)}`;
    try {
      const entries = await fetchFeed(url);
      for (const e of entries) {
        const it = toItem(e, "YouTube Channel");
        if (it.title && it.link) all.push(it);
      }
    } catch (err) {
      console.error("YouTube channel feed error:", ch, String(err).slice(0, 160));
    }
  }

  // 3) (Optionnel) LinkedIn via RSSHub — posts de pages entreprise (lien pointe souvent vers linkedin.com)
  if (RSSHUB_BASE && LINKEDIN_COMPANY_IDS.length) {
    for (const id of LINKEDIN_COMPANY_IDS) {
      const url = `${RSSHUB_BASE}/linkedin/company/${encodeURIComponent(id)}/posts`;
      try {
        const entries = await fetchFeed(url);
        for (const e of entries) {
          const it = toItem(e, "LinkedIn (RSSHub)");
          if (it.title && it.link) all.push(it);
        }
      } catch (err) {
        console.error("RSSHub LinkedIn error:", id, String(err).slice(0, 160));
      }
    }
  }

  // Dé-dup (par lien normalisé)
  const uniq = [];
  const seenLinks = new Set();
  for (const it of all) {
    const key = normalizeUrl(it.link);
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    uniq.push(it);
  }

  // 🔎 Filtrage mots-clés + LinkedIn (posts uniquement)
  const filtered = uniq.filter(isRelevantItem);

  // Tri chrono desc
  filtered.sort((a, b) => new Date(b.dateISO).getTime() - new Date(a.dateISO).getTime());

  // Écriture des fichiers (dans les 2 dossiers)
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
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
    }
    created++;
  }

  console.log(`✅ CleaReconDL: ${created} fichier(s) ajouté(s) sur ${filtered.length} pertinents (sur ${uniq.length} uniques bruts).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
