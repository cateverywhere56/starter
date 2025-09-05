// scripts/generate-paper.js
// 2 actus FR/jour, priorité à og:image, fallback Openverse (jusqu'à 8 résultats),
// dédoublonnage fort via normalisation d'URL (même image = 1 seule fois).

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";
import matter from "gray-matter";

const FEED_URL = "https://www.franceinfo.fr/titres.rss";
const ITEMS_PER_DAY = 4;

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

// normalise une URL d'image pour mieux détecter les doublons (on enlève la query/fragment)
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    return (url.origin + url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

// filtre rapide des mots vides FR pour améliorer les requêtes Openverse
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
  return uniq.slice(0, 4).join(" ");
}

function toNewsItem(e) {
  const title = cleanText(e.title);
  const summary = cleanText(e.description || e.summary);
  const link = e.link;
  const dateISO = e.pubDate || e.published || new Date().toISOString();
  return { title, summary, link, dateISO };
}

/* ---------- Images déjà présentes (anti-doublon inter-jours) ---------- */
function getExistingImageFingerprints() {
  const outDir = path.join("src", "content", "papers");
  const fps = new Set();
  if (!fs.existsSync(outDir)) return fps;
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(outDir, f), "utf-8");
    const { data } = matter(raw);
    if (data?.imageUrl) fps.add(normalizeUrl(String(data.imageUrl)));
  }
  return fps;
}

/* ---------- Récupérer l’og:image depuis la page source ---------- */
async function fetchOgImage(articleUrl) {
  try {
    const res = await fetch(articleUrl, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
    if (!res.ok) return null;
    const html = await res.text();

    const pickMeta = (re) => html.match(re)?.[1];
    const og = pickMeta(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const tw = pickMeta(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i);

    const candidates = [og, tw]
      .filter(Boolean)
      .map((u) => {
        try { return new URL(u, articleUrl).href; } catch { return null; }
      })
      .filter(Boolean);

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

/* ---------- Fallback Openverse avec plusieurs résultats (page_size=8) ---------- */
async function findImageOpenverse(query, avoidFP) {
  const variants = [query, keywordsFromTitle(query), "France actualité"].filter(Boolean);
  for (const q of variants) {
    try {
      const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial&page_size=8`;
      const res = await fetch(api, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
      if (!res.ok) continue;
      const data = await res.json();
      for (const it of (data.results || [])) {
        const url = it.url || it.thumbnail;
        if (!url) continue;
        const fp = normalizeUrl(url);
        if (avoidFP.has(fp)) continue; // déjà utilisée
        return {
          url,
          credit: `${it.creator ? it.creator : "Auteur inconnu"} — ${(it.license || "CC").toUpperCase()} via Openverse`,
          source: it.foreign_landing_url || it.url,
        };
      }
    } catch { /* ignore and try next variant */ }
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

  const existingFP = getExistingImageFingerprints();  // images déjà utilisées les jours précédents
  const usedThisRun = new Set();                      // images utilisées aujourd’hui

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

    // 1) og:image
    let img = await fetchOgImage(p.link);
    let fp = img?.url ? normalizeUrl(img.url) : null;

    // si doublon, on tente Openverse (plusieurs résultats)
    if (!img || (fp && (existingFP.has(fp) || usedThisRun.has(fp)))) {
      const alt = await findImageOpenverse(title, new Set([...existingFP, ...usedThisRun]));
      if (alt) {
        img = alt;
        fp = normalizeUrl(alt.url);
      } else if (fp && (existingFP.has(fp) || usedThisRun.has(fp))) {
        img = null; // mieux que dupliquer
        fp = null;
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
    console.log(`✅ Généré: ${slug} ${img ? `(image OK: ${fp})` : "(pas d'image)"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
