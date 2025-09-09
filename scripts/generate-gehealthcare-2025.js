// scripts/generate-gehealthcare-2025.js
// Indexe les vidéos 2025 de YouTube GE HealthCare et génère du Markdown pour la page (colonne droite)

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";
import { parseStringPromise } from "xml2js";

/* --- Config --- */
const CHANNEL_ID = "UC04R4GsgwjtoI28q7F3YrLw"; // GE HealthCare (officiel)
const YEAR = 2025;
const OUT_DIR = path.join("src", "content", "gehc2025"); // dossier dédié pour la colonne droite
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15000;

/* --- Utils --- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function timedFetch(url, opts = {}, retries = 2) {
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
function clean(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return (
    Object.entries(frontmatter)
      .map(([k, v]) =>
        Array.isArray(v)
          ? `${k}: [${v.map((x) => `"${esc(x)}"`).join(", ")}]`
          : `${k}: "${esc(v)}"`
      )
      .join("\n") + "\n"
  );
}
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

/* --- Écriture d'un item en .md --- */
function writeMarkdownItem(v) {
  ensureDir(OUT_DIR);
  const d = new Date(v.publishedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const slug = `${yyyy}-${mm}-${dd}-${slugify(v.title || "video", { lower: true, strict: true }).slice(0, 80)}`;
  const permalink = `/gehc2025/${slug}`;

  const fm = {
    title: v.title || "Video",
    date: d.toISOString(),
    publishedDate: d.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" }),
    summary: clean(v.description || v.title || ""),
    sourceUrl: `https://www.youtube.com/watch?v=${v.id}`,
    permalink,
    tags: ["YouTube", "GE HealthCare", String(YEAR)],
    imageUrl: v.thumbnail || "",
    imageCredit: v.thumbnail ? `Vignette — YouTube` : "",
  };

  const body =
    (fm.imageUrl ? `![${fm.title}](${fm.imageUrl})\n\n` : "") +
    `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${fm.sourceUrl}\n`;

  const file = path.join(OUT_DIR, `${slug}.md`);
  fs.writeFileSync(file, `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
  return file;
}

/* --- Collecte via YouTube Data API v3 (exhaustif) --- */
async function fetchAllVideosByApi() {
  const key = process.env.YT_API_KEY;
  if (!key) return null; // pas de clé => on laisse la voie RSS

  const publishedAfter = `${YEAR}-01-01T00:00:00Z`;
  const publishedBefore = `${YEAR + 1}-01-01T00:00:00Z`;
  const base = "https://www.googleapis.com/youtube/v3/search";
  const paramsBase = new URLSearchParams({
    key,
    part: "snippet",
    channelId: CHANNEL_ID,
    type: "video",
    order: "date",
    maxResults: "50",
    publishedAfter,
    publishedBefore,
  });

  const out = [];
  let pageToken = "";
  for (let guard = 0; guard < 50; guard++) {
    const url = `${base}?${paramsBase.toString()}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await timedFetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`YouTube API error ${res.status}: ${txt.slice(0, 180)}`);
    }
    const data = await res.json();
    for (const it of data.items || []) {
      const id = it.id?.videoId;
      const sn = it.snippet || {};
      if (!id || !sn.publishedAt) continue;
      const thumbs = sn.thumbnails || {};
      const thumb = thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || "";
      out.push({
        id,
        title: sn.title || "",
        description: sn.description || "",
        publishedAt: sn.publishedAt,
        thumbnail: thumb,
      });
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }

  return out.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

/* --- Fallback RSS (limité) --- */
async function fetchFromRss() {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const res = await timedFetch(url, { headers: { Accept: "application/rss+xml,text/xml;q=0.9,*/*;q=0.1" } });
  if (!res.ok) throw new Error(`RSS error ${res.status}`);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const feed = parsed?.feed;
  const entries = feed?.entry || [];
  const arr = Array.isArray(entries) ? entries : [entries].filter(Boolean);

  const items = [];
  for (const e of arr) {
    const id = e["yt:videoId"];
    const sn = {
      title: e.title,
      description: e["media:group"]?.["media:description"],
      publishedAt: e.published || e.updated,
      thumbnails: e["media:group"]?.["media:thumbnail"],
    };
    if (!id || !sn.publishedAt) continue;
    const d = new Date(sn.publishedAt);
    if (d.getUTCFullYear() !== YEAR) continue; // on ne garde que 2025

    let thumb = "";
    const tn = sn.thumbnails;
    if (Array.isArray(tn) && tn[0]?.$?.url) thumb = tn[0].$.url;
    else if (tn?.$?.url) thumb = tn.$.url;

    items.push({
      id,
      title: sn.title || "",
      description: sn.description || "",
      publishedAt: d.toISOString(),
      thumbnail: thumb,
    });
  }
  return items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

/* --- MAIN --- */
async function main() {
  ensureDir(OUT_DIR);
  let list = null;
  try {
    list = await fetchAllVideosByApi(); // tente API (exhaustif)
  } catch (e) {
    console.error("[YT] API Error, fallback to RSS:", String(e).slice(0, 200));
  }
  if (!list) {
    list = await fetchFromRss(); // fallback
  }

  if (!list.length) {
    console.log(`No videos found for ${YEAR}.`);
    return;
  }

  // Dé-dup par ID puis écriture
  const seen = new Set();
  let created = 0;
  for (const v of list) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const f = writeMarkdownItem(v);
    created++;
  }
  console.log(`✅ GEHC ${YEAR}: ${created} fichier(s) généré(s) → ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
