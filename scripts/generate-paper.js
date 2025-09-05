// scripts/generate-paper.js
import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";

const ARXIV_QUERY = "cat:cs.AI+OR+cat:cs.LG";
const MAX_RESULTS = 20;

async function fetchArxiv() {
  const url = `http://export.arxiv.org/api/query?search_query=${ARXIV_QUERY}&sortBy=submittedDate&sortOrder=descending&max_results=${MAX_RESULTS}`;
  const res = await fetch(url, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const entries = parsed.feed.entry || [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list.map((e) => ({
    id: e.id,
    title: (e.title || "").replace(/\n/g, " ").trim(),
    summary: (e.summary || "").replace(/\n/g, " ").trim(),
    authors: (Array.isArray(e.author) ? e.author : [e.author]).map((a) => a.name),
    updated: e.updated,
    published: e.published,
    link: Array.isArray(e.link) ? e.link.find((l) => l["$"].rel === "alternate")["$"].href : e.link["$"].href,
    categories: (Array.isArray(e.category) ? e.category : [e.category]).map((c) => c["$"].term),
  }));
}

function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return (
    Object.entries(frontmatter)
      .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.map((x) => `"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`))
      .join("\n") + "\n"
  );
}

async function main() {
  const papers = await fetchArxiv();
  if (!papers.length) throw new Error("Aucun papier arXiv trouvé.");
  const p = papers[0];

  const dateISO = p.published || p.updated;
  const date = new Date(dateISO);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const niceDate = `${yyyy}-${mm}-${dd}`;

  const title = p.title;
  const summary = p.summary.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  const importance = "";
  const tags = p.categories.slice(0, 5);

  const slug = `${niceDate}-${slugify(title, { lower: true, strict: true })}`;

  const frontmatter = {
    title,
    date: date.toISOString(),
    publishedDate: date.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" }),
    summary,
    importance,
    sourceUrl: p.link,
    tags,
    permalink: `/papers/${slug}`,
  };

  const md =
    `---\n${yaml(frontmatter)}---\n\n> ${p.authors.join(", ")}\n\n## TL;DR\n\n${summary}\n\n` +
    (importance ? `## Pourquoi c'est important\n\n${importance}\n\n` : "") +
    `## Abstract (arXiv)\n\n${p.summary}\n`;

  const outDir = path.join("src", "content", "papers");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug}.md`), md, "utf-8");
  console.log("✅ Généré:", slug);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
