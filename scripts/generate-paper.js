// scripts/generate-paper.js
// 2 actus FR/jour, image prioritaire = og:image de l'article Franceinfo,
// fallback Openverse, et anti-doublons d'images.

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";
import matter from "gray-matter";

const FEED_URL = "https://www.franceinfo.fr/titres.rss";
const ITEMS_PER_DAY = 2;

/* ---------- Utils ---------- */
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

function cleanText(htmlOrText = "") {
  return String(htmlOrText).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
  const uniq = [...new Set(words)];
  return uniq.slice(0, 3).join(" ");
}

function toNewsItem(e) {
  const title = cleanText(e.title);
  const summary = cleanText(e.description || e.summary);
  const link = e.link;
  const dateISO = e.pubDate || e.published || new Date().toISOString();
  return { title, summary, link, dateISO };
}

/* ---------- Lire les images déjà présentes pour éviter les doublons ---------- */
function getExistingImageUrls() {
  const outDir = path.join("src", "content", "papers");
  const urls = new Set();
  if (!fs.existsSync(outDir)) return urls;
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(outDir, f), "utf-8");
    const { data } = matter(raw);
    if (data?.imageUrl) urls.add(String(data.imageUrl));
  }
  return urls;
}

/* ---------- Chercher l'og:image sur la page source ---------- */
async function fetchOgImage(articleUrl) {
  try {
    const res = await fetch(articleUrl, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
    if (!res.ok) return null;
    const html = await res.text();

    // og:image
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1];
    // twitter:image ou twitter:image:src
    const tw = html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i)?.[1];

    const candidates = [og, tw].filter(Boolean).map((u) => {
      try { return new URL(u, articleUrl).href; } catch { return null; }
    }).filter(Boolean);

    if (!candidates.length) return null;
    return {
      url: candidates[0],
      credit: "Franceinfo (image de l’article) — droits possiblement réservés",
      source: articleUrl,
    };
  } catch {
    return null;
  }
}

/* ---------- Fallback Openverse (CC) ---------- */
async function findImageOpenverse(query) {
  const tryQueries = [query, keywordsFromTitle(query), "France actualité"].filter(Boolean);
  for (const q of tryQueries) {
    try {
      const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial&page_size=1`;
      const res = await fetch(api, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
      if (!res.ok) continue;
      const data = await res.json();
      const it = (data.results || [])[0];
      if (!it) continue;
      return {
        url: it.url || it.thumbnail,
        credit: `${it.creator ? it.creator : "Auteur inconnu"} — ${(it.license || "CC").toUpperCase()} via Openverse`,
        source: it.foreign_landing_url || it.url,
      };
    } catch { /* ignore */ }
  }
  return null;
}

/* ---------- Flux France ---------- */
async function fetchFranceFeed() {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed?.rss?.channel || parsed?.feed;
  const entries = channel?.item || channel?.entry || [];
  return (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
}

/* ---------- Programme principal ---------- */
async function main() {
  const entries = await fetchFranceFeed();
  if (!entries.length) throw new Error("Aucune actualité trouvée.");

  const picks = entries.slice(0, ITEMS_PER_DAY).map(toNewsItem);

  const outDir = path.join("src", "content", "papers");
  fs.mkdirSync(outDir, { recursive: true });

  const existingImages = getExistingImageUrls();
  const usedThisRun = new Set(); // éviter doublons dans la même exécution

  for (const p of picks) {
    const short = p.summary.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    const date = new Date(p.dateISO);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    const niceDate = `${y}-${m}-${d}`;

    const title = p.title;
    const slug = `${niceDate}-${slugify(title, { lower: true, strict: true })}`;
    const target = path.join(outDir, `${slug}.md`);
    if (fs.existsSync(target)) {
      console.log("⏭️  Déjà présent, skip:", slug);
      continue;
    }

    // 1) Essayer l'image réelle de l'article (og:image)
    let img = await fetchOgImage(p.link);

    // Anti-doublons
    const isDup = (u) => u && (existingImages.has(u) || usedThisRun.has(u));

    if (!img || isDup(img.url)) {
      // 2) Fallback Openverse
      const alt = await findImageOpenverse(title);
      if (alt && !isDup(alt.url)) {
        img = alt;
      } else if (img && isDup(img.url)) {
        // si og:image existe mais déjà utilisée et pas d’alternative -> pas d'image
        img = null;
      }
    }

    if (img?.url) usedThisRun.add(img.url);

    const frontmatter = {
      title,
      date: date.toISOString(),
      publishedDate: date.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" }),
      summary: short,
      importance: "",
      sourceUrl: p.link,
      tags: ["France", "Actualité"],
      permalink: `/papers/${slug}`,
      imageUrl: img?.url || "",
      imageCredit: img ? `${img.credit}${img.source ? " — " + img.source : ""}` : ""
    };

    const body = [
      img?.url ? `![${title}](${img.url})\n` : "",
      img?.url && frontmatter.imageCredit ? `*Crédit image : ${frontmatter.imageCredit}*\n` : "",
      "## L’essentiel\n",
      short + "\n",
      "## Lien source\n",
      p.link + "\n"
    ].filter(Boolean).join("\n");

    fs.writeFileSync(target, `---\n${yaml(frontmatter)}---\n\n${body}`, "utf-8");
    console.log(`✅ Généré: ${slug} ${img ? "(image OK)" : "(pas d'image)"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
