// scripts/generate-paper.js
// Flux mixte FR • 1 actu par exécution (toutes les 15 min).
// Choisit la 1ʳᵉ actu NON PUBLIÉE.
// Image = og:image de l’article si possible (même si déjà vue ailleurs).
// Fallback Openverse filtré + anti-doublons (Openverse seulement).

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";
import matter from "gray-matter";

/* ---- CONFIG ---- */
const ITEMS_PER_RUN = 1;
const OPENVERSE_PAGE_SIZE = 12;

const FEEDS = [
  /* Développement & recherche */
  { name: "ASME — Journal of Medical Devices (current)", url: "https://asmedigitalcollection.asme.org/medicaldevices/rss/current" },
  // JSCAI (Elsevier/ScienceDirect) — flux journal (ISSN 2772-9303)
  { name: "JSCAI — Journal of the Society for Cardiovascular Angiography & Interventions", url: "https://rss.sciencedirect.com/publication/science/2772-9303" },

  /* Radiologie interventionnelle */
  { name: "SIR — IR Quarterly (news/podcast)", url: "https://irq.sirweb.org/feed/" },

  /* Neuro-intervention */
  { name: "Journal of NeuroInterventional Surgery — Current", url: "https://jnis.bmj.com/rss/current.xml" },

  /* News spécialisées (BIBA Medical) */
  { name: "Vascular News — Latest", url: "https://vascularnews.com/feed/" },
  { name: "Cardiovascular News — Latest", url: "https://cardiovascularnews.com/feed/" },
  { name: "Interventional News — Latest", url: "https://interventionalnews.com/feed/" },

  /* Acteurs industriels (ex. Medtronic) — flux officiels par portefeuille */
  { name: "Medtronic — Press releases (All)",    url: "https://news.medtronic.com/rss?rsspage=20295" },
  { name: "Medtronic — Cardiovascular",          url: "https://news.medtronic.com/rss?rsspage=20299" },
  { name: "Medtronic — Neuroscience",            url: "https://news.medtronic.com/rss?rsspage=20300" },
  { name: "Medtronic — Diabetes",                url: "https://news.medtronic.com/rss?rsspage=20297" },
  { name: "Medtronic — Corporate",               url: "https://news.medtronic.com/rss?rsspage=20296" },

  /* Technologie interventionnelle (NIBIB) */
  { name: "NIBIB — News",   url: "https://www.nibib.nih.gov/news-events/rss.xml" },
  { name: "NIBIB — Events", url: "https://www.nibib.nih.gov/news-events/events/rss.xml" },

  /* === AJOUTS demandés === */

  // 1) Stroke & Vascular Neurology (BMJ) — flux officiel
  { name: "SVN (BMJ) — Recent issues", url: "https://svn.bmj.com/rss/recent.xml" },

  // 2) EuroIntervention (PCR) — pas de flux RSS public détecté
  // 👉 Alternative: s’inscrire à la newsletter EuroIntervention / PCR
  //    ou surveiller les pages “Issues” via un watcher (distill.io, etc.)
  // { name: "EuroIntervention — Latest (no RSS)", url: "https://eurointervention.pcronline.com/" },

    // 4) PubMed Central (PMC) — flux “news/updates” + préférer des flux par recherche PubMed (RSS)
  //    News PMC (via NCBI Insights, catégorie PMC)
  { name: "PMC — News & updates", url: "https://ncbiinsights.ncbi.nlm.nih.gov/tag/pmc/feed/" },
  //    Pour du contenu scientifique ciblé, crée un RSS via PubMed (Saved Search → Create RSS)
  //    Exemple (interventional cardiology): https://pubmed.ncbi.nlm.nih.gov/?term=interventional+cardiology&filter=datesearch.y_5&size=50  -> Create RSS
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
  } catch {
    return String(u).toLowerCase();
  }
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
    const candidates = [og, tw]
      .filter(Boolean)
      .map((u) => { try { return new URL(u, articleUrl).href; } catch { return null; } })
      .filter(Boolean);
    if (!candidates.length) return null;
    return { url: candidates[0], credit: "Image de l’article — droits possiblement réservés", source: articleUrl };
  } catch {
    return null;
  }
}

/* ---- Filtres Openverse (pertinence) ---- */
const BAD_WORDS = [
  "meme","poster","flyer","banner","logo","icon","clipart","wallpaper",
  "quote","typography","infographic","chart","graph","diagram","vector",
  "illustration","ai generated","prompt","template"
];
const PREFERRED_PROVIDERS = new Set(["wikimedia", "flickr"]);
function looksBad(str = "", tags = []) {
  const s = (str || "").toLowerCase();
  if (BAD_WORDS.some(w => s.includes(w))) return true;
  const tagText = (tags || []).map(t => (t.name || t.title || t).toString().toLowerCase()).join(" ");
  if (BAD_WORDS.some(w => tagText.includes(w))) return true;
  return false;
}

/* ---- Fallback Openverse (plusieurs résultats filtrés) ---- */
async function findImageOpenverse(query, avoidFP) {
  const variants = [query, keywordsFromTitle(query), "France actualité"].filter(Boolean);

  for (const q of variants) {
    try {
      const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial&page_size=${OPENVERSE_PAGE_SIZE}`;
      const res = await fetch(api, { headers: { "User-Agent": "paper-du-jour (+https://github.com/)" } });
      if (!res.ok) continue;
      const data = await res.json();

      let results = (data.results || []).filter(it => {
        const url = it.url || it.thumbnail;
        if (!url) return false;
        if (looksBad(it.title, it.tags)) return false;
        if (it.category && String(it.category).toLowerCase() !== "photograph") return false;
        if (it.width && it.height && (it.width < 600 || it.height < 400)) return false;
        const fp = normalizeUrl(url);
        if (avoidFP.has(fp)) return false;
        return true;
      });

      // Priorité aux providers photo fiables
      results.sort((a, b) => {
        const ap = PREFERRED_PROVIDERS.has(String(a.provider).toLowerCase()) ? 0 : 1;
        const bp = PREFERRED_PROVIDERS.has(String(b.provider).toLowerCase()) ? 0 : 1;
        return ap - bp;
      });

      const it = results[0];
      if (it) {
        const url = it.url || it.thumbnail;
        return {
          url,
          credit: `${it.creator ? it.creator : "Auteur inconnu"} — ${(it.license || "CC").toUpperCase()} via Openverse`,
          source: it.foreign_landing_url || it.url,
        };
      }
    } catch {
      // on essaie la variante suivante
    }
  }
  return null;
}

/* ---- Sélection variée (ordre) puis 1ʳᵉ NON PUBLIÉE ---- */
function pickMixed(items, count) {
  items.sort((a, b) => new Date(b.dateISO).getTime() - new Date(a.dateISO).getTime());
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }
  const picks = [];
  const sources = [...bySource.keys()];
  let idx = 0;
  while (picks.length < count * 6 && sources.length) {
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
  if (picks.length < count * 6) {
    const set = new Set(picks.map((x) => x.link));
    for (const it of items) {
      if (picks.length >= count * 6) break;
      if (!set.has(it.link)) { picks.push(it); set.add(it.link); }
    }
  }
  return picks;
}

/* ---- MAIN ---- */
async function main() {
  // 1) Charger tous les flux
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

  // 2) Dé-dup des articles (par lien normalisé)
  const seenLinks = new Set();
  const unique = [];
  for (const it of all) {
    const key = normalizeUrl(it.link);
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    unique.push(it);
  }

  const outDir = path.join("src", "content", "papers");
  fs.mkdirSync(outDir, { recursive: true });

  // 3) Construire une liste “mixte” et choisir la 1ʳᵉ NON PUBLIÉE
  const mixed = pickMixed(unique, ITEMS_PER_RUN);
  const candidates = [...mixed, ...unique];
  const picks = [];
  for (const it of candidates) {
    const date = new Date(it.dateISO);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const niceDate = `${yyyy}-${mm}-${dd}`;
    const slug = `${niceDate}-${slugify(it.title, { lower: true, strict: true })}`;
    const target = path.join(outDir, `${slug}.md`);
    if (!fs.existsSync(target)) {
      picks.push({ it, slug, date });
      if (picks.length >= ITEMS_PER_RUN) break;
    }
  }

  if (!picks.length) {
    console.log("Aucune nouvelle actu à ajouter (tout le récent est déjà publié).");
    return;
  }

  // 4) Dé-dup images (inter-jours + intra-run) — sur Openverse uniquement
  const existingFP = getExistingImageFPs();
  const usedThisRun = new Set();

  for (const { it: p, slug, date } of picks) {
    const short = cleanText(p.summary).split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");

    // Image : on privilégie l’og:image (même si déjà utilisée ailleurs)
    let img = await fetchOgImage(p.link);
    let fp = img?.url ? normalizeUrl(img.url) : null;

    // Si pas d’og:image → Openverse filtré + anti-doublon
    if (!img) {
      const alt = await findImageOpenverse(p.title, new Set([...existingFP, ...usedThisRun]));
      if (alt) { img = alt; fp = normalizeUrl(alt.url); }
    }

    // Si l’image vient d’Openverse, on évite les doublons
    if (img && img.credit?.toLowerCase().includes("openverse")) {
      if (fp && (existingFP.has(fp) || usedThisRun.has(fp))) {
        img = null; fp = null;
      }
    }

    if (fp) usedThisRun.add(fp);

    const frontmatter = {
      title: p.title,
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
      (img?.url ? `![${p.title}](${img.url})\n\n${frontmatter.imageCredit ? `*Crédit image : ${frontmatter.imageCredit}*\n\n` : ""}` : "") +
      `## L’essentiel\n\n${short}\n\n## Lien source\n\n${p.link}\n`;

    fs.writeFileSync(path.join(outDir, `${slug}.md`), `---\n${yaml(frontmatter)}---\n\n${body}`, "utf-8");
    console.log(`✅ Généré: ${slug} ${img ? "(image OK)" : "(pas d'image)"} — ${p.source}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
