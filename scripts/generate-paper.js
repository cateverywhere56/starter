// scripts/generate-paper.js
// Mix FR (plusieurs flux) • N actus/jour • image = og:image si possible, sinon Openverse
// Dé-duplication forte des images + variété des sources.

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";
import matter from "gray-matter";

/* ---- CONFIG ---- */
const ITEMS_PER_DAY = 1; // ← UNE actu par exécution (toutes les 15 min)

const OPENVERSE_PAGE_SIZE = 12;          // nb de candidates image à tester
const FEEDS = [
  { name: "Franceinfo", url: "https://www.francetvinfo.fr/titres.rss" },
  { name: "France 24",  url: "https://www.france24.com/fr/rss" },
  { name: "RFI",        url: "https://www.rfi.fr/fr/france/rss" },
  { name: "20 Minutes", url: "http://www.20minutes.fr/rss/une.xml" },
  { name: "Ouest-France", url: "https://www.ouest-france.fr/rss-en-continu.xml" },
  { name: "Le Monde",   url: "https://www.lemonde.fr/rss/une.xml" },
];

/* ---- Utils ---- */
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
function cleanText(s = "") {
  return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch { return String(u).toLowerCase(); }
}
const FR_STOP = new Set([
  "le","la","les","un","une","des","de","du","d","l","au","aux","à","a",
  "en","et","ou","où","sur","dans","par","pour","avec","sans","vers","chez",
  "ce","cet","cette","ces","son","sa","ses","leur","leurs","plus","moins",
  "est","sont","été","etre","être","sera","seront","auxquels","auxquelles"
]);
function keywordsFromTitle(title) {
  const words = title
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !FR_STOP.has(w));
  return [...new Set(words)].slice(0, 4).join(" ");
}

/* ---- RSS → entries ---- */
async function fetchFeed(url) {
  const res = await fetch(url, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed?.rss?.channel || parsed?.feed;
  const raw = channel?.item || channel?.entry || [];
  return Array.isArray(raw) ? raw : [raw];
}
function toItem(e, sourceName) {
  const title = cleanText(e.title);
  const summary = cleanText(e.description || e.summary || e.content);
  const link = e.link?.href || e.link;
  const dateISO = e.pubDate || e.published || e.updated || new Date().toISOString();
  return { title, summary, link, dateISO, source: sourceName };
}

/* ---- Images existantes (anti-doublon inter-jours) ---- */
function getExistingImageFPs() {
  const dir = path.join("src", "content", "papers");
  const set = new Set();
  if (!fs.existsSync(dir)) return set;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(dir, f), "utf-8");
    const { data } = matter(raw);
    if (data?.imageUrl) set.add(normalizeUrl(String(data.imageUrl)));
  }
  return set;
}

/* ---- og:image de l’article ---- */
async function fetchOgImage(articleUrl) {
  try {
    const res = await fetch(articleUrl, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
    if (!res.ok) return null;
    const html = await res.text();
    const pick = (re) => html.match(re)?.[1];
    const og = pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const tw = pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i);
    const candidates = [og, tw].filter(Boolean).map((u) => { try { return new URL(u, articleUrl).href; } catch { return null; } }).filter(Boolean);
    if (!candidates.length) return null;
    return { url: candidates[0], credit: "Image de l’article — droits possiblement réservés", source: articleUrl };
  } catch { return null; }
}

/* ---- Fallback Openverse (plusieurs résultats) ---- */
async function findImageOpenverse(query, avoidFP) {
  const variants = [query, keywordsFromTitle(query), "France actualité"].filter(Boolean);
  for (const q of variants) {
    try {
      const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial&page_size=${OPENVERSE_PAGE_SIZE}`;
      const res = await fetch(api, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
      if (!res.ok) continue;
      const data = await res.json();
      for (const it of (data.results || [])) {
        const url = it.url || it.thumbnail;
        if (!url) continue;
        const fp = normalizeUrl(url);
        if (avoidFP.has(fp)) continue;
        return {
          url,
          credit: `${it.creator ? it.creator : "Auteur inconnu"} — ${(it.license || "CC").toUpperCase()} via Openverse`,
          source: it.foreign_landing_url || it.url,
        };
      }
    } catch { /* try next variant */ }
  }
  return null;
}

/* ---- Sélection mixte (variété de sources) ---- */
function pickMixed(items, count) {
  // tri anti-ancien
  items.sort((a, b) => new Date(b.dateISO).getTime() - new Date(a.dateISO).getTime());
  // index par source
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }
  // round-robin : 1 par source jusqu’à count
  const picks = [];
  const sources = [...bySource.keys()];
  let idx = 0;
  while (picks.length < count && sources.length) {
    const s = sources[idx % sources.length];
    const arr = bySource.get(s);
    const next = arr?.shift();
    if (next) {
      picks.push(next);
      if (!arr.length) {
        bySource.delete(s);
        sources.splice(idx % sources.length, 1);
        if (!sources.length) break;
        idx = idx % sources.length;
        continue;
      }
      idx++;
    } else {
      bySource.delete(s);
      sources.splice(idx % sources.length, 1);
    }
  }
  // si pas assez, on remplit avec le flux global trié
  if (picks.length < count) {
    const pickedSet = new Set(picks.map((x) => x.link));
    for (const it of items) {
      if (picks.length >= count) break;
      if (!pickedSet.has(it.link)) {
        picks.push(it);
        pickedSet.add(it.link);
      }
    }
  }
  return picks.slice(0, count);
}

/* ---- MAIN ---- */
async function main() {
  // 1) Charger tous les flux + uniformiser les items
  const all = [];
  for (const f of FEEDS) {
    try {
      const entries = await fetchFeed(f.url);
      for (const e of entries) {
        const item = toItem(e, f.name);
        if (item.title && item.link) all.push(item);
      }
    } catch (err) {
      console.error("Feed error:", f.name, f.url, String(err).slice(0, 120));
    }
  }

  if (!all.length) throw new Error("Aucune actualité trouvée sur les flux configurés.");

  // 2) Dé-dup des articles (même lien normalisé)
  const seenLinks = new Set();
  const unique = [];
  for (const it of all) {
    const key = normalizeUrl(it.link);
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    unique.push(it);
  }

  // 3) Sélection variée
  const picks = pickMixed(unique, ITEMS_PER_DAY);

  // 4) Sortie
  const outDir = path.join("src", "content", "papers");
  fs.mkdirSync(outDir, { recursive: true });

  const existingFP = getExistingImageFPs();
  const usedThisRun = new Set();

  for (const p of picks) {
    const short = cleanText(p.summary).split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    const date = new Date(p.dateISO);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const niceDate = `${yyyy}-${mm}-${dd}`;

    const title = p.title;
    const slug = `${niceDate}-${slugify(title, { lower: true, strict: true })}`;
    const target = path.join(outDir, `${slug}.md`);
    if (fs.existsSync(target)) {
      console.log("⏭️  Déjà présent, skip:", slug);
      continue;
    }

    // image: og:image -> fallback Openverse
    let img = await fetchOgImage(p.link);
    let fp = img?.url ? normalizeUrl(img.url) : null;
    if (!img || (fp && (existingFP.has(fp) || usedThisRun.has(fp)))) {
      const alt = await findImageOpenverse(title, new Set([...existingFP, ...usedThisRun]));
      if (alt) {
        img = alt;
        fp = normalizeUrl(alt.url);
      } else if (fp && (existingFP.has(fp) || usedThisRun.has(fp))) {
        img = null; fp = null;
      }
    }
    if (fp) usedThisRun.add(fp);

    const frontmatter = {
      title,
      date: date.toISOString(),
      publishedDate: date.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" }),
      summary: short,
      importance: "",
      sourceUrl: p.link,
      tags: ["France", "Actualité", p.source],
      permalink: `/papers/${slug}`,
      imageUrl: img?.url || "",
      imageCredit: img ? `${img.credit}${img.source ? " — " + img.source : ""}` : ""
    };

    const body =
      (img?.url ? `![${title}](${img.url})\n\n${frontmatter.imageCredit ? `*Crédit image : ${frontmatter.imageCredit}*\n\n` : ""}` : "") +
      `## L’essentiel\n\n${short}\n\n## Lien source\n\n${p.link}\n`;

    fs.writeFileSync(target, `---\n${yaml(frontmatter)}---\n\n${body}`, "utf-8");
    console.log(`✅ Généré: ${slug} ${img ? "(image OK)" : "(pas d'image)"} — ${p.source}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
