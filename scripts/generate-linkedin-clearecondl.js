// scripts/generate-linkedin-clearecondl.js
// 👉 Scrap Google via Puppeteer pour trouver des posts LinkedIn contenant "clearecon"
// 👉 Garde uniquement les URL avec "clearecon" dans le lien
// 👉 Extrait meta, génère des fichiers Markdown, trie par date et affiche logs + miniatures

import fs from "fs";
import path from "path";
import matter from "gray-matter";
import puppeteer from "puppeteer";

const OUTDIR = "src/content/li-clearecondl";
const YEAR = 2025;
const PAUSE_MS = parseInt(process.env.PAUSE_MS || "1200", 10);

// ---------------- Helpers ----------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function mdPath(item) {
  const date = item.date ? String(item.date).slice(0, 10) : "undated";
  return path.join(OUTDIR, `${date}-${slugify(item.title)}.md`);
}

function fm(item) {
  return matter.stringify(item.postText || "", {
    title: item.title,
    date: item.date,
    sourceUrl: item.url,
    summary: item.description || "",
    imageUrl: item.image || "",
    profileName: item.profileName || "",
  });
}

function writeIfChanged(fp, content) {
  if (!fs.existsSync(path.dirname(fp))) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
  }
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, content);
    return true;
  }
  const old = fs.readFileSync(fp, "utf8");
  if (old.trim() === content.trim()) return false;
  fs.writeFileSync(fp, content);
  return true;
}

async function extractMeta(page) {
  return await page.evaluate(() => {
    const get = (sel) => document.querySelector(sel)?.content || "";
    const meta = {
      ogTitle: get("meta[property='og:title']"),
      ogDesc: get("meta[property='og:description']"),
      ogImage: get("meta[property='og:image']"),
      twitterImage: get("meta[name='twitter:image']"),
      profileName:
        document.querySelector("meta[property='profile:first_name']")
          ?.content || "",
    };
    return meta;
  });
}

// ---------------- Main ----------------

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const queries = [
    'site:linkedin.com/posts "#clearecondl"',
    'site:linkedin.com/posts "CleaRecon DL"',
    'site:linkedin.com/feed/update "#clearecondl"',
    'site:linkedin.com/feed/update "CleaRecon DL"',
    'site:linkedin.com "CleaReconDL"',
  ];

  const allUrls = new Set();

  for (const q of queries) {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    console.log(`[INFO] Google SERP: ${q}`);
    await page.goto(searchUrl, { waitUntil: "networkidle2" });
    await sleep(PAUSE_MS);

    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a"))
        .map((el) => el.href)
        .filter((href) => href.includes("linkedin.com/"));
    });

    links.forEach((u) => allUrls.add(u));
  }

  const candidates = Array.from(allUrls);
  console.log(`[INFO] SERP: ${candidates.length} URL(s) candidates.`);
  candidates.forEach((u, i) =>
    console.log(`CANDIDATE[${String(i + 1).padStart(2, "0")}]: ${u}`)
  );

  // Filtre: URLs contenant "clearecon"
  const filteredByUrl = candidates.filter((u) => /clearecon/i.test(u));
  console.log(
    `[INFO] URL filter (contains "clearecon"): kept ${filteredByUrl.length}/${candidates.length}`
  );
  filteredByUrl.forEach((u, i) =>
    console.log(`KEEP[${String(i + 1).padStart(2, "0")}]: ${u}`)
  );

  // Hydrate
  const keptItems = [];
  let created = 0,
    updated = 0,
    unchanged = 0;

  for (const url of filteredByUrl) {
    try {
      const p = await browser.newPage();
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(PAUSE_MS);

      const meta = await extractMeta(p);

      const item = {
        title:
          (meta.profileName ? `${meta.profileName} — ` : "") +
          (meta.ogTitle || "(Sans titre)").slice(0, 120),
        description: meta.ogDesc || "",
        postText: meta.ogDesc || "",
        profileName: meta.profileName || "",
        date: new Date().toISOString(),
        url,
        image: meta.ogImage || meta.twitterImage || "",
      };

      const fp = mdPath(item);
      const existed = fs.existsSync(fp);
      const changed = writeIfChanged(fp, fm(item));

      if (!existed && changed) created++;
      else if (existed && changed) updated++;
      else unchanged++;

      keptItems.push(item);

      await p.close();
      await sleep(300);
    } catch (e) {
      console.log(`[DEBUG] process error ${url}: ${e.message}`);
    }
  }

  // Tri par date (desc)
  keptItems.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  console.log(`[INFO] Kept posts sorted by date (${keptItems.length}):`);
  keptItems.forEach((it, idx) => {
    console.log(
      `POST[${String(idx + 1).padStart(2, "0")}] ${new Date(
        it.date
      ).toISOString()} | ${it.title} | ${it.url} | thumb=${it.image}`
    );
  });

  console.log(
    `[INFO] Résultat — conservés: ${keptItems.length}, créés: ${created}, maj: ${updated}, inchangés: ${unchanged}`
  );

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
