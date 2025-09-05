// scripts/generate-paper.js
// 2 actus FR (Franceinfo) + image libre (Openverse) + frontmatter 100% FR

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

const FEED_URL = "https://www.franceinfo.fr/titres.rss";
const ITEMS_PER_DAY = 2; // ← nombre d'actus à générer

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

/* --------- Flux France --------- */
async function fetchFranceFeed() {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed?.rss?.channel || parsed?.feed;
  const entries = channel?.item || channel?.entry || [];
  return (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
}

function toNewsItem(e) {
  const title = cleanText(e.title);
  const summary = cleanText(e.description || e.summary);
  const link = e.link;
  const dateISO = e.pubDate || e.published || new Date().toISOString();
  return { title, summary, link, dateISO };
}

/* --------- Image libre (Openverse) --------- */
async function findImage(query) {
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

/* --------- Programme principal --------- */
async function main() {
  const entries = await fetchFranceFeed();
  if (!entries.length) throw new Error("Aucune actualité trouvée.");

  // On prend les N premières actus du flux
  const picks = entries.slice(0, ITEMS_PER_DAY).map(toNewsItem);

  const outDir = path.join("src", "content", "papers");
  fs.mkdirSync(outDir, { recursive: true });

  let created = 0;

  for (const p of picks) {
    const short = p.summary.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    const date = new Date(p.dateISO);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    const niceDate = `${y}-${m}-${d}`;

    const title = p.title;
    const slug = `${niceDate}-${slugify(title, { lower: true, strict: true })}`;

    // Si le fichier existe déjà (même actu), on saute
    const target = path.join(outDir, `${slug}.md`);
    if (fs.existsSync(target)) {
      console.log("⏭️  Déjà présent, skip:", slug);
      continue;
    }

    const img = await findImage(title);

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
    fs.writeFileSync(target, md, "utf-8");
    created++;
    console.log(`✅ Généré: ${slug} ${img ? "(avec image)" : "(sans image)"}`);
  }

  if (created === 0) {
    console.log("Aucune nouvelle actu à générer aujourd'hui (doublons détectés).");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
