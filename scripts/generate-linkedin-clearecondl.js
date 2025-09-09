// scripts/generate-linkedin-clearecondl.js
// Récupère des posts LinkedIn contenant : #cleareconDL | CleaRecon DL | CleaReconDL
// Stratégie : SERP Bing (pages 1..201) via r.jina.ai → liens /posts/... ou /feed/update/urn:li:activity:...
// On NE REJETE PAS un post si l'OG LinkedIn est générique : on garde (car la SERP a déjà filtré par mots-clés).

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";

const OUT_DIR = path.join("src", "content", "li-clearecondl");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TIMEOUT = 15000;
const MAX_RETRIES = 2;

// Requêtes Bing (on multiplie les variantes)
const BING_QUERIES = [
  'site:linkedin.com/posts/ ("#cleareconDL" OR "CleaRecon DL" OR "CleaReconDL")',
  'site:linkedin.com/feed/update ("#cleareconDL" OR "CleaRecon DL" OR "CleaReconDL")',
  '"#cleareconDL" site:linkedin.com',
  '"CleaRecon DL" site:linkedin.com',
  '"CleaReconDL" site:linkedin.com',
];

const BING = (q, first = 1) =>
  `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=fr&first=${first}`;
const JINA = (u) => `https://r.jina.ai/http://${u.replace(/^https?:\/\//, "")}`;

async function timedFetch(url, opts = {}, retries = MAX_RETRIES) {
  for (let i = 0; ; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...opts,
        headers: { "User-Agent": UA, "Accept-Language": "fr,fr-FR;q=0.9,en;q=0.8", ...(opts.headers || {}) },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return res;
    } catch (e) {
      clearTimeout(t);
      if (i >= retries) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}
function clean(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(u || "").toLowerCase();
  }
}
function isPostUrl(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return p.startsWith("/posts/") || p.includes("/feed/update/urn:li:activity:");
  } catch {
    return false;
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

async function fetchOgMetaLinkedIn(url) {
  // Toujours via proxy (LinkedIn bloque autrement)
  const proxied = JINA(url);
  try {
    const res = await timedFetch(proxied, { headers: { Accept: "text/html" } });
    if (!res.ok) return { title: "", desc: "", image: null };
    const html = await res.text();
    const pick = (re) => html.match(re)?.[1] || "";
    const image = [
      /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
    ]
      .map((re) => pick(re))
      .map((u) => {
        try {
          return new URL(u, url).href;
        } catch {
          return "";
        }
      })
      .find(Boolean) || null;
    const title =
      pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || "";
    const desc =
      pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
      "";
    return { title: clean(title), desc: clean(desc), image };
  } catch {
    return { title: "", desc: "", image: null };
  }
}

async function collectFromBing() {
  const links = new Set();

  for (const q of BING_QUERIES) {
    // Paginer largement : first=1,11,21,...,201 (~20 pages) pour maximiser la couverture
    for (let first = 1; first <= 201; first += 10) {
      const url = JINA(BING(q, first));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) {
          console.error(`[LI] SERP ${res.status} first=${first} q=${q}`);
          continue;
        }
        const text = await res.text();

        for (const m of text.matchAll(
          /https:\/\/www\.linkedin\.com\/posts\/[^\s")]+/g
        )) {
          const u = m[0].replace(/[\.,]$/, "");
          if (isPostUrl(u)) links.add(u);
        }
        for (const m of text.matchAll(
          /https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:[0-9A-Za-z_-]+/g
        )) {
          links.add(m[0]);
        }
      } catch (e) {
        console.error("[LI] SERP error:", String(e).slice(0, 160));
      }
    }
  }

  return [...links];
}

function readExisting() {
  const seen = new Set();
  if (!fs.existsSync(OUT_DIR)) return seen;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.endsWith(".md")) continue;
    const txt = fs.readFileSync(path.join(OUT_DIR, f), "utf-8");
    const m = txt.match(/sourceUrl:\s*"([^"]+)"/);
    if (m) seen.add(normalizeUrl(m[1]));
  }
  return seen;
}

function writeItem(link, meta) {
  ensureDir(OUT_DIR);
  // Pas de date publique fiable → on timestamp à l’indexation
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const base = `${yyyy}-${mm}-${dd}-${slugify(meta.title || "post", {
    lower: true,
    strict: true,
  }).slice(0, 80)}`;
  const file = path.join(OUT_DIR, `${base}.md`);

  const fm = {
    title: meta.title || "Post LinkedIn",
    date: d.toISOString(),
    publishedDate: d.toLocaleDateString("fr-FR", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    summary: meta.desc || meta.title || "",
    sourceUrl: link,
    permalink: `/li-clearecondl/${base}`,
    tags: ["LinkedIn", "CleaReconDL"],
    imageUrl: meta.image || "",
    imageCredit: meta.image ? `Image — ${link}` : "",
  };

  const body =
    (fm.imageUrl ? `![${fm.title}](${fm.imageUrl})\n\n` : "") +
    `## Résumé\n\n${fm.summary}\n\n## Lien\n\n${link}\n`;

  fs.writeFileSync(file, `---\n${yaml(fm)}---\n\n${body}`, "utf-8");
  return file;
}

async function main() {
  ensureDir(OUT_DIR);
  const existing = readExisting();

  const rawLinks = await collectFromBing();
  console.log(`[LI] SERP liens bruts: ${rawLinks.length}`);

  if (!rawLinks.length) {
    console.log("[LI] Aucun lien trouvé via SERP.");
    return;
  }

  const seen = new Set();
  let created = 0;

  for (const link of rawLinks) {
    const key = normalizeUrl(link);
    if (seen.has(key) || existing.has(key)) continue;
    seen.add(key);

    // On tente d'enrichir (mais on n'exclut pas si méta vide)
    const meta = await fetchOgMetaLinkedIn(link);
    writeItem(link, meta);
    created++;
  }

  console.log(`✅ LinkedIn CleaReconDL: ${created} fichier(s) généré(s) → ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
