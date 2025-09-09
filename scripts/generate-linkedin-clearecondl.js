// scripts/generate-linkedin-clearecondl.js
// v3 — Récupère des posts LinkedIn contenant : #cleareconDL | CleaRecon DL | CleaReconDL
// - Sources SERP: Bing + DuckDuckGo via r.jina.ai (pas d'accès direct à linkedin.com)
// - Pagination large (Bing: first=1..201 ; DDG: s=0..450)
// - Déduplication, enrichissement OG (proxy), écriture .md -> src/content/li-clearecondl

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import slugify from "slugify";

const OUT_DIR = path.join("src", "content", "li-clearecondl");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TIMEOUT = 15000;
const RETRIES = 2;

// Variantes de requêtes (les mots-clés sont dans la SERP)
const QUERY_VARIANTS = [
  '"#cleareconDL"',
  '"CleaRecon DL"',
  '"CleaReconDL"',
];

const BING_Q = (q, first = 1) =>
  `https://www.bing.com/search?q=${encodeURIComponent(`site:linkedin.com (${q})`)}&setlang=fr&count=50&first=${first}`;
const DDG_Q = (q, offset = 0) =>
  `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:linkedin.com ${q}`)}&s=${offset}`;
const JINA = (u) => `https://r.jina.ai/http://${u.replace(/^https?:\/\//, "")}`;

async function timedFetch(url, opts = {}, retries = RETRIES) {
  for (let i = 0; ; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...opts,
        headers: {
          "User-Agent": UA,
          "Accept-Language": "fr,fr-FR;q=0.9,en;q=0.8",
          ...(opts.headers || {}),
        },
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

// Regex élargie : http/https, sous-domaine éventuel, posts + plusieurs types d'URN
const LI_POST_RE =
  /(https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:posts\/[^\s"')<>]+|feed\/update\/urn:li:(?:activity|ugcPost|share):[0-9A-Za-z_-]+))/gi;

function isLikelyPost(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return (
      p.startsWith("/posts/") ||
      p.includes("/feed/update/urn:li:activity:") ||
      p.includes("/feed/update/urn:li:ugcpost:") ||
      p.includes("/feed/update/urn:li:share:")
    );
  } catch {
    return false;
  }
}

// Lecture OG via proxy (LinkedIn bloque en direct)
async function fetchOgMetaLinkedIn(url) {
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
  for (const q of QUERY_VARIANTS) {
    for (let first = 1; first <= 201; first += 50) {
      const url = JINA(BING_Q(q, first));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) {
          console.error(`[LI] Bing ${res.status} first=${first} q=${q}`);
          continue;
        }
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) {
          const u = m[1].replace(/[\.,]$/, "");
          if (isLikelyPost(u)) links.add(u);
        }
      } catch (e) {
        console.error("[LI] Bing error:", String(e).slice(0, 160));
      }
    }
  }
  return [...links];
}

async function collectFromDuckDuckGo() {
  const links = new Set();
  for (const q of QUERY_VARIANTS) {
    for (let s = 0; s <= 450; s += 50) {
      const url = JINA(DDG_Q(q, s));
      try {
        const res = await timedFetch(url, { headers: { Accept: "text/plain" } });
        if (!res.ok) {
          console.error(`[LI] DDG ${res.status} s=${s} q=${q}`);
          continue;
        }
        const text = await res.text();
        for (const m of text.matchAll(LI_POST_RE)) {
          const u = m[1].replace(/[\.,]$/, "");
          if (isLikelyPost(u)) links.add(u);
        }
      } catch (e) {
        console.error("[LI] DDG error:", String(e).slice(0, 160));
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
  const d = new Date(); // pas de date publique fiable
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
    summary: meta.desc || meta.title || "Publication LinkedIn",
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

  // 1) Collecte multi-moteurs
  const [bingLinks, ddgLinks] = await Promise.all([
    collectFromBing(),
    collectFromDuckDuckGo(),
  ]);
  const all = [...new Set([...bingLinks, ...ddgLinks])];
  console.log(`[LI] SERP total uniques: ${all.length} (Bing:${bingLinks.length} / DDG:${ddgLinks.length})`);

  if (!all.length) {
    console.log("[LI] Aucun lien trouvé via SERP. Vérifie que la page importe bien '../content/li-clearecondl/*.md'.");
    return;
  }

  // 2) Dédup global + enrichissement (sans filtrage OG strict)
  const seen = new Set();
  let created = 0;
  for (const link of all) {
    const key = normalizeUrl(link);
    if (seen.has(key) || existing.has(key)) continue;
    seen.add(key);

    let meta = { title: "", desc: "", image: null };
    try {
      meta = await fetchOgMetaLinkedIn(link);
    } catch (e) {
      // silencieux, on garde quand même
    }

    writeItem(link, meta);
    created++;
  }

  console.log(`✅ LinkedIn CleaReconDL: ${created} fichier(s) généré(s) → ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
