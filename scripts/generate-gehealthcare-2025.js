// scripts/generate-gehealthcare-2025.js
// GE HealthCare @gehealthcare — vidéos 2025 → src/content/gehc2025/*.md
// Sans clé API: fallback RSS (liste limitée). Avec YT_API_KEY: exhaustif.

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";
import { parseStringPromise } from "xml2js";

const CHANNEL_ID = "UC04R4GsgwjtoI28q7F3YrLw"; // GE HealthCare (confirmé)
const YEAR = 2025;
const OUT_DIR = path.join("src", "content", "gehc2025");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TIMEOUT = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function timedFetch(url, opts = {}, retries = 2) {
  for (let i = 0; ; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...opts,
        headers: { "User-Agent": UA, ...(opts.headers || {}) },
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
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter)
    .map(([k, v]) => Array.isArray(v) ? `${k}: [${v.map((x) => `"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`).join("\n") + "\n";
}
function writeItem(v) {
  ensureDir(OUT_DIR);
  const d = new Date(v.publishedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth()+1).padStart(2,"0");
  const dd = String(d.getUTCDate()).padStart(2,"0");
  const slug = `${yyyy}-${mm}-${dd}-${slugify(v.title || "video",{lower:true,strict:true}).slice(0,80)}`;
  const permalink = `/gehc2025/${slug}`;
  const fm = {
    title: v.title || "Vidéo",
    date: d.toISOString(),
    publishedDate: d.toLocaleDateString("fr-FR", { year:"numeric", month:"long", day:"numeric" }),
    summary: clean(v.description || v.title || ""),
    sourceUrl: `https://www.youtube.com/watch?v=${v.id}`,
    permalink,
    tags: ["YouTube", "GE HealthCare", String(YEAR)],
    imageUrl: v.thumbnail || "",
    imageCredit: v.thumbnail ? "Vignette — YouTube" : ""
  };
  const body = (fm.imageUrl ? `![${fm.title}](${fm.imageUrl})\n\n` : "") +
               `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${fm.sourceUrl}\n`;
  const file = path.join(OUT_DIR, `${slug}.md`);
  fs.writeFileSync(file, `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
  return file;
}

/* API v3 = exhaustif si YT_API_KEY présent */
async function fetchByApi() {
  const key = process.env.YT_API_KEY;
  if (!key) return null;
  const base = "https://www.googleapis.com/youtube/v3/search";
  const params = new URLSearchParams({
    key, part:"snippet", channelId:CHANNEL_ID, type:"video", order:"date", maxResults:"50",
    publishedAfter:`${YEAR}-01-01T00:00:00Z`, publishedBefore:`${YEAR+1}-01-01T00:00:00Z`
  });
  const out = [];
  let pageToken = "";
  let pages = 0;
  while (true) {
    const url = `${base}?${params.toString()}${pageToken?`&pageToken=${pageToken}`:""}`;
    const res = await timedFetch(url);
    if (!res.ok) throw new Error(`YouTube API ${res.status}`);
    const data = await res.json();
    for (const it of data.items || []) {
      const id = it.id?.videoId;
      const sn = it.snippet || {};
      if (!id || !sn.publishedAt) continue;
      const thumbs = sn.thumbnails || {};
      const thumb = thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || "";
      out.push({ id, title: sn.title || "", description: sn.description || "", publishedAt: sn.publishedAt, thumbnail: thumb });
    }
    pages++;
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  console.log(`[GEHC2025] API: ${out.length} vidéos, ${pages} page(s).`);
  return out.sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
}

/* RSS fallback (limité aux derniers items) */
async function fetchByRss() {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const res = await timedFetch(url, { headers: { Accept:"application/rss+xml,text/xml;q=0.9,*/*;q=0.1" } });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray:false });
  const feed = parsed?.feed;
  const entries = feed?.entry || [];
  const arr = Array.isArray(entries) ? entries : [entries].filter(Boolean);
  console.log(`[GEHC2025] RSS: ${arr.length} entrées brutes.`);

  const items = [];
  for (const e of arr) {
    const id = e["yt:videoId"];
    const title = e.title || "";
    const published = e.published || e.updated;
    if (!id || !published) continue;
    const d = new Date(published);
    const year = d.getUTCFullYear();
    // garde 2025 uniquement
    if (year !== YEAR) continue;

    // thumbnail (plusieurs formes possibles)
    let thumb = "";
    const grp = e["media:group"] || {};
    const tn = grp["media:thumbnail"];
    if (Array.isArray(tn)) {
      thumb = tn.find(x => x?.$?.url)?.$?.url || tn[0]?.$?.url || "";
    } else if (tn?.$?.url) {
      thumb = tn.$.url;
    }

    const desc = grp["media:description"] || "";
    items.push({ id, title, description: desc, publishedAt: d.toISOString(), thumbnail: thumb });
  }
  console.log(`[GEHC2025] RSS → 2025: ${items.length} vidéo(s).`);
  return items.sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
}

async function main() {
  ensureDir(OUT_DIR);
  let list = null;
  try {
    list = await fetchByApi();
  } catch (e) {
    console.error("[GEHC2025] API error:", String(e).slice(0,200));
  }
  if (!list) {
    try {
      list = await fetchByRss();
    } catch (e) {
      console.error("[GEHC2025] RSS error:", String(e).slice(0,200));
      list = [];
    }
  }

  if (!list.length) {
    console.log(`[GEHC2025] Aucune vidéo 2025 trouvée (API=${!!process.env.YT_API_KEY}, RSS fallback).`);
    return;
  }

  // Dé-dup par ID et écriture
  const seen = new Set(); let created = 0;
  for (const v of list) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const file = writeItem(v);
    created++;
    console.log(`+ ${v.publishedAt.slice(0,10)} — ${v.title}  → ${path.basename(file)}`);
  }
  console.log(`✅ GEHC ${YEAR}: ${created} fichier(s) généré(s) dans ${OUT_DIR}`);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
