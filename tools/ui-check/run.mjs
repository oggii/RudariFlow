#!/usr/bin/env node
// ui-check: builds the frontend, renders every page in headless Chromium
// with a mocked backend (mock.js), takes screenshots and fails on layout,
// accessibility and wording defects (inpage.js, static.mjs, roundtrip.mjs).
//
//   node tools/ui-check/run.mjs                    everything
//   node tools/ui-check/run.mjs --pages home,settings-*   only these pages
//   --scenario populated|firstrun   --lang en|de   --size 900x600
//   --no-build   use the build of the last run     --no-shots   no screenshots
//   --times      also print the seconds each page took, over all its views
//   --root <dir> the repo to check (default: two folders up)
//   --task N     the run that verifies task N of the plan: allow.json entries
//                with "until" <= N no longer count. What they covered is new
//                again, and they are not listed as stale; delete them once
//                the run is clean.
//
// Exit code 0: nothing new. Findings listed in allow.json are known and
// belong to a later task; a full run also fails when an entry of allow.json
// no longer matches anything (remove it). Exit code 2: the run could not
// start (no build, a --pages filter that names no page, a --task that is no
// number, an argument it does not know, nothing opened). Exit code 1 also
// when allow.json still holds an entry of an earlier task (until < N): the
// list only shrinks.
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
/** The sizes a page is opened at: its own, or the run's and (in a run without --size) the ones the page adds. */
const sizesOf = (p) => p.sizes ?? [...SIZES, ...(option("size") ? [] : (p.alsoSizes ?? []))];
/** The size and language the keyboard walk runs at (once per page and data set; a page with sizes of its own walks at those). */
const WALK = { size: "1600x900", lang: "en" };
const glob = (pattern) => new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const stop = (message) => {
  console.error(`ui-check: ${message}`);
  process.exit(2);
};
// A mistyped argument (--task=2, --tsak 2) must not run as if it were not there.
const WITH_VALUE = ["pages", "scenario", "lang", "size", "root", "task"];
const BARE = ["no-build", "no-shots", "times"];
for (let i = 0; i < args.length; i++) {
  if (WITH_VALUE.some((name) => args[i] === `--${name}`)) i++;
  else if (!BARE.some((name) => args[i] === `--${name}`)) stop(`unknown argument "${args[i]}"`);
}
const pagePatterns = flag("pages") ? (option("pages") ?? "").split(",") : null;
const pageFilter = pagePatterns?.map(glob);
const wanted = (id) => !pageFilter || pageFilter.some((re) => re.test(id));
const fullRun = !pageFilter && !option("scenario") && !option("lang") && !option("size");
// A filter that names nothing would check nothing and report "0 findings".
const pageIds = [...PAGES.map((p) => p.id), "roundtrip"];
for (const [i, pattern] of (pagePatterns ?? []).entries()) {
  if (!pageIds.some((id) => pageFilter[i].test(id))) stop(`--pages "${pattern}" matches no page. The pages are: ${pageIds.join(", ")}`);
}
/** The task this run verifies: entries of allow.json with `until` <= TASK are ignored. */
const TASK = flag("task") ? Number(option("task")) : null;
if (TASK !== null && !(Number.isInteger(TASK) && TASK >= 1)) stop(`--task needs the number of a task, got "${option("task") ?? ""}"`);

// ── Build ─────────────────────────────────────────────
if (!flag("no-build")) {
  console.log("building the frontend …");
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", BUILD, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: ROOT,
    stdio: "inherit",
  });
}
if (!fs.existsSync(path.join(BUILD, "index.html"))) stop(`no build in ${BUILD}; run without --no-build`);
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

/** --times: what each page took, over all its views; "(window)" is the start of the windows the pages share. */
const times = new Map();
function timed(id, since) {
  const sum = times.get(id) ?? { ms: 0, views: 0 };
  sum.ms += performance.now() - since;
  sum.views++;
  times.set(id, sum);
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
const LAUNCH = { headless: true, args: ["--disable-gpu", "--mute-audio"] };
const browser = await chromium.launch(LAUNCH);
/** A second browser that draws its scrollbars, as the app's window does (Playwright hides them); started when a probe asks for it. */
let barBrowser = null;

/**
 * A window on `url` with the mocked backend. `problems` collects what went wrong in it.
 * `scrollbars`: with the scrollbars drawn, so a page that gets one loses their width.
 */
async function openWindow({ scenario, lang, size, url, scrollbars = false }) {
  const [width, height] = size.split("x").map(Number);
  if (scrollbars) barBrowser ??= await chromium.launch({ ...LAUNCH, ignoreDefaultArgs: ["--hide-scrollbars"] });
  const context = await (scrollbars ? barBrowser : browser).newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: lang === "de" ? "de-CH" : "en-GB",
    timezoneId: "Europe/Zurich",
    colorScheme: "dark",
  });
  await context.addInitScript(`window.__MOCK_CFG__ = ${JSON.stringify({ lang, scenario })};`);
  await context.addInitScript(MOCK);
  // The keys of the settings before the page touched them (roundtrip.mjs: none may get lost).
  await context.addInitScript("window.__MOCK_KEYS__ = Object.keys(window.__MOCK__.settings());");
  await context.addInitScript(INPAGE);
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push({ check: "page-error", what: String(e).split("\n")[0] }));
  page.on("console", (m) => {
    // "Failed to load resource" is counted where it happens: `response` and `requestfailed` below, `external` for another origin.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push({ check: "page-error", what: m.text().split("\n")[0] });
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(BASE) && !/^(data|blob|about):/.test(u)) problems.push({ check: "external", page: "window", what: new URL(u).origin, detail: "the page asks another computer for something" });
  });
  // A file of the page's own that does not load: a font, a script, an image.
  const own = (u) => u.startsWith(BASE + "/");
  const lost = (u, why) => problems.push({ check: "page-error", page: "window", what: `${decodeURIComponent(new URL(u).pathname)} does not load`, detail: `${why}; the page asks for a file of its own that is not there` });
  page.on("response", (r) => {
    if (own(r.url()) && r.status() >= 400) lost(r.url(), `status ${r.status()}`);
  });
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "failed";
    if (own(r.url()) && !/ERR_ABORTED/.test(why)) lost(r.url(), why); // aborted: the window was reloaded or closed
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
let opened = 0;
for (const scenario of SCENARIOS) {
  for (const lang of LANGS) {
    for (const url of urls) {
      const defs = PAGES.filter((p) => (p.url ?? "/") === url && wanted(p.id) && (p.scenarios ?? ["populated", "firstrun"]).includes(scenario));
      for (const size of new Set(defs.flatMap(sizesOf))) {
        const where = `${scenario} ${lang} ${size}`;
        const opening = performance.now();
        const win = await openWindow({ scenario, lang, size, url });
        timed("(window)", opening);
        for (const def of defs.filter((p) => sizesOf(p).includes(size))) {
          opened++;
          const began = performance.now();
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
            if (def.probe) report(def.id, where, await def.probe(win.page, { openWindow, scenario, lang, size }));
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
          timed(def.id, began);
        }
        await win.context.close();
      }
    }
  }
}

// ── The settings round trip ───────────────────────────
if (wanted("roundtrip") && SCENARIOS.includes("populated") && LANGS.includes("en")) {
  opened++;
  const began = performance.now();
  const where = "populated en 1600x900";
  const win = await openWindow({ scenario: "populated", lang: "en", size: "1600x900", url: "/" });
  try {
    report("settings", where, await roundtrip(win.page));
  } catch (e) {
    report("settings", where, [{ check: "roundtrip", what: "the round trip stopped", detail: String(e).split("\n")[0] }]);
  }
  // What went wrong in this window while the settings were changed counts like on any page.
  const unknown = await win.page.evaluate(() => window.__MOCK__.unknown.splice(0)).catch(() => []);
  report("settings", where, unknown.map((cmd) => ({ check: "mock", what: `command ${cmd}`, detail: "mock.js has no answer for it" })));
  report("settings", where, win.problems.splice(0));
  await win.context.close();
  timed("roundtrip", began);
}

await browser.close();
await barBrowser?.close();
server.close();
if (!opened) stop(`nothing was checked: no page of ${option("pages") ?? "the list"} is opened with --scenario ${SCENARIOS.join(",")}, --lang ${LANGS.join(",")}, --size ${SIZES.join(",")}`);

// ── Report ────────────────────────────────────────────
const allow = JSON.parse(fs.readFileSync(path.join(here, "allow.json"), "utf8"));
// --task N: an entry whose task is done (until <= N) covers nothing any more.
const past = allow.filter((a) => TASK !== null && !(a.until > TASK));
const rules = allow
  .filter((a) => !past.includes(a))
  .map((a) => ({ ...a, check_: glob(a.check), page_: glob(a.page ?? "*"), what_: glob(a.what ?? "*"), hits: 0 }));
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

console.log(`\nui-check${TASK === null ? "" : ` (task ${TASK})`}: ${findings.size} findings, ${known.length} known (allow.json), ${fresh.length} new${flag("no-shots") ? "" : `; ${shots} screenshots in ${SHOTS}`}`);
if (past.length) console.log(`--task ${TASK}: ${past.length} of ${allow.length} allow.json entries are past their task (until <= ${TASK}) and were ignored; delete them once nothing is new`);
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
// An entry of an earlier task should have been deleted when that task ended.
const leftover = TASK === null ? [] : past.filter((a) => a.until < TASK);
if (leftover.length) {
  console.log(`\nallow.json entries of an earlier task than ${TASK} (they should be gone; remove them):`);
  for (const a of leftover) console.log(`  ${JSON.stringify(a)}`);
}
if (flag("times")) {
  const total = [...times.values()].reduce((sum, t) => sum + t.ms, 0);
  console.log(`\ntimes (${Math.round(total / 1000)} s in the pages):`);
  for (const [id, t] of [...times].sort((a, b) => b[1].ms - a[1].ms)) console.log(`  ${id.padEnd(28)} ${(t.ms / 1000).toFixed(1).padStart(6)} s  ${String(t.views).padStart(3)} views`);
}
console.log(`\ndetails: ${path.join(here, "report.json")}`);
process.exit(fresh.length || stale.length || leftover.length ? 1 : 0);
