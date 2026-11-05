// Builds trip-context.md: the English text of every page, which the Ask Claude worker
// gives Claude as background. Run after editing any page:  node tools/build-context.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGES = [
  ["index.html", "Itinerary"],
  ["flights.html", "Flights"],
  ["parks.html", "Parks & sights"],
  ["sky.html", "Sky planner (moon, stars, cloud forecast)"],
  ["budget.html", "Budget"],
];

(async () => {
  const browser = await chromium.launch();
  const out = [
    "# Las Vegas winter trip 2026 — trip plan",
    "",
    "Generated from the trip website (https://xmiao8.github.io/vegas-trip-2026/) on " + new Date().toISOString().slice(0, 10) + ".",
    "",
  ];
  for (const [file, title] of PAGES) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    // No network: fonts, photos and the live forecast aren't needed for the text.
    await page.route(/^https?:\/\//, r => r.abort());
    await page.goto("file://" + path.join(ROOT, file) + "#en");
    await page.waitForTimeout(400);
    const text = await page.evaluate(() => {
      const wrap = document.querySelector(".wrap"); // live DOM, so innerText keeps line breaks
      wrap.querySelectorAll("nav, button, script, style, .photo img, input, select").forEach(n => n.remove());
      // Keep links readable for Claude.
      wrap.querySelectorAll("a[href^='http']").forEach(a => { a.textContent = `${a.textContent.trim()} (${a.href})`; });
      return wrap.innerText.split("\n").map(l => l.trim()).filter(l => !/couldn’t load|Loading the live forecast/i.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    });
    out.push(`## ${title} page`, "", text, "");
    await page.close();
  }
  await browser.close();
  const md = out.join("\n");
  fs.writeFileSync(path.join(ROOT, "trip-context.md"), md);
  console.log(`trip-context.md: ${md.length.toLocaleString()} characters`);
})();
