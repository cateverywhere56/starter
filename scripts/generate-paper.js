// scripts/generate-paper.js
import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

// 1) Source d'actualité FR (RSS Franceinfo — titres du jour)
const FEED_URL = "https://www.franceinfo.fr/titres.rss"; // vérifié publiquement :contentReference[oaicite:0]{index=0}

// 2) Image libre via Openverse (Creative Commons)
async function findImage(query) {
  try {
    const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(
      query
    )}&license_type=commercial&page_size=1`;
    const res = await fetch(api, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
    if (!res.ok) return null;
    const data = await res.json();
    const it = (data.results || [])[0];
    if (!it) return null;
    return {
      url: it.url || it.thumbnail,
      credit: `${it.creator ? it.creator : "Auteur inconnu"} — ${it.license?.toUpperCase() || "CC"} via Openverse`,
      source: it.foreign_landing_url || it.url,
    };
  } catch {
    return null;
  }
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

function pickFrenchNews(items) {
  // On prend le 1er item récent du flux (Franceinfo est FR et très France)
  // et on nettoie le texte.
  const it = items[0];
  if (!it) return null;
  const title = (it.title || "").replace(/\s+/g, " ").trim();
  const summary = ((it.description || it.summary || "") + "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const link = it.link;
  const dateISO = it.pubDate || it.published || new Date().toISOString();
  return { title, summary, link, dateISO };
}

async function fetchFranceFeed() {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed.rss?.channel || parsed.feed;
  const entries = channel?.item || channel?.entry || [];
  return Array.isArray(entries) ? entries : [entries];
}

async function main() {
  const entries = await fetchFranceFeed();
  const p = pickFrenchNews(entries);
  if (!p) throw new Error("Aucune actu trouvée.");

  // Résumé court en FR (fallback : 2 phrases max)
  const short = p.summary.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  const date = new Date(p.dateISO);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const niceDate = `${yyyy}-${mm}-${dd}`;

  // Image libre
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

  const bodyLines = [];
  if (img?.url) {
    bodyLines.push(`![${title}](${img.url})`);
    bodyLines.push("");
    bodyLines.push(`*Crédit image : ${frontmatter.imageCredit}*`);
    bodyLines.push("");
  }
  bodyLines.push("## TL;DR");
  bodyLines.push("");
  bodyLines.push(short);
  bodyLines.push("");
  bodyLines.push("## Lien source");
  bodyLines.push("");
  bodyLines.push(p.link);

  const md = `---\n${yaml(frontmatter)}---\n\n${bodyLines.join("\n")}\n`;

  const outDir = path.join("src", "content", "papers");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug}.md`), md, "utf-8");
  console.log("✅ Généré (actu France + photo libre):", slug);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
