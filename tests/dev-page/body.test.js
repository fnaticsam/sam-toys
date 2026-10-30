// Structural test for the page body (api/_lib/dev.html): the contract the rest
// of /dev depends on — 34 sections with stable ids, one <h3> each, the section
// nav, the diagrams, and no resource the page would have to fetch to render.
// Usage: node body.test.js      (REPO_DIR overrides the repo location)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = process.env.REPO_DIR || path.resolve(__dirname, "..", "..");

// The private guide is deliberately absent from public checkouts and CI.
if (!fs.existsSync(path.join(REPO, "api", "_lib", "dev.html"))) {
  require("node:test").test("dev-page: body", {
    skip: "api/_lib/dev.html is private and absent from this checkout",
  }, () => {});
} else {
const FILE = path.join(REPO, "api", "_lib", "dev.html");
const EXPECTED_SECTIONS = 34;
// Parts 1 and 2 (the first 27 sections) are pinned byte for byte; Part 3 (added
// 2026-10-03) is pinned by its ids and order instead.
const ORIGINAL_SECTIONS = 27;
const EXPECTED_SECTIONS_SHA256 = "7a59bbc93f058e5395996a5da954f03e68106790ed9b41e4cff2c6c85b857e9a";
const PART3_IDS = ["kit-overview", "kit-lanes", "kit-skills", "kit-fleet", "kit-habits", "kit-path", "kit-prompt"];
const PREVIOUS_SVG_COUNT = 9;

let html;
try {
  html = fs.readFileSync(FILE, "utf8");
} catch (err) {
  console.error("cannot read the page body at " + FILE + ": " + ((err && err.code) || "unknown error"));
  process.exit(1);
}

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); };

// ---- sections -------------------------------------------------------------
const openTags = html.match(/<section\b[^>]*>/gi) || [];
check(`exactly ${EXPECTED_SECTIONS} sections`, openTags.length === EXPECTED_SECTIONS);
check("every <section> is closed", (html.match(/<\/section>/gi) || []).length === openTags.length);
const fullSectionRe = /<section\b[^>]*>[\s\S]*?<\/section>/gi;
const fullSections = html.match(fullSectionRe) || [];
const sectionsDigest = crypto.createHash("sha256")
  .update(fullSections.slice(0, ORIGINAL_SECTIONS).join("")).digest("hex");
check("the first 27 section blocks match the original bytes and order",
  fullSections.length === EXPECTED_SECTIONS && sectionsDigest === EXPECTED_SECTIONS_SHA256);
const part3 = (html.match(/<div class="part" id="part-3">([\s\S]*?)\n<\/div>\n\n<footer class="page">/) || [])[1] || "";
const part3Ids = (part3.match(/<section\b[^>]*>/gi) || []).map((t) => (t.match(/\bid="([^"]+)"/) || [])[1]);
check("Part 3 holds the last 7 sections in order, just before the footer",
  part3Ids.join(" ") === PART3_IDS.join(" ") &&
  fullSections.slice(ORIGINAL_SECTIONS).map((b) => (b.match(/\bid="([^"]+)"/) || [])[1]).join(" ") === PART3_IDS.join(" "));
check("the hero links to Part 3", /<p class="hero-copy">[^<]*<a href="#part-3">/.test(html));

const sections = [];
const secRe = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
let m;
while ((m = secRe.exec(html)) !== null) {
  const id = (m[1].match(/\bid="([^"]+)"/) || [])[1] || "";
  sections.push({ id, body: m[2] });
}
check("every section parses with its body", sections.length === openTags.length);
check("every section has an id", sections.every((s) => s.id.length > 0));

const ids = sections.map((s) => s.id);
check("section ids are unique", new Set(ids).size === ids.length);
check("no section is nested inside another", !sections.some((s) => /<section\b/i.test(s.body)));

const noH3 = sections.filter((s) => !/<h3[\s>]/i.test(s.body));
check("every section has an <h3>", noH3.length === 0);
if (noH3.length) console.log("   sections without an <h3>: " + noH3.map((s) => s.id).join(", "));

// ---- nothing the page would have to fetch ---------------------------------
check("no <script src>", !/<script\b[^>]*\bsrc=/i.test(html));
check("no external stylesheet", !/<link\b[^>]*href="https?:/i.test(html));
check("no url(http…) in CSS", !/url\(\s*['"]?https?:/i.test(html));
check("no @import", !/@import/i.test(html));
check("no <img>, <iframe> or media element", !/<(img|iframe|video|audio|source|embed|object)\b/i.test(html));
const urls = Array.from(new Set(html.match(/https?:\/\/[^"' )<>]+/g) || []));
const ALLOWED = ["https://github.com/&lt;org&gt;/&lt;repo&gt;.git"];
check("the only absolute URL is the placeholder clone command",
  urls.length === ALLOWED.length && urls.every((u) => ALLOWED.indexOf(u) !== -1));
if (urls.some((u) => ALLOWED.indexOf(u) === -1)) console.log("   unexpected URLs: " + urls.join(", "));

// ---- landing --------------------------------------------------------------
const statsScripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
  .filter((match) => /\bid="dev-stats"/.test(match[1])
    && /\btype="application\/json"/.test(match[1]));
check("exactly one #dev-stats JSON script contains the placeholder",
  statsScripts.length === 1 && statsScripts[0][2] === "__DEV_STATS_JSON__");
check("the stats placeholder token occurs exactly once",
  (html.match(/__DEV_STATS_JSON__/g) || []).length === 1);

const statKeys = Array.from(html.matchAll(/\bdata-stat="([^"]+)"/g), (match) => match[1]);
const requiredStatKeys = [
  "month.commits", "month.merges", "month.additions", "month.deletions",
  "month.files", "month.repos", "generated_at",
];
const cardStatKeys = [
  "agents.per_day_avg", "agents.claude", "agents.codex",
  "fleet.cores", "fleet.memory_gb", "fleet.disk_gb",
];
check("the landing has at least five stat values", statKeys.length >= 5);
check("the landing has every required stat key",
  requiredStatKeys.every((key) => statKeys.includes(key)));
check("each TL;DR stat key occurs exactly once",
  cardStatKeys.every((key) => statKeys.filter((candidate) => candidate === key).length === 1));
check("a zero repository count is shown as unavailable",
  /key !== 'month\.repos' \|\| value > 0/.test(html));
check("zero fleet stats are unavailable while zero agent stats remain displayable",
  /key\.indexOf\('fleet\.'\) !== 0 \|\| value > 0/.test(html));
check("daily averages and large disks have dedicated formatting",
  /key === 'agents\.per_day_avg'/.test(html) && /key === 'fleet\.disk_gb' && value >= 1000/.test(html));

const landingTags = html.match(/<div\b[^>]*class="landing"[^>]*>/gi) || [];
const landingStart = html.indexOf('<div class="landing"');
const firstPart = html.indexOf('<div class="part" id="part-1">');
const landing = landingStart >= 0 && firstPart > landingStart
  ? html.slice(landingStart, firstPart)
  : "<section>missing landing markers</section>";
check("there is exactly one landing container", landingTags.length === 1);
check("the landing contains no <section>", !/<section\b/i.test(landing));
check("the landing contains the stats, Ask dev, and both TL;DR cards",
  /id="pipeline-stats"/.test(landing) && /id="ask"/.test(landing)
  && (landing.match(/class="tldr-card"/g) || []).length === 2);
check("the large table-of-contents nav is gone", !/<nav\b[^>]*class="[^"]*\btoc\b/i.test(html));
check("no diagram figure sits outside a section", !/<figure\b[^>]*class="diagram"/i.test(landing));

const factoryTitle = '<p class="tldr-title">How the factory works</p>';
const fleetTitle = '<p class="tldr-title">How the fleet works</p>';
const factoryStart = landing.indexOf(factoryTitle);
const fleetStart = landing.indexOf(fleetTitle);
const factoryCard = landing.slice(factoryStart, fleetStart);
const fleetCard = landing.slice(fleetStart);
const tldrArt = html.match(/<svg\b[^>]*class="tldr-art"[^>]*>/gi) || [];
const artButtons = html.match(/<button\b[^>]*class="tldr-art-open"[^>]*>[\s\S]*?<\/button>/gi) || [];
check("the two TL;DR cards each open with an artwork button",
  new RegExp(factoryTitle + "\\s*<button\\b[^>]*class=\"tldr-art-open\"").test(factoryCard)
  && new RegExp(fleetTitle + "\\s*<button\\b[^>]*class=\"tldr-art-open\"").test(fleetCard));
check("exactly two accessible artwork buttons wrap one illustration each",
  artButtons.length === 2 && artButtons.every((button) => /\btype="button"/i.test(button)
    && /\brole="button"/i.test(button) && /\btabindex="0"/i.test(button)
    && /\baria-label="Enlarge:/i.test(button)
    && (button.match(/<svg\b[^>]*class="tldr-art"/gi) || []).length === 1));
check("each TL;DR card contains exactly one illustration",
  (factoryCard.match(/<svg\b[^>]*class="tldr-art"/gi) || []).length === 1
  && (fleetCard.match(/<svg\b[^>]*class="tldr-art"/gi) || []).length === 1);
check("both TL;DR illustrations have an image role and accessible label",
  tldrArt.length === 2 && tldrArt.every((tag) => /\brole="img"/i.test(tag)
    && /\baria-label="[^\s"][^"]*"/i.test(tag)));
check("the page adds two illustrations and two expand glyphs",
  (html.match(/<svg\b/gi) || []).length === PREVIOUS_SVG_COUNT + 4 && tldrArt.length === 2
  && (html.match(/<svg\b[^>]*class="tldr-art-expand"/gi) || []).length === 2);

const artboxes = html.match(/<div\b[^>]*id="artbox"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi) || [];
check("one modal artbox has a close button",
  artboxes.length === 1 && /\brole="dialog"/i.test(artboxes[0])
  && /\baria-modal="true"/i.test(artboxes[0])
  && /<button\b[^>]*class="artbox-close"[^>]*aria-label="Close"/i.test(artboxes[0]));
check("the artbox sits outside every section", !sections.some((s) => /id="artbox"/.test(s.body)));
check("the lightbox clones the illustration and handles Escape",
  /cloneNode\(/.test(html) && /'Escape'/.test(html));
check("the page does not use a dialog element", !/<dialog\b/i.test(html));

// ---- section nav ----------------------------------------------------------
check("the nav container is present", /<nav\b[^>]*id="sidenav"/i.test(html));
check("the nav has an accessible name", /<nav\b[^>]*id="sidenav"[^>]*aria-label="[^"]+"/i.test(html));
check("the nav toggle is a real button", /<button\b[^>]*id="sidenav-toggle"/i.test(html));
check("the toggle declares aria-expanded", /<button\b[^>]*id="sidenav-toggle"[^>]*aria-expanded=/i.test(html));
check("the toggle declares aria-controls=\"sidenav\"", /<button\b[^>]*id="sidenav-toggle"[^>]*aria-controls="sidenav"/i.test(html));
check("the nav list is built from the sections themselves",
  /querySelectorAll\('section\[id\]'\)/.test(html) && /'sidenav-part'/.test(html));
check("the nav marks the section in view", /aria-current/.test(html));
check("the nav is outside every section", !sections.some((s) => /id="sidenav"/.test(s.body)));

// ---- diagrams -------------------------------------------------------------
const figures = html.match(/<figure\b[^>]*class="diagram"[^>]*>[\s\S]*?<\/figure>/gi) || [];
check("the page has diagrams", figures.length > 0);
const badRole = figures.filter((f) => !/<figure\b[^>]*\brole="img"/i.test(f));
check("every diagram figure has role=\"img\"", badRole.length === 0);
const badLabel = figures.filter((f) => {
  const label = (f.match(/<figure\b[^>]*\baria-label="([^"]*)"/i) || [])[1];
  return !label || !label.trim();
});
check("every diagram figure has a non-empty aria-label", badLabel.length === 0);
check("every diagram figure contains an inline <svg", figures.every((f) => /<svg[\s>]/i.test(f)));
check("every diagram figure has a figcaption", figures.every((f) => /<figcaption[\s>]/i.test(f)));
check("every diagram svg declares a viewBox", figures.every((f) => /<svg\b[^>]*viewBox="/i.test(f)));
check("every diagram sits inside a section",
  figures.every((f) => sections.some((s) => s.body.indexOf(f) !== -1)));
check("the search index skips diagram text", /tagName === 'FIGURE'/.test(html));

// ---- report ---------------------------------------------------------------
for (const [name, ok] of results) console.log((ok ? "PASS" : "FAIL") + "  " + name);
console.log(results.filter((x) => x[1]).length + "/" + results.length + " checks passed");
if (results.some((x) => !x[1])) process.exit(1);

}
