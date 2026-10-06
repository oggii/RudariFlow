#!/usr/bin/env node
// ui-check: builds the frontend, renders every page in headless Chromium
// with a mocked backend (mock.js), takes screenshots and fails on layout,
// accessibility and wording defects (inpage.js, static.mjs, roundtrip.mjs).
//
//   node tools/ui-check/run.mjs                    everything
//   node tools/ui-check/run.mjs --pages home,settings-*   only these pages
//   --scenario populated|firstrun   --lang en|de   --size 900x600
//   --no-build   use the build of the last run     --no-shots   no screenshots
//   --root <dir> the repo to check (default: two folders up)
//
// Exit code 0: nothing new. Findings listed in allow.json are known and
// belong to a later task; a full run also fails when an entry of allow.json
// no longer matches anything (remove it).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, USER_TEXT } from "./pages.mjs";
import { staticChecks } from "./static.mjs";
import { roundtrip } from "./roundtrip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROOT = path.resolve(option("root") ?? path.join(here, "../.."));
const BUILD = path.join(here, ".build");
const SHOTS = path.join(here, "shots");
const SCENARIOS = option("scenario") ? [option("scenario")] : ["populated", "firstrun"];
const LANGS = option("lang") ? [option("lang")] : ["en", "de"];
const SIZES = option("size") ? [option("size")] : ["2560x1392", "1600x900", "900x600"];
/** The size and language the keyboard walk runs at (once per page and data set; a page with sizes of its own walks at those). */
const WALK = { size: "1600x900", lang: "en" };
const glob = (pattern) => new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const pageFilter = option("pages")?.split(",").map(glob);
const wanted = (id) => !pageFilter || pageFilter.some((re) => re.test(id));
const fullRun = !pageFilter && !option("scenario") && !option("lang") && !option("size");

// ── Build ─────────────────────────────────────────────
if (!flag("no-build")) {
  console.log("building the frontend …");
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", BUILD, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: ROOT,
    stdio: "inherit",
  });
}
if (!fs.existsSync(path.join(BUILD, "index.html"))) {
  console.error(`no build in ${BUILD}; run without --no-build`);
  process.exit(2);
}
if (!flag("no-shots")) fs.mkdirSync(SHOTS, { recursive: true });

// ── Findings ──────────────────────────────────────────
/** check | page | what → { check, page, what, detail, where: Set } */
const findings = new Map();
function report(page, where, list) {
  for (const f of list) {
    const key = `${f.check} | ${f.page ?? page} | ${f.what}`;
    const known = findings.get(key) ?? { check: f.check, page: f.page ?? page, what: f.what, detail: f.detail ?? "", where: new Set() };
    known.where.add(where);
    findings.set(key, known);
  }
}

const contract = JSON.parse(fs.readFileSync(path.join(here, "contract.json"), "utf8"));
report("source", "source", staticChecks(ROOT, contract));

// ── Server for the build ──────────────────────────────
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".wav": "audio/wav", ".woff": "font/woff", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(BUILD, p);
  if (!file.startsWith(BUILD) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const MOCK = fs.readFileSync(path.join(here, "mock.js"), "utf8");
const INPAGE = fs.readFileSync(path.join(here, "inpage.js"), "utf8");
const browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--mute-audio"] });

/** A window on `url` with the mocked backend. `problems` collects what went wrong in it. */
async function openWindow({ scenario, lang, size, url }) {
  const [width, height] = size.split("x").map(Number);
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: lang === "de" ? "de-CH" : "en-GB",
    timezoneId: "Europe/Zurich",
    colorScheme: "dark",
  });
  await context.addInitScript(`window.__MOCK_CFG__ = ${JSON.stringify({ lang, scenario })};`);
  await context.addInitScript(MOCK);
  await context.addInitScript(INPAGE);
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push({ check: "page-error", what: String(e).split("\n")[0] }));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push({ check: "page-error", what: m.text().split("\n")[0] });
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(BASE) && !/^(data|blob|about):/.test(u)) problems.push({ check: "external", page: "window", what: new URL(u).origin, detail: "the page asks another computer for something" });
  });
  const load = async () => {
    await page.goto(BASE + url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
  };
  await load();
  return { context, page, problems, load, width, height };
}

/** What the window shows, and the whole page (the window grown until nothing scrolls). */
async function shoot(win, name) {
  const { page, width, height } = win;
  await page.screenshot({ path: path.join(SHOTS, `${name}-fold.png`) });
  const hasContent = await page.evaluate(() => !!document.getElementById("content"));
  if (!hasContent) {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
    return;
  }
  for (let i = 0; i < 3; i++) {
    const extra = await page.evaluate(() => {
      const c = document.getElementById("content");
      return c.scrollHeight - c.clientHeight;
    });
    if (extra <= 0) break;
    await page.setViewportSize({ width, height: page.viewportSize().height + extra });
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(150);
}

/** Tab through the window: every control under `scope` must get the focus and show it. */
async function keyboardWalk(page, scope) {
  const out = [];
  const expected = await page.evaluate((s) => window.__uic.markControls(s), scope);
  const limit = (await page.evaluate(() => document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]").length)) + 10;
  await page.evaluate(() => document.activeElement?.blur?.());
  const reached = new Set();
  const seen = new Set();
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => window.__uic.focusStop());
    if (!stop) continue; // between the last control and the first
    if (seen.has(stop.stop)) break; // once round
    seen.add(stop.stop);
    if (stop.n === null) continue; // outside the scope
    reached.add(stop.n);
    if (!stop.ring) out.push({ check: "focus", what: stop.what, detail: "has the keyboard focus and does not show it" });
  }
  for (const c of expected) if (!reached.has(c.n)) out.push({ check: "tab", what: c.what, detail: "Tab never reaches it" });
  await page.evaluate(() => document.activeElement?.blur?.());
  return out;
}

// ── The pages ─────────────────────────────────────────
const urls = [...new Set(PAGES.map((p) => p.url ?? "/"))];
let shots = 0;
for (const scenario of SCENARIOS) {
  for (const lang of LANGS) {
    for (const url of urls) {
      const defs = PAGES.filter((p) => (p.url ?? "/") === url && wanted(p.id) && (p.scenarios ?? ["populated", "firstrun"]).includes(scenario));
      for (const size of new Set(defs.flatMap((p) => p.sizes ?? SIZES))) {
        const where = `${scenario} ${lang} ${size}`;
        const win = await openWindow({ scenario, lang, size, url });
        for (const def of defs.filter((p) => (p.sizes ?? SIZES).includes(size))) {
          try {
            if (def.fresh) await win.load();
            await def.open?.(win.page);
            await win.page.evaluate(() => {
              for (const el of [document.scrollingElement, document.getElementById("content"), document.getElementById("sidebar")]) if (el) el.scrollTop = 0;
            });
            const scope = def.scope ?? "#content";
            if (def.checks !== false) {
              const shell = def.id === "shell";
              const opts = {
                scope,
                userText: USER_TEXT,
                skip: def.skip ?? [],
                // Once per window is enough for these three.
                sidebar: shell && size === "900x600",
                tokens: shell,
                ids: shell && scenario === "populated" ? contract.ids.filter((id) => !(id in contract.removedIds)) : [],
              };
              report(def.id, where, await win.page.evaluate((o) => window.__uic.collect(o), opts));
              if (lang === WALK.lang && (size === WALK.size || def.sizes)) report(def.id, where, await keyboardWalk(win.page, scope));
            }
            if (def.probe) report(def.id, where, await def.probe(win.page));
            if (!flag("no-shots")) {
              await shoot(win, `${def.id}-${scenario}-${lang}-${size}`);
              shots += 2;
            }
          } catch (e) {
            report(def.id, where, [{ check: "page-error", what: "the page could not be opened", detail: String(e).split("\n")[0] }]);
          }
          const unknown = await win.page.evaluate(() => window.__MOCK__.unknown.splice(0)).catch(() => []);
          report(def.id, where, unknown.map((cmd) => ({ check: "mock", what: `command ${cmd}`, detail: "mock.js has no answer for it" })));
          report(def.id, where, win.problems.splice(0));
        }
        await win.context.close();
      }
    }
  }
}

// ── The settings round trip ───────────────────────────
if (wanted("roundtrip") && SCENARIOS.includes("populated") && LANGS.includes("en")) {
  report("settings", "populated en 1600x900", await roundtrip(async () => (await openWindow({ scenario: "populated", lang: "en", size: "1600x900", url: "/" })).page));
}

await browser.close();
server.close();

// ── Report ────────────────────────────────────────────
const allow = JSON.parse(fs.readFileSync(path.join(here, "allow.json"), "utf8"));
const rules = allow.map((a) => ({ ...a, check_: glob(a.check), page_: glob(a.page ?? "*"), what_: glob(a.what ?? "*"), hits: 0 }));
const fresh = [];
const known = [];
for (const f of findings.values()) {
  const rule = rules.find((r) => r.check_.test(f.check) && r.page_.test(f.page) && r.what_.test(f.what));
  if (rule) {
    rule.hits++;
    known.push({ ...f, until: rule.until });
  } else fresh.push(f);
}
const line = (f) => `  ${f.check.padEnd(14)} ${f.page.padEnd(22)} ${f.what}${f.detail ? `  (${f.detail})` : ""}  [${f.where.size === 1 ? [...f.where][0] : `${f.where.size} views, e.g. ${[...f.where][0]}`}]`;
const byCheck = (list) => [...list].sort((a, b) => (a.check + a.page + a.what).localeCompare(b.check + b.page + b.what));
fs.writeFileSync(
  path.join(here, "report.json"),
  JSON.stringify({ new: byCheck(fresh).map((f) => ({ ...f, where: [...f.where] })), known: byCheck(known).map((f) => ({ ...f, where: [...f.where] })) }, null, 1),
);

console.log(`\nui-check: ${findings.size} findings, ${known.length} known (allow.json), ${fresh.length} new${flag("no-shots") ? "" : `; ${shots} screenshots in ${SHOTS}`}`);
if (known.length) {
  const tally = {};
  for (const f of known) tally[`${f.check} (until Task ${f.until})`] = (tally[`${f.check} (until Task ${f.until})`] ?? 0) + 1;
  console.log("known: " + Object.entries(tally).map(([k, n]) => `${k}: ${n}`).join(", "));
}
const stale = fullRun ? rules.filter((r) => r.hits === 0) : [];
if (fresh.length) {
  console.log("\nNEW:");
  for (const f of byCheck(fresh)) console.log(line(f));
}
if (stale.length) {
  console.log("\nallow.json entries that match nothing any more (remove them):");
  for (const r of stale) console.log(`  ${JSON.stringify({ check: r.check, page: r.page, what: r.what, until: r.until })}`);
}
console.log(`\ndetails: ${path.join(here, "report.json")}`);
process.exit(fresh.length || stale.length ? 1 : 0);
