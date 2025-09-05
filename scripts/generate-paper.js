// scripts/generate-paper.js
// Actu FR (Franceinfo) + image libre (Openverse) + frontmatter 100% FR

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

const FEED_URL = "https://www.franceinfo.fr/titres.rss";

/* --------- Utilitaires --------- */
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
  return String(htmlOrText)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    .filter(w => w.length >= 4 && !FR_STOP.has(w));
  const uniq = [...new Set(words)];
  return uniq.slice(0, 3).join(" ");
}

/* --------- Récupérer 1 actu FR --------- */
async function fetchFranceFeed() {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed.rss?.channel || parsed.feed;
  const entries = channel?.item || channel?.entry || [];
  return Array.isArray(entries) ? entries : [entries];
}

function pickFrenchNews(items) {
  const it = items[0];
  if (!it) return null;
  const title = cleanText(it.title);
  const summary = cleanText(it.description || it.summary);
  const link = it.link;
  const dateISO = it.pubDate || it.published || new Date().toISOString();
  return { title, summary, link, dateISO };
}

/* --------- Trouver une image libre --------- */
async function findImage(query) {
  const tryQueries = [
    query,
    keywordsFromTitle(query),
    "France actualité"
  ].filter(Boolean);

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
    } catch { /* noop */ }
  }
  return null;
}

/* --------- Programme principal --------- */
async function main() {
  const entries = await fetchFranceFeed();
  const p = pickFrenchNews(entries);
  if (!p) throw new Error("Aucune actualité trouvée.");

  const short = p.summary.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  const date = new Date(p.dateISO);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const niceDate = `${y}-${m}-${d}`;

  const img = await findImage(p.title);
  const title = p.title;
  const slug = `${niceDate}-${slugify(title, { lower: true, strict: true })}`;

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

  const md = `---\n${yaml(frontmatter)}---\n\n${body}`;
  const outDir = path.join("src", "content", "papers");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug}.md`), md, "utf-8");
  console.log("✅ Généré (actu France + photo si dispo):", slug, img ? "(avec image)" : "(pas d'image)");
}

main().catch((e) => { console.error(e); process.exit(1); });
