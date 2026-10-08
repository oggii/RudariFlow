// The pages and states the ui-check opens, and how it gets there.
//
//   id         name in the report and in the screenshot files
//   url        "/" the main window (default), "/soundboard.html" the pop-out,
//              "/src/overlay.html" the pill
//   scope      the part of the page the checks look at (default "#content")
//   scenarios  data sets it is opened with (default: "populated" and "firstrun")
//   sizes      window sizes (default: every size of run.mjs)
//   alsoSizes  window sizes on top of run.mjs's (not in a run with --size)
//   fresh      load the window again first (for a state that would stay)
//   open       brings the loaded window to the page or state
//   checks     false: screenshots only
//   walk       false: no keyboard walk (a state the walk's first step would end:
//              a field that renames, an open menu, a key box that listens; its
//              probe asks for the focus ring itself)
//   state      true: the page is a state its `open` brings about, not a page
//              at rest. It must have `shows` (run.mjs stops without one)
//   shows      the state is really on screen: async (page, run) => findings,
//              asked right after `open`, before anything is measured (see
//              `onScreen`); a page whose `open` never got there would measure
//              the page at rest, and pass
//   skip       check ids that do not apply to this page
//   probe      extra findings: async (page, run) => [{ check, what, detail }];
//              run = { openWindow, scenario, lang, size }, openWindow as in
//              run.mjs (`scrollbars: true` draws them, as the app's window does)
//   after      puts back what the page changed for its picture: async (page),
//              called after the screenshots, also when the probe threw
//
// Pages with the same url share one window per data set, language and size,
// in this order; put a state that changes the window after the plain pages
// and mark it `fresh`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { literal } from "./static.mjs";

/** This folder: the app's sources are two folders up. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const wait = (page, ms = 350) => page.waitForTimeout(ms);

/** Open a sidebar section. */
async function section(page, name) {
  await page.evaluate((s) => document.querySelector(`.nav-item[data-section="${s}"]`).click(), name);
  await wait(page);
}

/** Open a Settings tab. The sidebar is pressed only from another page: on Settings already, the press changes nothing and its wait is for nothing. */
async function settings(page, tab) {
  if (!(await page.evaluate(() => document.getElementById("section-settings").classList.contains("active")))) await section(page, "settings");
  await page.evaluate((t) => document.getElementById(`tab-${t}`).click(), tab);
  await wait(page);
}

const TABS = ["dictation", "ai", "dictionary", "models", "general"];

/**
 * The layout system's three steps (src/shell.ts, the head of src/styles/shell.css): the room beside the sidebar
 * from which a page has more columns. Home and the Soundboard are two columns from WIDE; Settings, the Meetings
 * library, an open meeting and Files with a file from ROOMY; Home's controls and the first run's grid from WIDER.
 */
const WIDE = 900;
const ROOMY = 1250;
const WIDER = 1600;

/** What a probe reports when `ok` is false. */
const expect = (ok, what, detail = "") => (ok ? [] : [{ check: "behaviour", what, detail }]);

/**
 * A state page's proof that its state is on screen (its `shows`). `test` runs in the page and answers true, or what
 * it found instead. Until the re-review of Task 8, 23 of the 55 state pages passed with an `open` that never reached
 * its state: the checks then measured the page at rest, which is clean.
 */
const onScreen = (what, test, arg) => async (page) => {
  const got = await page.evaluate(test, arg);
  return expect(got === true, `the page shows its state: ${what}`, got === true ? "" : (JSON.stringify(got) ?? "nothing"));
};

/**
 * A key box under `boxes` asks for its key, or (`refused`) says why a key was refused. Both have the box in its
 * accent form (`.capturing`); the prompt ends in an ellipsis in both languages, a reason does not.
 */
const keyBoxShows = (what, boxes, refused = false) =>
  onScreen(
    what,
    ([boxes, refused]) => {
      const box = [...document.querySelectorAll(boxes)].find((b) => b.classList.contains("capturing"));
      const text = box?.textContent.trim() ?? "";
      return (!!box && text.length > 15 && /…$/.test(text) !== refused) || { listens: !!box, text };
    },
    [boxes, refused],
  );

/**
 * Home's two layout steps (900 and 1600 px beside the sidebar) in a window
 * that draws its scrollbar. A step that is decided on a width the scrollbar
 * takes away, and is higher in its wider form, flips in every frame. Each
 * step is tried one pixel below, at and above it, at the window heights
 * where the page just fits and just does not: nothing may change by itself.
 */
async function layoutHolds(run) {
  const win = await run.openWindow({ scenario: "populated", lang: run.lang, size: "1800x1000", url: "/", scrollbars: true });
  const { page } = win;
  const tried = [];
  try {
    await section(page, "home");
    const side = await page.evaluate(() => window.innerWidth - document.getElementById("content").offsetWidth);
    for (const step of [900, 1600]) {
      const widths = [step - 1, step, step + 1].map((w) => w + side);
      // The window height at which the page ends at the window's bottom, for each width.
      const fits = [];
      for (const width of widths) {
        await page.setViewportSize({ width, height: 3000 });
        await wait(page, 120);
        fits.push(await page.evaluate(() => Math.round(window.innerHeight - document.getElementById("content").clientHeight + document.getElementById("section-home").getBoundingClientRect().height)));
      }
      const heights = [...new Set(fits.flatMap((h) => [-2, -1, 0, 1, 2].map((d) => h + d)))];
      for (const width of widths) {
        for (const height of heights) {
          await page.setViewportSize({ width, height });
          await wait(page, 80);
          const changes = await page.evaluate(
            () =>
              new Promise((done) => {
                const daily = document.getElementById("home-daily");
                const content = document.getElementById("content");
                let was = `${daily.className} ${content.offsetWidth - content.clientWidth}`;
                let n = 0;
                const end = performance.now() + 200;
                const frame = () => {
                  const now = `${daily.className} ${content.offsetWidth - content.clientWidth}`;
                  if (now !== was) n++;
                  was = now;
                  if (performance.now() < end) requestAnimationFrame(frame);
                  else done(n);
                };
                requestAnimationFrame(frame);
              }),
          );
          tried.push({ size: `${width}x${height}`, changes });
        }
      }
    }
    const bar = await page.evaluate(() => {
      const content = document.getElementById("content");
      content.style.height = "100px";
      return content.offsetWidth - content.clientWidth;
    });
    const moved = tried.filter((t) => t.changes > 0);
    return [
      ...expect(bar > 0, "the window of the layout check draws its scrollbar", `${bar} px`),
      ...expect(moved.length === 0, "Home's layout holds still at its steps with a scrollbar", `${moved.length} of ${tried.length} sizes change by themselves, e.g. ${JSON.stringify(moved.slice(0, 3))}`),
    ];
  } finally {
    await win.context.close();
  }
}

/**
 * A dictation's actions (Home, "Row actions" in styles/home.css). "Copy" always shows and is the row's last
 * action: its words end at the card's right edge, where the search field ends, in every row. The others stand to
 * its left (Delete first, apart from the rest) and show with the pointer on the row or the focus in it; where they
 * stand does not change when they come, and no row changes its height: nothing moves. In a narrow list (a card
 * under 600 px) they take the line of the app, the time and the length, whose words are not drawn meanwhile and
 * stay in the page. An armed Delete stays in view when the pointer leaves. All of them stay in the page, named
 * and in the Tab order. And the focus counts, not only the keyboard's: after a Re-run by mouse with the pointer
 * gone, the focus is on a Re-run that shows.
 */
async function rowActions(page, run) {
  const out = [];
  await page.mouse.move(2, 2);
  const look = () =>
    page.evaluate(() => {
      const edge = (node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return Math.round(range.getBoundingClientRect().right);
      };
      const middle = (el) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
      const rows = [...document.querySelectorAll("#history-list .history-item")].map((row) => {
        const buttons = [...row.querySelectorAll(".history-actions button")];
        const copy = row.querySelector('[data-action="copy"]');
        const parts = row.querySelector(".history-parts");
        return {
          // Where the word "Copy" ends, and the row itself.
          copy: edge(copy.firstChild),
          right: Math.round(row.getBoundingClientRect().right),
          height: Math.round(row.getBoundingClientRect().height),
          seen: buttons.map((b) => (getComputedStyle(b).opacity === "0" ? "" : b.textContent)),
          at: buttons.map((b) => Math.round(b.getBoundingClientRect().left)).join(),
          order: buttons[0].hasAttribute("data-delete-id") && buttons.at(-1) === copy,
          named: buttons.every((b) => b.textContent.trim() && b.tabIndex === 0 && b.checkVisibility()),
          // Copy on the line of the app, the time and the length, not on one of its own.
          onLine: Math.abs(middle(copy) - middle(parts)) <= 2,
          parts: [getComputedStyle(parts).opacity, parts.checkVisibility({ visibilityProperty: true }), parts.textContent.length > 5],
        };
      });
      const card = document.getElementById("home-recent");
      return { rows, search: Math.round(document.getElementById("history-search").getBoundingClientRect().right), narrow: card.clientWidth - parseFloat(getComputedStyle(card).paddingLeft) - parseFloat(getComputedStyle(card).paddingRight) < 600 };
    });
  const rest = await look();
  out.push(...expect(rest.rows.length > 0 && rest.rows.every((r) => r.seen.filter(Boolean).length === 1 && r.seen.at(-1) !== "" && r.order && r.named), "at rest a dictation shows Copy alone, its last action; the others are in the page before it (Delete first), named and in the Tab order", JSON.stringify(rest.rows.map((r) => r.seen))));
  out.push(...expect(rest.rows.every((r) => Math.abs(r.copy - r.right) <= 1 && Math.abs(r.copy - rest.search) <= 1), "the Copy of every dictation ends at the card's right edge, where the search field ends", JSON.stringify([rest.search, rest.rows.map((r) => [r.copy, r.right])])));
  // A narrow list: Copy stands at the right end of the row's second line, which shows its words.
  if (rest.narrow) out.push(...expect(rest.rows.every((r) => r.onLine && r.parts[0] === "1"), "in a narrow list Copy stands on the line of the app, the time and the length, not on a line of its own", JSON.stringify(rest.rows.map((r) => [r.onLine, r.parts]))));
  // The pointer on the first row: its actions show, where they stood unseen; the other rows stay quiet, and no row is higher or lower.
  const first = page.locator("#history-list .history-item").first();
  await first.scrollIntoViewIfNeeded();
  const before = await look();
  await first.locator(".history-text").hover();
  const hovered = await look();
  out.push(...expect(hovered.rows[0].seen.every(Boolean) && hovered.rows[0].at === before.rows[0].at && hovered.rows.slice(1).every((r) => r.seen.filter(Boolean).length === 1), "with the pointer on a dictation its actions show, each where it stood unseen, and only that row's", JSON.stringify([before.rows[0].at, hovered.rows[0].at, hovered.rows.map((r) => r.seen)])));
  out.push(...expect(hovered.rows.map((r) => r.height).join() === before.rows.map((r) => r.height).join(), "no dictation changes its height when its actions show", JSON.stringify([before.rows.map((r) => r.height), hovered.rows.map((r) => r.height)])));
  if (rest.narrow) out.push(...expect(hovered.rows[0].parts.join() === "0,true,true" && hovered.rows.slice(1).every((r) => r.parts[0] === "1"), "in a narrow list the actions take the row's second line: its words are not drawn meanwhile and stay in the page", JSON.stringify(hovered.rows.map((r) => r.parts))));
  await page.mouse.move(2, 2);
  // The keyboard in the row: Tab from the search field reaches the row's first action, which shows with its ring.
  await page.focus("#history-search");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const at = document.activeElement;
    const row = at.closest(".history-item");
    return { inRow: !!row, first: !!row && at === row.querySelector(".history-actions button"), shown: !!row && [...row.querySelectorAll(".history-actions button")].every((b) => getComputedStyle(b).opacity !== "0"), ring: getComputedStyle(at).outlineStyle !== "none" };
  });
  out.push(...expect(focused.inRow && focused.first && focused.shown && focused.ring, "with the keyboard focus in a dictation all its actions show, and the focused one has its ring", JSON.stringify(focused)));
  await page.evaluate(() => document.activeElement.blur());
  // An armed Delete stays in view when the pointer has left the row (it has the focus, and so the row shows).
  await first.locator(".history-text").hover();
  await first.locator("[data-delete-id]").click();
  await page.mouse.move(2, 2);
  await wait(page, 60);
  const armed = (await look()).rows[0];
  out.push(...expect(armed.seen[0].endsWith("?") && armed.seen.at(-1) !== "", "an armed Delete stays in view with Copy when the pointer leaves the row", JSON.stringify(armed.seen)));
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.activeElement?.blur?.());
  await wait(page, 60);
  // What a click leaves behind is the same in every view: once.
  if (!(run.lang === "en" && run.size === BEHAVIOUR)) return out;
  // Re-run by mouse, and the pointer goes: the answer draws the row anew, and the focus is on its Re-run, which
  // shows. Shown only to the keyboard's focus, it had the focus and was not seen: Enter started a Re-run nobody saw.
  const focusNow = () =>
    page.evaluate(() => {
      const at = document.activeElement;
      const row = at?.closest?.(".history-item");
      return { action: at?.dataset?.action ?? at?.tagName, text: at?.textContent, row: row?.dataset.id, opacity: at ? getComputedStyle(at).opacity : "", inPage: !!at?.isConnected, resting: at?.getAttribute?.("aria-disabled") };
    });
  const id = await first.getAttribute("data-id");
  await first.locator(".history-text").hover();
  await page.evaluate(() => window.__MOCK__.holdNext("history_rerun"));
  await first.locator('[data-action="rerun"]').click();
  await page.mouse.move(2, 2);
  await wait(page, 80);
  const running = await focusNow();
  await page.evaluate(() => window.__MOCK__.release("history_rerun"));
  await wait(page, 150);
  const rerun = { ...(await focusNow()), asked: await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === "history_rerun").map((c) => c.args.id)), unknown: await page.evaluate(() => window.__MOCK__.unknown.join()) };
  out.push(...expect(running.action === "rerun" && running.resting === "true" && running.opacity === "1" && running.text === "Transcribing…", "a Re-run that runs says so on its button, which keeps the focus and shows with the pointer gone", JSON.stringify(running)));
  out.push(
    ...expect(
      rerun.asked.join() === id && rerun.unknown === "" && rerun.action === "rerun" && rerun.row === id && rerun.inPage && rerun.opacity === "1" && rerun.text === "Re-run" && rerun.resting === null,
      "after a Re-run by mouse with the pointer gone, the focus is on the row's Re-run, which shows",
      JSON.stringify(rerun),
    ),
  );
  // "Original" and back: the button is "Original" again, has the focus, and shows.
  await first.locator(".history-text").hover();
  const original = first.locator(".history-more button").nth(1);
  await original.click();
  await original.click();
  await page.mouse.move(2, 2);
  await wait(page, 60);
  const back = await focusNow();
  out.push(...expect(back.text === "Original" && back.row === id && back.opacity === "1", "Original toggled back by mouse with the pointer gone: the button has the focus and shows", JSON.stringify(back)));
  await page.evaluate(() => document.activeElement?.blur?.());
  await wait(page, 60);
  const quiet = (await look()).rows[0];
  out.push(...expect(quiet.seen.filter(Boolean).length === 1, "once the focus has left the row it shows Copy alone again", JSON.stringify(quiet.seen)));
  return out;
}

/** The places whose right edge must be the same (the layout system, src/styles/shell.css): how to get there, and the page they are on. */
const EDGE_PLACES = [
  ["Home", "home", (page) => section(page, "home")],
  ["Files", "files", (page) => section(page, "files")],
  ["Files with a result", "files", (page) => fileLoaded(page)],
  [
    "Files with a result and a summary",
    "files",
    async (page) => {
      await page.click("#file-summarize");
      await wait(page, 400);
    },
  ],
  ["the Meetings library", "meetings", (page) => section(page, "meetings")],
  ["an open meeting with notes", "meetings", (page) => meeting(page, M1)],
  [
    "an open meeting without notes",
    "meetings",
    async (page) => {
      await page.click("#mt-back");
      await wait(page, 300);
      await meeting(page, M3);
    },
  ],
  [
    "the Soundboard with its panel",
    "soundboard",
    async (page) => {
      await page.click("#mt-back");
      await boardWith(page, true);
    },
  ],
  ["the Soundboard without its panel", "soundboard", (page) => boardWith(page, false)],
  ...["dictation", "ai", "dictionary", "models", "general"].flatMap((tab) => [
    [`Settings, ${tab}`, "settings", (page) => settings(page, tab)],
    ...(tab === "general"
      ? []
      : [
          [
            `Settings, ${tab}, Advanced open`,
            "settings",
            async (page) => {
              await page.evaluate((t) => (document.querySelector(`details.fold[data-fold="${t}"]`).open = true), tab);
              await wait(page, 80);
            },
          ],
        ]),
  ]),
];

/**
 * One left edge and one right edge for every page (the layout system's first rule). The left edge is where a
 * page's first part starts, the right edge is how far the page's content reaches: the largest right edge of
 * anything that is drawn on it. On every page, in every one of its forms, both are the same x, within 1 px.
 */
async function sameEdges(page) {
  const seen = [];
  for (const [what, id, open] of EDGE_PLACES) {
    await open(page);
    seen.push(
      await page.evaluate(
        ([what, id]) => {
          const section = document.getElementById(`section-${id}`);
          const content = document.getElementById("content");
          content.scrollTop = 0;
          let left = Infinity;
          let right = -Infinity;
          for (const el of section.querySelectorAll("*")) {
            if (!el.checkVisibility({ visibilityProperty: true }) || el.closest(".sr-only, .mt-sr-only, option")) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 1 || r.height <= 1) continue;
            // A box that is drawn: what has a ground or an edge of its own (a card, a field, a button with a
            // ground, a line under a row). A quiet text button has neither; its words start inside its box.
            const cs = getComputedStyle(el);
            const clear = (colour) => colour === "transparent" || /, 0\)$/.test(colour);
            const drawn = !clear(cs.backgroundColor) || (parseFloat(cs.borderTopWidth) > 0 && !clear(cs.borderTopColor)) || (parseFloat(cs.borderBottomWidth) > 0 && !clear(cs.borderBottomColor));
            if (!drawn) continue;
            left = Math.min(left, r.left);
            right = Math.max(right, r.right);
          }
          return { what, left: Math.round(left * 2) / 2, right: Math.round(right * 2) / 2, active: section.classList.contains("active"), sideways: content.scrollWidth > content.clientWidth + 1 };
        },
        [what, id],
      ),
    );
  }
  // The folds as the window found them.
  await page.evaluate(() => {
    for (const fold of document.querySelectorAll("details.fold[data-fold]")) fold.open = false;
  });
  const lefts = seen.map((p) => p.left);
  const rights = seen.map((p) => p.right);
  const list = (key) => seen.map((p) => `${p.what}: ${p[key]}`).join("; ");
  return [
    ...expect(seen.every((p) => p.active && !p.sideways), "the check of the pages' edges saw every place, and none scrolls sideways", JSON.stringify(seen.filter((p) => !p.active || p.sideways))),
    ...expect(Math.max(...lefts) - Math.min(...lefts) <= 1, "every page starts at the same left edge, in every one of its forms", list("left")),
    ...expect(Math.max(...rights) - Math.min(...rights) <= 1, "every page ends at the same right edge, in every one of its forms", list("right")),
  ];
}

/**
 * The steps that `layoutHolds` (Home) and `settingsHold` (Settings) do not sweep, each in a window that draws its
 * scrollbar, one pixel below the step and at it: the first run's grid (1600 px), Files without a file and with a
 * result, the Meetings library, an open meeting with notes and one without (1250 px). The form must follow the
 * room beside the sidebar alone (`offsetWidth`, the scrollbar's own room in it) and hold still. An open meeting
 * with notes always scrolls in one column and never in two, so a step decided on the width the scrollbar
 * leaves (`clientWidth`) is still one column at 1250 px: this fails then, and so does every other place where
 * a scrollbar stands at the step.
 */
async function pagesHold(run) {
  const out = [];
  const places = [
    ["firstrun", "the first run's grid", WIDER, "home", (page) => section(page, "home"), () => getComputedStyle(document.getElementById("section-home")).display === "grid"],
    ["populated", "Files without a file", ROOMY, "files", (page) => section(page, "files"), () => getComputedStyle(document.querySelector("#section-files .files-options")).display === "grid"],
    ["populated", "Files with a result", ROOMY, "files", (page) => fileLoaded(page), () => getComputedStyle(document.getElementById("section-files")).display === "grid"],
    ["populated", "the Meetings library", ROOMY, "meetings", (page) => section(page, "meetings"), () => getComputedStyle(document.getElementById("mt-list")).columnCount === "2"],
    ["populated", "an open meeting with notes", ROOMY, "meetings", (page) => meeting(page, M1), () => getComputedStyle(document.querySelector("#section-meetings .mt-body")).display === "grid"],
    [
      "populated",
      "an open meeting without notes",
      ROOMY,
      "meetings",
      async (page) => {
        await page.click("#mt-back");
        await wait(page, 300);
        await meeting(page, M3);
      },
      () => getComputedStyle(document.querySelector("#section-meetings .mt-body")).display === "grid",
    ],
  ];
  const kinds = new Set();
  for (const scenario of ["firstrun", "populated"]) {
    const win = await run.openWindow({ scenario, lang: run.lang, size: "1800x1000", url: "/", scrollbars: true });
    const { page } = win;
    try {
      const side = await page.evaluate(() => window.innerWidth - document.getElementById("content").offsetWidth);
      for (const [, what, step, id, open, form] of places.filter((p) => p[0] === scenario)) {
        await page.setViewportSize({ width: 1800, height: 1000 });
        await open(page);
        const tried = [];
        // The window heights at which the page just fits and just does not, in each form; and two plain ones
        // for the pages that take the window's height themselves.
        const fits = [];
        for (const width of [step - 1, step]) {
          await page.setViewportSize({ width: width + side, height: 3000 });
          await wait(page, 80);
          fits.push(await page.evaluate((id) => Math.round(window.innerHeight - document.getElementById("content").clientHeight + document.getElementById(`section-${id}`).scrollHeight), id));
        }
        const heights = [...new Set([...fits.filter((h) => h < 2900).flatMap((h) => [h - 1, h + 1]), 640, 900])];
        for (const width of [step - 1, step, step + 3, step + 6]) {
          for (const height of heights) {
            await page.setViewportSize({ width: width + side, height });
            await wait(page, 50);
            const two = await page.evaluate(form);
            const seen = await page.evaluate(
              () =>
                new Promise((done) => {
                  const content = document.getElementById("content");
                  const classes = () => `${[...document.querySelectorAll(".content-section.active, #home-daily")].map((el) => el.className).join("|")} ${content.offsetWidth - content.clientWidth}`;
                  let was = classes();
                  let n = 0;
                  const end = performance.now() + 100;
                  const frame = () => {
                    const now = classes();
                    if (now !== was) n++;
                    was = now;
                    if (performance.now() < end) requestAnimationFrame(frame);
                    else done({ changes: n, room: content.offsetWidth, bar: content.offsetWidth - content.clientWidth });
                  };
                  requestAnimationFrame(frame);
                }),
            );
            kinds.add(`${two ? "two" : "one"} ${seen.bar > 0 ? "with" : "without"}`);
            tried.push({ size: `${width + side}x${height}`, changes: seen.changes, two, right: two === seen.room >= step, bar: seen.bar });
          }
        }
        const moved = tried.filter((t) => t.changes > 0);
        const wrong = tried.filter((t) => !t.right);
        out.push(...expect(moved.length === 0, `${what}: the layout holds still at its step (${step} px) with a scrollbar`, `${moved.length} of ${tried.length} sizes change by themselves, e.g. ${JSON.stringify(moved.slice(0, 3))}`));
        out.push(...expect(wrong.length === 0, `${what}: the columns follow the room beside the sidebar alone, with or without a scrollbar`, `${wrong.length} of ${tried.length} sizes, e.g. ${JSON.stringify(wrong.slice(0, 3))}`));
      }
    } finally {
      await win.context.close();
    }
  }
  out.push(...expect(kinds.size === 4, "the sweep of the pages' steps sees one and two columns, each with and without the scrollbar", JSON.stringify([...kinds])));
  return out;
}

/** Is the element with this id shown (not `.hidden`)? */
const shows = (page, id) => page.evaluate((id) => !document.getElementById(id).classList.contains("hidden"), id);

/** Wait until `test` (run in the page) holds; false when it does not within `ms`. */
const until = (page, test, ms = 3000, arg) =>
  page.waitForFunction(test, arg, { timeout: ms, polling: 50 }).then(
    () => true,
    () => false,
  );

/** The sidebar's status: its kind and its text. */
const statusNow = (page) => page.evaluate(() => `${document.getElementById("status-indicator").dataset.kind}: ${document.getElementById("status-text").textContent}`);

/** Start to note every status the sidebar shows from now on (window.__statuses, each as "kind: text"). */
const noteStatuses = (page) =>
  page.evaluate(() => {
    const pill = document.getElementById("status-indicator");
    const note = () => {
      const now = `${pill.dataset.kind}: ${document.getElementById("status-text").textContent}`;
      if (window.__statuses.at(-1) !== now) window.__statuses.push(now);
    };
    window.__statuses = [];
    window.__statusNotes?.disconnect();
    window.__statusNotes = new MutationObserver(note);
    window.__statusNotes.observe(pill, { attributes: true, childList: true, characterData: true, subtree: true });
    note();
  });

/**
 * From a model's download to "Ready": once the status has said "Downloading"
 * it never steps back to "Setup needed" (the download leaves the status only
 * when the backend has said that the model is there), and it ends on "Ready".
 */
async function downloadToReady(page, what) {
  await page.evaluate(() => window.__MOCK__.finishDownload("speech"));
  const ready = await until(page, () => document.getElementById("status-indicator").dataset.kind === "ready");
  const seen = await page.evaluate(() => window.__statuses);
  const from = seen.findIndex((s) => s.startsWith("downloading"));
  const back = from >= 0 && seen.slice(from).some((s) => s.startsWith("setup"));
  return expect(ready && from >= 0 && !back && seen.some((s) => s.startsWith("loading")), `${what}: the status goes from Downloading over Loading to Ready and never back to Setup needed`, JSON.stringify(seen));
}

/** The setup's microphone as the mock's backend saw it: the page's meter calls in order, and whether the microphone is open now. */
const meterLog = (page) =>
  page.evaluate(() => ({
    calls: window.__MOCK__.calls.filter((c) => c.cmd.startsWith("mic_meter_")).map((c) => c.cmd.replace("mic_meter_", "")),
    open: window.__MOCK__.meter.open,
  }));
/** The microphone is closed, and the page's last word about it was "stop": its start is matched. */
const micClosed = async (page) => {
  await until(page, () => !window.__MOCK__.meter.open && window.__MOCK__.calls.filter((c) => c.cmd.startsWith("mic_meter_")).at(-1)?.cmd === "mic_meter_stop", 1500);
  const log = await meterLog(page);
  return { ok: !log.open && log.calls.at(-1) === "stop", log: JSON.stringify(log.calls.slice(-6)) + (log.open ? " open" : " closed") };
};
/** How often the mock's backend has opened the microphone. */
const opens = (page) => page.evaluate(() => window.__MOCK__.meter.opens);
const micOpen = async (page, ms = 1500) => {
  await until(page, () => window.__MOCK__.meter.open, ms);
  const log = await meterLog(page);
  return { ok: log.open && log.calls.at(-1) === "start", log: JSON.stringify(log.calls.slice(-6)) + (log.open ? " open" : " closed") };
};

/**
 * A failure the check brings about is written to the console by the page,
 * and an error in the console is a finding. From here to `logged` the
 * errors that match `pattern` are kept from the console and counted.
 */
const awaitError = (page, pattern) =>
  page.evaluate((source) => {
    const real = window.__consoleError ?? console.error;
    window.__consoleError = real;
    window.__awaited = 0;
    console.error = (...args) => (new RegExp(source).test(args.map(String).join(" ")) ? window.__awaited++ : real.apply(console, args));
  }, pattern.source);
/** How many of the awaited errors the page wrote; the console is itself again. */
const logged = (page) =>
  page.evaluate(() => {
    console.error = window.__consoleError;
    return window.__awaited;
  });

/** The window as the page learns of it: hidden to the tray or minimized (it loses the focus), and back in front. */
const windowGoes = (page, how) =>
  page.evaluate((how) => {
    Object.assign(window.__MOCK__.window, how);
    window.dispatchEvent(new Event("blur"));
  }, how);
const windowComes = (page) =>
  page.evaluate(() => {
    Object.assign(window.__MOCK__.window, { visible: true, minimized: false });
    window.dispatchEvent(new Event("focus"));
  });

/**
 * The page has started: the settings are shown, every first answer is drawn (the status, the microphones,
 * the history, the AI's state, the models on disk) and every page is wired. The page says so itself
 * (`data-started` on the body, src/main.ts). It does not wait for the graphics cards: a driver that hangs
 * never answers. There is no font to wait for: the window writes in Windows' own.
 */
async function started(page) {
  await until(page, () => document.body?.dataset.started === "true" && !!document.getElementById("status-indicator").dataset.kind, 10_000);
}

/** A new start of the page, waited for by what it shows instead of by the clock. */
async function restart(page) {
  await page.reload({ waitUntil: "load" });
  await started(page);
}

/**
 * A new start of the page on Home, as the first run finds it (the mock forgets what was downloaded).
 * Where the window starts on Home (it does while the setup is not done) nothing is pressed: a click
 * counts as a touch of the window, and the setup's level would start with it.
 */
async function again(page) {
  await restart(page);
  if (await page.evaluate(() => document.getElementById("section-home").classList.contains("active"))) await wait(page);
  else await section(page, "home");
}

/** The look of the steps: each step's state, the page's primary buttons that show, and the texts. */
const stepsNow = (page) =>
  page.evaluate(() => {
    const text = (id) => document.getElementById(id).textContent.trim();
    const visible = (el) => el.checkVisibility();
    return {
      states: ["setup-mic", "setup-model", "setup-key"].map((id) => document.getElementById(id).dataset.state).join(),
      marks: [...document.querySelectorAll("#home-setup .setup-num")].map((el) => el.textContent).join(""),
      primary: [...document.querySelectorAll("#section-home .btn-primary")].filter(visible).map((el) => el.id),
      mic: text("setup-mic-text"),
      model: text("setup-model-text"),
      button: text("setup-model-download"),
      resting: document.getElementById("setup-model-download").getAttribute("aria-disabled") === "true",
      retry: visible(document.getElementById("setup-mic-retry")),
      meter: visible(document.getElementById("setup-level")),
      numbers: text("setup-model-numbers"),
      bar: visible(document.getElementById("setup-model-progress")),
      focus: document.activeElement?.id ?? "",
      title: text("home-title"),
    };
  });

/**
 * A speech model that is there and did not load is "Setup needed" in the
 * status, and no step of the setup: Home shows its notice with the way to
 * Models & GPU, not the steps.
 */
async function loadFailed(page) {
  const out = [];
  // The backend says so whenever it is asked (the window asks again when it gets the focus).
  const report = (speech) =>
    page.evaluate(async (speech) => {
      window.__MOCK__.speech = speech;
      window.__MOCK__.emit("speech-status", await window.__TAURI_INTERNALS__.invoke("speech_status"));
    }, speech);
  await report({ downloaded: true, load: "failed", device: "" });
  await wait(page, 150);
  const failed = await page.evaluate(() => ({
    notice: document.getElementById("home-notice").checkVisibility(),
    said: [document.getElementById("home-live").textContent === document.querySelector("#home-notice .notice-text").textContent, document.getElementById("home-live").getAttribute("role"), document.getElementById("home-notice").getAttribute("role")],
    steps: document.getElementById("home-setup").checkVisibility(),
    daily: document.getElementById("home-daily").checkVisibility(),
    kind: document.getElementById("status-indicator").dataset.kind,
  }));
  out.push(...expect(failed.notice && !failed.steps && failed.daily && failed.kind === "setup", "a speech model that did not load: the status says Setup needed, Home shows its notice and not the steps", JSON.stringify(failed)));
  await page.click("#home-notice-open");
  await wait(page);
  const at = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
  out.push(...expect(at[0] === "model-select" && at[1], "the notice leads to the speech model in Models & GPU", JSON.stringify(at)));
  await report(null);
  await section(page, "home");
  // A notice that is only un-hidden changes no text: its sentence is written into a line that is there from the start.
  out.push(...expect(failed.said[0] && failed.said[1] === "status" && failed.said[2] === null, "the notice's sentence is written into a line that is read out when the notice shows", JSON.stringify(failed.said)));
  out.push(...expect(!(await shows(page, "home-notice")) && (await page.evaluate(() => document.getElementById("home-live").textContent)) === "", "the notice goes when the model's state is good again, and the line that read it out is empty"));
  return out;
}

/**
 * Someone is at the window (the pointer moves on it now and then), or nobody
 * is. The setup's level is started only for a user who touched the window in
 * the last minute; a page that was loaded again has nobody at it.
 */
const present = (page, on = true) =>
  page.evaluate((on) => {
    clearInterval(window.__present);
    window.__present = on ? setInterval(() => window.dispatchEvent(new Event("pointermove")), 250) : 0;
    if (on) window.dispatchEvent(new Event("pointermove"));
  }, on);

/** Step 1's level as the page shows it and as the mock's backend has it. */
const levelNow = (page) =>
  page.evaluate(() => {
    const row = document.getElementById("setup-meter");
    const bar = document.getElementById("setup-level");
    return {
      starts: window.__MOCK__.calls.filter((c) => c.cmd === "mic_meter_start").length,
      open: window.__MOCK__.meter.open,
      device: window.__MOCK__.meter.device,
      bar: bar.checkVisibility(),
      // Words in the bar's place: the level rests.
      rests: row.checkVisibility() && !bar.checkVisibility(),
      hint: document.getElementById("setup-mic-hint").textContent,
      height: Math.round(document.getElementById("setup-mic").getBoundingClientRect().height),
    };
  });

/** Where the steps stand, and what stands above them. */
const placeNow = (page) =>
  page.evaluate(() => {
    const heading = document.getElementById("home-title");
    const title = heading.getBoundingClientRect();
    const pill = document.getElementById("home-status").getBoundingClientRect();
    return {
      top: Math.round(document.getElementById("home-setup").getBoundingClientRect().top),
      title: heading.textContent,
      pill: document.getElementById("home-status-text").textContent,
      beside: pill.top < title.bottom && pill.left >= title.right,
      lines: Math.round(title.height / parseFloat(getComputedStyle(heading).lineHeight)),
    };
  });

/** What the backend reports of the speech model from now on (null: as the settings and the downloads have it). */
const reportSpeech = (page, speech) =>
  page.evaluate(async (speech) => {
    window.__MOCK__.speech = speech;
    window.__MOCK__.emit("speech-status", await window.__TAURI_INTERNALS__.invoke("speech_status"));
  }, speech);

/** Press a button twice in one go, as a double click or a held Enter does; whether it rested after the first press. */
const pressTwice = (page, id) =>
  page.evaluate((id) => {
    const button = document.getElementById(id);
    button.focus();
    button.click();
    const rested = button.getAttribute("aria-disabled") === "true";
    button.click();
    return rested;
  }, id);

/**
 * Nobody is at the window any more (another app covers it, the PC is locked, it slept): the page hears
 * nothing of that. Here the backend's limit is 2.5 s instead of two minutes. For the minute after the
 * last touch the level is started again; after it the microphone stays closed, and the step says so.
 *
 * In a window of its own whose clocks and timers are Playwright's, so the minute passes in a moment.
 * The page measures it on two clocks (`performance.now()` and `Date.now()`): both must be the faked ones.
 */
async function restsAlone(run) {
  const win = await run.openWindow({ scenario: "firstrun", lang: run.lang, size: run.size, url: "/" });
  const { page } = win;
  try {
    await page.clock.install();
    await win.load(); // from this load on, every clock and timer of the page is Playwright's
    // The first run starts on Home, and nothing has touched the window yet (a click on Home would).
    await page.evaluate(() => (window.__MOCK__.meter.cap = 2500));
    const clocks = () => page.evaluate(() => ({ running: Math.round(performance.now()), wall: Date.now() }));
    const real = Date.now();
    const from = await clocks();
    await page.mouse.move(420, 320);
    await micOpen(page);
    const starts = async () => (await levelNow(page)).starts;
    const before = await starts();
    await page.clock.runFor(20_000);
    const meanwhile = (await starts()) - before;
    await page.clock.runFor(50_000);
    const left = await levelNow(page);
    await page.clock.runFor(9000);
    const still = await levelNow(page);
    const to = await clocks();
    // What passed on the page's two clocks, and how long that took.
    const passed = { running: to.running - from.running, wall: to.wall - from.wall, real: Date.now() - real };
    let mic = await micClosed(page);
    const out = expect(passed.running >= 79_000 && passed.wall >= 79_000 && passed.real < 40_000, "the minute's check runs on a faked clock: both of the page's clocks, and it takes no minute", JSON.stringify(passed));
    out.push(...expect(meanwhile >= 1 && mic.ok && !still.open && still.starts === left.starts && still.rests, "a minute after the last touch the level is no longer started again: the microphone stays closed, and the step says that the level rests", JSON.stringify({ meanwhile, left, still, mic })));
    // The user is back: the level is too, at the first touch.
    await page.evaluate(() => (window.__MOCK__.meter.cap = 120_000));
    await page.mouse.move(430, 330);
    mic = await micOpen(page);
    const level = await levelNow(page);
    out.push(...expect(mic.ok && level.bar && level.starts === still.starts + 1, "the next touch starts the level again, without a click", JSON.stringify({ mic, level })));
    return [...out, ...win.problems.splice(0)];
  } finally {
    await win.context.close();
  }
}

/** The first run on Home, walked through as a new user would (and as the backend can interrupt it). */
async function firstRun(page, run) {
  const out = [];
  const de = run.lang === "de";
  // What the setup does (when the microphone opens and closes, what a button starts, what a new start
  // remembers) depends neither on the window's size nor on the language: it is walked through in one view.
  // Every view goes through the states the steps can be in, for how they look and where they stand.
  const once = run.size === BEHAVIOUR && !de;
  const slow = once; // what takes seconds
  const starts = async () => (await levelNow(page)).starts;
  /** A new start of the page on Home; with `user`, someone is at the window from then on. */
  const fresh = async (user = true) => {
    await again(page);
    if (user) await present(page);
  };
  /** Where the steps stood in each state of the setup: they must not move. */
  const places = [];
  const place = async (state) => places.push({ state, ...(await placeNow(page)) });

  // ── The steps instead of the daily view; what is done looks done; one thing to do. ──
  // The page as it starts, with nobody at the window yet: it starts on Home by itself.
  await fresh(false);
  await wait(page, 400);
  out.push(...expect((await shows(page, "home-setup")) && !(await shows(page, "home-daily")), "the first run shows the setup steps"));
  let now = await stepsNow(page);
  out.push(...expect(now.states === "done,todo,done" && now.marks === "✓2✓", "the microphone and the key are done, the speech model is to do", JSON.stringify(now)));
  out.push(...expect(now.primary.join() === "setup-model-download" && !now.resting, "Download is the page's one primary button", JSON.stringify(now.primary)));
  out.push(...expect(/RTX 5080/.test(now.model) && /Large\sv3\sTurbo\sq8\s·\s870\sMB$/.test(now.model), "the speech model is the one for this PC's graphics card, named with its size", now.model));
  out.push(...expect(/Realtek/.test(now.mic) && !now.retry, "the microphone is named", JSON.stringify(now)));
  const card = await page.evaluate(() => [document.getElementById("home-ai-card").checkVisibility(), document.getElementById("setup-ai-text").textContent]);
  out.push(...expect(card[0] && /Gemma\s4\sE4B, 5\.0\sGB/.test(card[1]), "the optional AI cleanup card names its model and size", JSON.stringify(card)));
  // Every button says what it acts on: two read "Download", two "Change".
  const names = await page.evaluate(() => ["setup-mic-change", "setup-model-download", "setup-key-change", "setup-ai-download"].map((id) => document.getElementById(id).getAttribute("aria-label") ?? ""));
  out.push(...expect(new Set(names).size === 4 && names.every((name) => name.length > 12), "the two Download and the two Change buttons have names of their own", JSON.stringify(names)));

  // ── The microphone is open only for someone who is at a window that shows the steps. ──
  let level = await levelNow(page);
  out.push(...expect(level.starts === 0 && !level.open && level.rests && level.hint.length > 20, "a window nobody has touched opens no microphone: the step says in words that the level rests", JSON.stringify(level)));
  await place("nobody has touched the window");
  const atRest = level.height;
  if (once) {
    // The window stands open beside other work and is not the one in front: a pointer that crosses it is no use of it.
    await page.evaluate(() => (document.hasFocus = () => false));
    await page.mouse.move(400, 300);
    await page.mouse.move(410, 310);
    await wait(page, 300);
    const crossed = await levelNow(page);
    await page.evaluate(() => delete document.hasFocus);
    out.push(...expect(crossed.starts === 0 && !crossed.open && crossed.rests, "a pointer that moves over a window without the focus opens no microphone", JSON.stringify(crossed)));
  }
  // The first touch brings the level, without a click.
  await page.mouse.move(420, 320);
  let mic = await micOpen(page);
  level = await levelNow(page);
  out.push(...expect(mic.ok && level.bar && !level.rests && level.height === atRest, "the first touch of the window starts the level, without a click, and the step keeps its height", JSON.stringify({ mic, level, atRest })));
  await place("the level runs");
  await present(page);
  if (once) {
    const moved = await page.evaluate(() => {
      window.__MOCK__.emit("mic-level", 0.5);
      return [document.getElementById("setup-level-fill").style.width, document.getElementById("setup-level").getAttribute("aria-valuenow")];
    });
    out.push(...expect(moved[0] === "50%" && moved[1] === "50", "the level bar follows the microphone", JSON.stringify(moved)));
    await section(page, "files");
    mic = await micClosed(page);
    out.push(...expect(mic.ok, "leaving Home closes the microphone", mic.log));
    await section(page, "home");
    mic = await micOpen(page);
    out.push(...expect(mic.ok, "back on Home the microphone is open again", mic.log));
    // The window hides: the webview says so, …
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    mic = await micClosed(page);
    out.push(...expect(mic.ok, "a hidden page closes the microphone", mic.log));
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    mic = await micOpen(page);
    out.push(...expect(mic.ok, "the page shows again: the microphone is open", mic.log));
    // … or it does not (a window in the tray or minimized still calls its page visible): the window is asked.
    for (const [how, name] of [[{ visible: false }, "closed to the tray"], [{ minimized: true }, "minimized"]]) {
      await windowGoes(page, how);
      mic = await micClosed(page);
      out.push(...expect(mic.ok, `a window that is ${name} closes the microphone`, mic.log));
      await windowComes(page);
      mic = await micOpen(page);
      out.push(...expect(mic.ok, `back from being ${name} the microphone is open again`, mic.log));
    }
    // Start, stop, start in quick succession, the first start slow to open: its "stopped" arrives after the
    // second start's answer. The page must still know that the microphone is open (it starts nothing a third
    // time), and close it.
    await section(page, "files");
    const startsBefore = await starts();
    await page.evaluate(() => {
      const go = (name) => document.querySelector(`.nav-item[data-section="${name}"]`).click();
      window.__MOCK__.meter.delay = 250;
      go("home");
      go("files");
      window.__MOCK__.meter.delay = 20;
      go("home");
    });
    await wait(page, 600);
    mic = await micOpen(page);
    const startsAdded = (await starts()) - startsBefore;
    out.push(...expect(mic.ok && startsAdded === 2, "after start, stop, start in quick succession the microphone is open, by the second start", `${mic.log}, ${startsAdded} starts`));
    await page.evaluate(() => {
      window.__MOCK__.meter.delay = 0;
      document.querySelector('.nav-item[data-section="files"]').click();
    });
    mic = await micClosed(page);
    out.push(...expect(mic.ok, "and it is closed again when Home is left: an overtaken start's late answer changes nothing", mic.log));
    await section(page, "home");

    // Every call to the backend is a request of its own: two that are sent in one go can arrive swapped.
    // Start, stop, and the stop arrives first: the start opens the microphone after the page's last word.
    await section(page, "files");
    await micClosed(page);
    let opened = await opens(page);
    await page.evaluate(() => {
      window.__MOCK__.meter.swap = "stop";
      document.querySelector('.nav-item[data-section="home"]').click();
      document.querySelector('.nav-item[data-section="files"]').click();
    });
    let swapped = await until(page, (n) => window.__MOCK__.meter.opens === n + 1, 1500, opened);
    mic = await micClosed(page);
    out.push(...expect(swapped && mic.ok, "a stop that arrives before the start that was sent before it: the microphone ends closed", `${swapped ? "the start opened it" : "the start never opened it"}, ${mic.log}`));
    // Start, stop, start, and the first start arrives last and opens first, while the window goes to the tray
    // (the page is not told): the second start is answered "stopped", and nothing is started after it.
    opened = await opens(page);
    await page.evaluate(() => {
      const go = (name) => document.querySelector(`.nav-item[data-section="${name}"]`).click();
      window.__MOCK__.window.visible = false;
      window.__MOCK__.meter.swap = "start";
      window.__MOCK__.meter.delays = [80, 0];
      go("home");
      go("files");
      go("home");
    });
    swapped = await until(page, (n) => window.__MOCK__.meter.opens === n + 1, 1500, opened);
    await wait(page, 200);
    mic = await micClosed(page);
    out.push(...expect(swapped && mic.ok, "a start that arrives after the start that was sent after it: the microphone ends closed when the page wants none", `${swapped ? "the older start opened it" : "the older start never opened it"}, ${mic.log}`));
    await windowComes(page);
    mic = await micOpen(page);
    out.push(...expect(mic.ok, "and it is open again for the window that is back", mic.log));

    // A window that cannot say whether it shows: the microphone closes, and stays closed for a user who is there.
    await micOpen(page);
    await awaitError(page, /the window's state/);
    await page.evaluate(() => {
      window.__MOCK__.window.broken = true;
      window.dispatchEvent(new Event("blur"));
    });
    mic = await micClosed(page);
    await wait(page, 600);
    const dark = await meterLog(page);
    await page.evaluate(() => (window.__MOCK__.window.broken = false));
    const unanswered = await logged(page);
    out.push(...expect(mic.ok && !dark.open && dark.calls.at(-1) === "stop" && unanswered >= 1, "a window that does not say whether it shows: the microphone is closed and stays closed", JSON.stringify({ mic, dark: dark.calls.slice(-4), unanswered })));
    await windowComes(page);
    mic = await micOpen(page);
    out.push(...expect(mic.ok, "the window answers again: the microphone is open", mic.log));

    // A screen reader in browse mode and voice control press a control without a pointer or a key: the page
    // hears a click and nothing else. That is a touch too.
    await fresh(false);
    await page.evaluate(() => document.getElementById("home-title").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    mic = await micOpen(page);
    out.push(...expect(mic.ok, "a click alone (a screen reader, voice control) counts as a touch: the level starts", mic.log));

    // A window that starts hidden (autostart, "--start-minimized") and is slow to say so: whatever reaches
    // its page meanwhile (the focus, a key), no microphone opens, before its answer and after it.
    await page.evaluate(() => window.__MOCK__.keep({ window: { visible: false, delay: 3000 } }));
    await again(page);
    const touchIt = () =>
      page.evaluate(() => {
        for (const type of ["focus", "keydown", "pointermove"]) window.dispatchEvent(new Event(type));
      });
    await touchIt();
    await wait(page, 300);
    const early = await levelNow(page);
    await wait(page, 3600);
    await touchIt();
    await wait(page, 300);
    const late = await levelNow(page);
    out.push(...expect(early.starts === 0 && late.starts === 0 && !late.open && late.rests, "a window that starts hidden opens no microphone, neither before it has said so nor after", JSON.stringify({ early, late })));
    // The user opens it from the tray: it shows and has the focus.
    await page.evaluate(() => {
      window.__MOCK__.keep({ window: null });
      Object.assign(window.__MOCK__.window, { visible: true, delay: 0 });
      window.dispatchEvent(new Event("focus"));
    });
    mic = await micOpen(page);
    out.push(...expect(mic.ok, "opened from the tray, the window has its level", mic.log));
    await present(page);
  }

  if (slow) {
    // The backend's two-minute limit closes the microphone without a word: for a user who is there the page starts it again.
    await micOpen(page);
    let before = await starts();
    await page.evaluate(() => window.__MOCK__.meter.timeOut());
    mic = await micOpen(page, 9000);
    out.push(...expect(mic.ok && (await starts()) === before + 1, "the level that fell silent (the backend's time limit) is started again, once", mic.log));
    // The window was closed to the tray and the page was not told: silence, and the window does not show. No new start.
    await page.evaluate(() => {
      window.__MOCK__.window.visible = false;
      window.__MOCK__.meter.timeOut();
    });
    await wait(page, 7000);
    mic = await micClosed(page);
    out.push(...expect(mic.ok, "a level that fell silent in a window that no longer shows is not started again", mic.log));
    await windowComes(page);
    mic = await micOpen(page);
    out.push(...expect(mic.ok, "the window is back from the tray: the microphone is open", mic.log));

    // Nobody is at the window any more: in a window of its own, where the minute takes no time.
    out.push(...(await restsAlone(run)));

    // The microphone does not open any more, and Windows still lists it: said in words beside the step, with a
    // way to try again. The page looks once what Windows lists, and does not try over and over.
    const listed = () => page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === "list_microphones").length);
    const listedBefore = await listed();
    await awaitError(page, /the microphone meter did not start/);
    await page.evaluate(() => {
      window.__MOCK__.meter.fail = "No input device found";
      window.__MOCK__.meter.lose();
    });
    await until(page, () => document.getElementById("setup-mic").dataset.state === "problem", 9000);
    now = await stepsNow(page);
    before = await starts();
    await wait(page, 3000);
    const later = await starts();
    const tries = await logged(page);
    const looked = (await listed()) - listedBefore;
    out.push(...expect(now.states === "problem,todo,done" && now.retry && !now.meter && now.mic.length > 30 && later === before && tries === 1 && looked === 1, "a microphone that does not open is said beside its step, with Retry; the page looks once what Windows lists and does not try over and over", JSON.stringify({ ...now, before, later, tries, looked })));
    out.push(...expect(now.primary.join() === "setup-model-download", "Download stays the one primary button beside a microphone that failed", JSON.stringify(now.primary)));
    const heard = await page.evaluate(() => [document.querySelector("#setup-mic .setup-state").textContent, document.getElementById("setup-mic-retry").getAttribute("aria-label")]);
    out.push(...expect(/attention|Aufmerksamkeit/.test(heard[0]) && (heard[1] ?? "").length > 12, "a step with a problem says so to a screen reader, and its Retry says what it tries", JSON.stringify(heard)));
    // It was the only one, and it is unplugged: Retry finds that out, and the step says what is the matter.
    await awaitError(page, /the microphone meter did not start/);
    await page.evaluate(() => window.__MOCK__.keep({ mics: [] }));
    await page.click("#setup-mic-retry");
    await wait(page, 300);
    now = await stepsNow(page);
    const none = await page.evaluate(() => document.getElementById("setup-mic-retry").textContent);
    out.push(...expect(now.states === "problem,todo,done" && none === "Check again" && /No microphone found/.test(now.mic) && (await starts()) === later && (await logged(page)) === 0, "Retry after the only microphone was unplugged: the step says that there is none, and opens nothing", JSON.stringify({ ...now, none })));
    // Plugged in again.
    await page.evaluate(() => {
      window.__MOCK__.keep({ mics: null });
      window.__MOCK__.meter.fail = null;
    });
    await page.click("#setup-mic-retry");
    mic = await micOpen(page);
    now = await stepsNow(page);
    out.push(...expect(mic.ok && now.states === "done,todo,done" && now.meter && !now.retry, "Check again opens the microphone that is back", JSON.stringify({ mic, now })));

    // The graphics cards take long to answer: after five seconds the step offers what fits every PC, and
    // the answer still counts when it comes before anything was started.
    await page.evaluate(() => window.__MOCK__.keep({ gpus: 7500 }));
    await fresh();
    await wait(page, 1500);
    const asking = await stepsNow(page);
    await until(page, () => document.getElementById("setup-model-download").checkVisibility(), 6000);
    const offered = await stepsNow(page);
    await until(page, () => /RTX 5080/.test(document.getElementById("setup-model-text").textContent), 6000);
    const known = await stepsNow(page);
    await page.evaluate(() => window.__MOCK__.keep({ gpus: null }));
    out.push(...expect(asking.button === "" && !/Small|RTX/.test(asking.model) && /Small/.test(offered.model) && !/graphics card/.test(offered.model) && offered.button === "Download" && offered.primary.join() === "setup-model-download" && /RTX 5080/.test(known.model) && /Large\sv3\sTurbo/.test(known.model), "while the graphics cards do not answer the step waits five seconds, then offers the model for every PC, and takes the answer when it comes", JSON.stringify([asking.model, offered.model, known.model])));
  }

  // ── The cloud engine without its key: no welcome, and the pill says only what is missing. ──
  await fresh();
  await page.evaluate(() => document.getElementById("engine-cloud").click());
  await wait(page, 250);
  now = await stepsNow(page);
  out.push(...expect(now.states === "done,todo,done" && /Groq/.test(now.model) && now.primary.join() === "setup-model-download" && !/Welcome|Willkommen/.test(now.title), "with the cloud engine step 2 asks for the API key", JSON.stringify(now)));
  await place("the cloud engine without its key");

  // ── No microphone: said beside step 1 with a way to look again; nothing is opened; Download stays the thing to do. ──
  await page.evaluate(() => window.__MOCK__.keep({ mics: [] }));
  await fresh();
  now = await stepsNow(page);
  let log = await meterLog(page);
  out.push(...expect(now.states === "problem,todo,done" && now.retry && !now.meter && now.mic.length > 30 && log.calls.length === 0 && !log.open, "without a microphone step 1 says so, offers to look again and opens nothing", JSON.stringify({ ...now, log })));
  out.push(...expect(now.primary.join() === "setup-model-download", "Download stays the one primary button without a microphone", JSON.stringify(now.primary)));
  await place("no microphone");
  // The speech model is there and the microphone is not: no welcome, the pill says "No microphone", and looking again is the thing to do.
  await reportSpeech(page, { downloaded: true, load: "loaded", device: "CPU" });
  await wait(page, 150);
  now = await stepsNow(page);
  out.push(...expect(now.states === "problem,done,done" && now.primary.join() === "setup-mic-retry" && !/Welcome|Willkommen/.test(now.title), "with the model there and no microphone, Check again is the one primary button", JSON.stringify(now)));
  await place("no microphone, the speech model is there");
  await reportSpeech(page, null);
  await wait(page, 150);
  if (slow) {
    // One that is plugged in shows up by itself.
    await page.evaluate(() => window.__MOCK__.keep({ mics: null }));
    const found = await until(page, () => document.getElementById("setup-mic").dataset.state === "done", 6000);
    out.push(...expect(found && (await micOpen(page)).ok, "a microphone that is plugged in shows up in the step by itself"));
    await page.evaluate(() => window.__MOCK__.keep({ mics: [] }));
    await fresh();
  }
  await page.evaluate(() => window.__MOCK__.keep({ mics: null }));

  if (once) {
    await page.click("#setup-mic-retry");
    mic = await micOpen(page);
    now = await stepsNow(page);
    out.push(...expect(mic.ok && now.states === "done,todo,done" && now.meter && !now.retry, "Check again finds the microphone that was plugged in", JSON.stringify({ mic, now })));
    out.push(...expect(now.focus === "setup-mic-change", "Check again goes when it has found one: the keyboard focus it had is on Change", now.focus));

    // Another microphone, chosen in place. The save takes a moment (a busy backend) and the page is drawn
    // again meanwhile: the level opens the new microphone only once it is saved, and it is that one's.
    const usb = "Headset (USB Audio)";
    await page.evaluate((usb) => window.__MOCK__.keep({ mics: [{ name: "Microphone (Realtek(R) Audio)", is_default: true }, { name: usb, is_default: false }] }), usb);
    await fresh();
    await micOpen(page);
    const first = await levelNow(page);
    await page.click("#setup-mic-change");
    const picking = await page.evaluate(() => [document.activeElement.id, document.getElementById("setup-mic-change").checkVisibility(), document.getElementById("setup-mic-select").options.length]);
    out.push(...expect(picking[0] === "setup-mic-select" && !picking[1] && picking[2] === 3, "Change shows the microphones in place and gives the list the focus", JSON.stringify(picking)));
    await page.evaluate(() => (window.__MOCK__.saveDelay = 400));
    await page.selectOption("#setup-mic-select", usb);
    await page.evaluate(() => window.__MOCK__.emit("recording-state", "Ready"));
    await wait(page, 150);
    const during = await levelNow(page);
    await until(page, (usb) => window.__MOCK__.meter.device === usb, 2000, usb);
    const second = await levelNow(page);
    const chosen = await page.evaluate(() => [window.__MOCK__.settings().microphone, document.getElementById("mic-select").value]);
    await page.evaluate(() => (window.__MOCK__.saveDelay = 0));
    out.push(...expect(/Realtek/.test(first.device) && during.starts === first.starts && /Realtek/.test(during.device) && second.starts === first.starts + 1 && second.open && second.device === usb && chosen[0] === usb && chosen[1] === usb, "a microphone chosen in the step is saved first; then the level opens it, and it is that microphone's", JSON.stringify({ first, during, second, chosen })));
    await page.evaluate(() => window.__MOCK__.keep({ mics: null }));
    // The dictation key, changed in place by the capture every key has; Settings shows the same key.
    await page.click("#setup-key-change");
    await wait(page, 80);
    const listening = await page.evaluate(() => document.getElementById("setup-hotkey-btn").classList.contains("capturing"));
    await page.keyboard.press("Control+Alt+KeyD");
    await wait(page, 200);
    const keys = await page.evaluate(() => [document.getElementById("setup-hotkey-text").textContent, document.getElementById("hotkey-text").textContent, document.getElementById("home-hotkey-text").textContent]);
    out.push(...expect(listening && keys.every((k) => k === "Ctrl+Alt+D"), "the dictation key is changed in the step and shows in Settings and on Home", JSON.stringify([listening, keys])));

    // The model arrives while the microphone is missing: the steps stay, Download goes, and the keyboard
    // focus it had is on the thing to do next.
    await page.evaluate(() => window.__MOCK__.keep({ mics: [] }));
    await fresh();
    await page.click("#setup-model-download");
    await until(page, () => window.__MOCK__.calls.some((c) => c.cmd === "download_model"));
    await page.evaluate(() => window.__MOCK__.finishDownload("speech"));
    await until(page, () => document.getElementById("setup-model").dataset.state === "done");
    await wait(page, 500);
    const next = await page.evaluate(() => [document.activeElement?.id ?? "", document.getElementById("home-setup").checkVisibility(), document.getElementById("setup-model-download").checkVisibility()]);
    out.push(...expect(next[0] === "setup-mic-retry" && next[1] && !next[2], "Download goes when the model is there: the keyboard focus it had is on Check again", JSON.stringify(next)));
    await page.evaluate(() => window.__MOCK__.keep({ mics: null }));

    // The cloud engine: the step's button leads to the key field; with the key the setup is done.
    await fresh();
    await settings(page, "models");
    await page.evaluate(() => document.getElementById("engine-cloud").click());
    await wait(page, 200);
    await section(page, "home");
    await page.click("#setup-model-download");
    await wait(page);
    const key = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility(), window.__MOCK__.calls.some((c) => c.cmd === "download_model")]);
    out.push(...expect(key[0] === "groq-key" && key[1] && !key[2], "the step's button leads to the key field in Models & GPU and downloads nothing", JSON.stringify(key)));
    await page.fill("#groq-key", "gsk_check");
    await page.evaluate(() => document.getElementById("groq-key").dispatchEvent(new Event("change", { bubbles: true })));
    await wait(page, 200);
    await section(page, "home");
    mic = await micClosed(page);
    out.push(...expect((await shows(page, "home-daily")) && !(await shows(page, "home-setup")) && mic.ok, "with the key the daily view shows and the microphone is closed", mic.log));

    // The Download button in Settings (the model that is selected): the same way to Ready.
    await fresh();
    await settings(page, "models");
    await noteStatuses(page);
    await page.click("#download-btn");
    await until(page, () => document.getElementById("status-indicator").dataset.kind === "downloading");
    out.push(...(await downloadToReady(page, "Download in Settings")));
  }

  // ── The speech model: Download, percent and size, a failure in words with Retry, then the daily view. ──
  await fresh();
  const fetched = () => page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === "download_model").map((c) => c.args.modelSize));
  // Pressed twice in one go: the button rests from the first press, and one download starts.
  let rested = await pressTwice(page, "setup-model-download");
  await until(page, () => window.__MOCK__.calls.some((c) => c.cmd === "download_model"));
  await wait(page, 150);
  out.push(...expect(rested && (await fetched()).join() === "large-v3-turbo-q8_0", "Download fetches the model suggested for the graphics card, once, however often it is pressed", JSON.stringify([rested, await fetched()])));
  await page.evaluate(() => window.__MOCK__.emit("download-progress", { downloaded: 374e6, total: 870e6, percent: 43 }));
  await wait(page, 150);
  now = await stepsNow(page);
  out.push(...expect(/^43 % · 374 MB (of|von) 870 MB$/.test(now.numbers) && now.bar, "a download shows percent and size", now.numbers));
  out.push(...expect(now.resting && now.focus === "setup-model-download" && now.primary.length === 0 && now.states === "done,todo,done", "while it downloads the button rests, keeps the focus, and nothing else asks to be pressed", JSON.stringify(now)));
  out.push(...expect(/^downloading: .* 43 %$/.test(await statusNow(page)), "the status shows the first model's download", await statusNow(page)));
  await place("the speech model downloads");
  await page.evaluate(() => window.__MOCK__.emit("download-progress", { downloaded: 870e6, total: 870e6, percent: 100 }));
  await wait(page, 150);
  await place("the speech model is at 100 %");
  // The connection breaks.
  await awaitError(page, /Download failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("speech", "error sending request"));
  await until(page, () => document.getElementById("setup-model").dataset.state === "problem");
  out.push(...expect((await logged(page)) === 1, "the failed download is written to the log once"));
  now = await stepsNow(page);
  out.push(...expect(now.states === "done,problem,done" && /Large\sv3\sTurbo\sq8\s·\s870\sMB/.test(now.model) && now.model.length > 60 && !now.bar && !now.resting && now.primary.join() === "setup-model-download" && /^setup/.test(await statusNow(page)), "a download that fails is said beside its step, with the model and its size, and the button is the way to try again", JSON.stringify(now)));
  out.push(...expect(now.button === (de ? "Wiederholen" : "Retry") && now.focus === "setup-model-download", "the button reads Retry after a failed download and keeps the keyboard focus", JSON.stringify([now.button, now.focus])));
  await place("the download failed");
  // Again, to the end, and again pressed twice: every status from the press to Ready.
  await noteStatuses(page);
  rested = await pressTwice(page, "setup-model-download");
  await until(page, () => document.getElementById("status-indicator").dataset.kind === "downloading");
  out.push(...(await downloadToReady(page, "the first run's Download, pressed twice")));
  // Home is the daily view now, without a new start; the optional card stays; the microphone is closed.
  const done = await page.evaluate(() => ({
    daily: document.getElementById("home-daily").checkVisibility(),
    steps: document.getElementById("home-setup").checkVisibility(),
    card: document.getElementById("home-ai-card").checkVisibility(),
    focus: document.activeElement?.id ?? "",
    title: document.getElementById("home-title").textContent,
    how: document.getElementById("home-how").checkVisibility(),
    saved: window.__MOCK__.settings().whisperModel,
    chosen: document.getElementById("model-select").value,
  }));
  out.push(...expect(rested && done.daily && !done.steps && done.card && done.how && done.saved === "large-v3-turbo-q8_0" && done.chosen === done.saved && (await fetched()).length === 2, "once the model is there Home is the daily view with the model saved, also when Download was pressed twice, and the optional card stays", JSON.stringify({ rested, ...done, fetched: await fetched() })));
  out.push(...expect(done.focus === "home-title" && !/Welcome|Willkommen/.test(done.title), "the focus the steps had is on Home's heading, which is the daily one", JSON.stringify(done)));
  mic = await micClosed(page);
  out.push(...expect(mic.ok, "the setup is done: the microphone is closed", mic.log));
  if (once) {
    await wait(page, 1300);
    const after = await meterLog(page);
    out.push(...expect(!after.open && after.calls.at(-1) === "stop", "and it stays closed", JSON.stringify(after.calls.slice(-4))));
  }

  // The steps stood at one place in every state, under a heading of one line with the pill beside it.
  const where = JSON.stringify(places.map((p) => [p.state, p.top, p.pill, p.beside, p.lines]));
  out.push(...expect(places.length === 8 && new Set(places.map((p) => p.top)).size === 1 && places.every((p) => p.beside && p.lines === 1), "the steps stand at the same place in every state of the setup, under a one-line heading with the pill beside it", where));
  const welcome = places.filter((p) => /Welcome|Willkommen/.test(p.title));
  const plain = places.filter((p) => !welcome.includes(p));
  const short = de ? /^(Einrichtung nötig|Download \d+ %)$/ : /^(Setup needed|Downloading \d+ %)$/;
  out.push(...expect(welcome.length === 6 && welcome.every((p) => short.test(p.pill)), "beside the welcome the pill says only the short state", where));
  out.push(...expect(plain.length === 2 && plain.every((p) => p.title === (de ? "Einrichtung nötig" : "Setup needed") && p.pill.length > 8 && !p.pill.includes(":") && !p.pill.includes(p.title)), "under the heading Setup needed the pill says only the reason", JSON.stringify(plain)));

  // ── The optional card: flat at the head of the daily view; Download with percent and size, a failure with Retry, then AI cleanup is on. ──
  const flat = await page.evaluate(() => {
    const content = document.getElementById("content");
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    return {
      over: content.scrollHeight - content.clientHeight,
      height: Math.round(rect("home-ai-card").height),
      oneLine: Math.abs(rect("setup-ai-label").top - rect("setup-ai-text").top) < 6 && rect("setup-ai-text").height < 26,
      right: rect("setup-ai-download").left > rect("setup-ai-text").right,
      width: window.innerWidth,
    };
  });
  // How the card stands, to the tenth of a pixel: its height, where its text starts and ends, where its
  // button is, and where the daily view under it starts. None of it may change when Download is pressed.
  const cardNow = () =>
    page.evaluate(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      const px = (n) => Math.round(n * 10) / 10;
      const card = rect("home-ai-card");
      return [px(card.height), px(rect("setup-ai-line").left), px(rect("setup-ai-line").right), px(rect("setup-ai-download").top - card.top), px(rect("setup-ai-download").width), px(rect("home-daily").top)].join(" ");
    });
  const stands = { rests: await cardNow() };
  // The card also says where the model can be had later ("Hide" hides it for good). Wave 2 of the
  // whole-branch review shortened that sentence: at the head of the daily view the card is one line again
  // from 1200 px of window, in both languages (50 px; German stood under its title until 1322 px before).
  if (flat.width >= 1200) out.push(...expect(flat.oneLine && flat.height <= 52 && flat.right, "from 1200 px of window the optional card is one line in both languages, its buttons at the right", JSON.stringify(flat)));
  if (flat.width >= 1600) out.push(...expect(flat.over === 0, "in a large window the daily view does not scroll because of the optional card", JSON.stringify(flat)));
  // The card says where the model can be downloaded later: its button hides it for good.
  const later = await page.evaluate(() => document.getElementById("setup-ai-text").textContent);
  out.push(...expect(de ? /in den Einstellungen/.test(later) : /Settings › AI cleanup/.test(later), "the optional card says where the AI model can be downloaded later", later));
  // Pressed twice in one go: one download.
  rested = await pressTwice(page, "setup-ai-download");
  await until(page, () => window.__MOCK__.calls.some((c) => c.cmd === "ai_download_model"));
  await wait(page, 150);
  const aiAsked = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === "ai_download_model").map((c) => c.args.id));
  out.push(...expect(rested && aiAsked.join() === "gemma-4-e4b", "the card downloads the AI model suggested for the graphics card, once, however often it is pressed", JSON.stringify([rested, aiAsked])));
  await page.evaluate(() => window.__MOCK__.emit("ai-download-progress", { downloaded: 1.2e9, total: 4977171584, percent: 24.1 }));
  await wait(page, 150);
  let ai = await page.evaluate(() => [document.getElementById("setup-ai-numbers").textContent, document.getElementById("setup-ai-download").getAttribute("aria-disabled"), document.activeElement?.id]);
  out.push(...expect(/^24 % · 1\.2 GB (of|von) 5\.0 GB$/.test(ai[0]) && ai[1] === "true" && ai[2] === "setup-ai-download", "the AI model's download shows percent and size, and its button rests", JSON.stringify(ai)));
  const says = await page.evaluate(() => [document.getElementById("setup-ai-text").textContent, document.getElementById("setup-ai-dismiss").textContent, document.getElementById("status-indicator").dataset.kind, document.getElementById("status-text").textContent]);
  out.push(...expect(/turns on|Danach ist die KI-Korrektur an/.test(says[0]) && says[1] === (de ? "Ausblenden" : "Hide") && says[2] === "downloading" && / 24 %$/.test(says[3]), "while its download runs the card says that AI cleanup turns on at the end and offers to hide it, and the status shows the download", JSON.stringify(says)));
  if (flat.width >= 1600) {
    const busy = await page.evaluate(() => [Math.round(document.getElementById("home-ai-card").getBoundingClientRect().height), document.getElementById("content").scrollHeight - document.getElementById("content").clientHeight]);
    out.push(...expect(busy[0] <= 60 && busy[1] === 0, "the card stays flat while it downloads", JSON.stringify(busy)));
  }
  stands.downloads = await cardNow();
  // The bar stands on the text's row, after it, where the card is flat.
  const row = await page.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    return { text: rect("setup-ai-text"), bar: rect("setup-ai-bar"), shown: document.getElementById("setup-ai-bar").checkVisibility() };
  });
  if (flat.width >= 1200) out.push(...expect(row.shown && row.bar.left > row.text.right && row.bar.top > row.text.top && row.bar.bottom < row.text.bottom && row.bar.width >= 60, "from 1200 px of window the download's bar stands on the row of the card's text", JSON.stringify(row)));
  await awaitError(page, /ai_download_model failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("ai", "error sending request"));
  await until(page, () => document.getElementById("setup-ai-text").dataset.tone === "error");
  out.push(...expect((await logged(page)) === 1, "the failed AI download is written to the log once"));
  ai = await page.evaluate(() => [document.getElementById("setup-ai-text").dataset.tone, document.getElementById("setup-ai-download").textContent, document.getElementById("setup-ai-progress").checkVisibility(), document.getElementById("home-ai-card").checkVisibility(), document.getElementById("setup-ai-text").textContent, document.getElementById("setup-ai-dismiss").textContent, document.activeElement?.id]);
  out.push(...expect(ai[0] === "error" && ai[1] === (de ? "Wiederholen" : "Retry") && !ai[2] && ai[3] && /Gemma\s4\sE4B\s\(5\.0\sGB\)/.test(ai[4]) && ai[5] === (de ? "Ausblenden" : "Hide") && ai[6] === "setup-ai-download", "an AI download that fails is said on the card, with the model, its size and Retry, which keeps the focus", JSON.stringify(ai)));
  stands.failed = await cardNow();
  out.push(...expect(stands.downloads === stands.rests && stands.failed === stands.rests, "the optional card has one height, one place for its text and its button, and the daily view under it stays where it is, while it rests, downloads and after a failure", JSON.stringify(stands)));
  await page.click("#setup-ai-download");
  await until(page, () => window.__MOCK__.calls.filter((c) => c.cmd === "ai_download_model").length === 2);
  await page.evaluate(() => window.__MOCK__.finishDownload("ai"));
  await until(page, () => !document.getElementById("home-ai-card").checkVisibility() && window.__MOCK__.settings().aiCleanup);
  const on = await page.evaluate(() => [document.getElementById("home-ai-card").checkVisibility(), window.__MOCK__.settings().aiCleanup, window.__MOCK__.settings().aiModel, document.getElementById("home-ai-toggle").checked, document.activeElement?.id]);
  out.push(...expect(!on[0] && on[1] === true && on[2] === "gemma-4-e4b" && on[3] && on[4] === "home-title", "with its model the card goes and AI cleanup is on", JSON.stringify(on)));

  if (once) {
    // ── "Hide" closes the card, and it stays closed after a new start. ──
    await fresh();
    out.push(...expect(await shows(page, "home-ai-card"), "a new first run shows the optional card again"));
    await page.click("#setup-ai-dismiss");
    await wait(page, 100);
    const gone = [await shows(page, "home-ai-card"), await shows(page, "home-setup"), await page.evaluate(() => document.activeElement?.id ?? "")];
    await fresh();
    out.push(...expect(!gone[0] && gone[1] && !(await shows(page, "home-ai-card")) && (await shows(page, "home-setup")), "Hide closes the card for good, and the steps stay", JSON.stringify(gone)));
    out.push(...expect(gone[2] === "home-title", "the focus Hide had is on Home's heading", gone[2]));
    // Hidden while its download runs: the download goes on, and AI cleanup turns on at its end, as the card said.
    await page.evaluate(() => localStorage.removeItem("rudariflow-ui"));
    await fresh();
    await page.click("#setup-ai-download");
    await until(page, () => window.__MOCK__.calls.some((c) => c.cmd === "ai_download_model"));
    await page.click("#setup-ai-dismiss");
    await wait(page, 100);
    const hidden = !(await shows(page, "home-ai-card"));
    await page.evaluate(() => window.__MOCK__.finishDownload("ai"));
    const turned = await until(page, () => window.__MOCK__.settings().aiCleanup === true && document.getElementById("home-ai-toggle").checked);
    out.push(...expect(hidden && turned, "a card that is hidden while it downloads still ends with AI cleanup on", JSON.stringify([hidden, turned])));
    await fresh();

    // A speech model that is there and does not load is no step: the notice, not the steps.
    out.push(...(await loadFailed(page)));
  }

  // Every start of the microphone was matched: it is closed on another page, and the page's last word was "stop".
  await section(page, "files");
  mic = await micClosed(page);
  out.push(...expect(mic.ok, "at the end of the walk the microphone is closed", mic.log));

  // The picture is the first run as a new user finds it, the pointer on the window.
  await page.evaluate(() => localStorage.removeItem("rudariflow-ui"));
  await again(page);
  await page.mouse.move(425, 325);
  // With the level in it: the bar is empty until the microphone's first level has arrived.
  await until(page, () => window.__MOCK__.meter.open && parseFloat(document.getElementById("setup-level-fill").style.width) > 0);
  return out;
}

// ── Settings: a model's download on its row, the two columns ──

/** Run in the page: set a control's value as a user would (it may stand in a closed fold). */
const choose = (page, id, value) =>
  page.evaluate(
    ([id, value]) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [id, value],
  );

/** A download of this kind has been asked for and waits in the mock ("download_model" or "ai_download_model"); `n`: that many times so far. */
const asked = (page, cmd, n = 1) => until(page, ([cmd, n]) => window.__MOCK__.calls.filter((c) => c.cmd === cmd).length >= n, 3000, [cmd, n]);

/** A report of the download that waits: 43 % of `total` bytes. */
const report = (page, event, total, percent = 43) => page.evaluate(([event, total, percent]) => window.__MOCK__.emit(event, { downloaded: (total * percent) / 100, total, percent }), [event, total, percent]);

/**
 * Start to note what every live region in the window is given to read out
 * (window.__live: its id, or its tag and class, to the texts in order). A
 * download reports ten times a second: nothing that is read out may follow it.
 */
const noteLive = (page) =>
  page.evaluate(() => {
    for (const o of window.__liveNotes ?? []) o.disconnect();
    window.__liveNotes = [];
    window.__live = {};
    for (const el of document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')) {
      const key = el.id || `${el.tagName.toLowerCase()}.${el.className}`;
      const o = new MutationObserver(() => {
        const texts = (window.__live[key] ??= []);
        if (texts.at(-1) !== el.textContent) texts.push(el.textContent);
      });
      o.observe(el, { childList: true, characterData: true, subtree: true });
      window.__liveNotes.push(o);
    }
  });
/** What was read out since `noteLive`, per live region; those of Settings, and the sidebar's status. */
const liveNoted = (page) =>
  page.evaluate(() => {
    const inSettings = (key) => !!document.getElementById(key)?.closest("#section-settings");
    const all = Object.entries(window.__live);
    return { settings: Object.fromEntries(all.filter(([key]) => inSettings(key))), status: window.__live["status-live"] ?? [], all: Object.fromEntries(all) };
  });
/** What a live region said: a region that was emptied says nothing by that. */
const spoken = (texts = []) => texts.filter(Boolean);
/** At most two texts per live region of Settings (the start and the end), and no number in what the sidebar says. */
const liveOk = (noted) => Object.values(noted.settings).every((texts) => spoken(texts).length <= 2) && noted.status.every((text) => !/\d/.test(text));

/**
 * What a probe finds out about behaviour (what is saved, what is said, what a button does) is the same in a window
 * of any size: such a part runs once per data set and language, in the window of this size. What depends on the
 * window (where something stands, whether it is in view) is looked at in every size, as are the checks of the page
 * itself and its pictures.
 */
const BEHAVIOUR = "1600x900";

/** Every answer of the mocked backend is `ms` late from now on (0: at once again). */
const slowAnswers = (page, ms) => page.evaluate((ms) => (window.__MOCK__.answerDelay = ms), ms);

/** The download that waits in the mock fails, with the backend's reason; the page's own line in the log about it is expected, not a finding. */
async function failNow(page, kind, why) {
  await awaitError(page, kind === "ai" ? /ai_download_model failed/ : /Download failed/);
  await page.evaluate(([kind, why]) => window.__MOCK__.failDownload(kind, why), [kind, why]);
  const note = kind === "ai" ? "ai-model-note" : "model-note";
  const select = kind === "ai" ? "ai-model-select" : "model-select";
  await until(page, ([note, select]) => document.getElementById(note).dataset.tone === "error" && !document.getElementById(select).disabled, 3000, [note, select]);
  await wait(page, 150);
  return logged(page);
}

/** What the backend says when the disk is full, and when the connection breaks (the mock's own word). */
const DISK_FULL = "There is not enough space on the disk. (os error 112)";
const NO_LINE = "error sending request";

/** A model row's download as it shows: the bar and its numbers under the row, and what the bar says to a screen reader. */
const downloadNow = (page, ids) =>
  page.evaluate((ids) => {
    const box = document.getElementById(ids.box);
    const bar = document.getElementById(ids.bar);
    const numbers = document.getElementById(ids.numbers);
    const row = document.getElementById(ids.select).closest(".setting-row");
    const note = document.getElementById(ids.note);
    const r = box.getBoundingClientRect();
    const content = document.getElementById("content").getBoundingClientRect();
    return {
      shown: box.checkVisibility(),
      // Under its row, in the row's card.
      onRow: box.previousElementSibling === row && Math.abs(r.top - row.getBoundingClientRect().bottom) < 2,
      inView: box.checkVisibility() && r.top >= content.top && r.bottom <= Math.min(content.bottom, window.innerHeight),
      numbers: numbers.textContent,
      width: document.getElementById(ids.fill).style.width,
      role: bar.getAttribute("role"),
      now: bar.getAttribute("aria-valuenow"),
      range: `${bar.getAttribute("aria-valuemin")}-${bar.getAttribute("aria-valuemax")}`,
      said: bar.getAttribute("aria-valuetext"),
      named: document.getElementById(bar.getAttribute("aria-labelledby"))?.textContent ?? "",
      label: row.querySelector(".label-text").textContent,
      live: numbers.getAttribute("role") ?? numbers.getAttribute("aria-live") ?? "",
      select: document.getElementById(ids.select).value,
      resting: document.getElementById(ids.select).disabled,
      note: note.textContent,
      tone: note.dataset.tone ?? "",
      noteRetry: note.querySelector("button")?.getAttribute("aria-label") ?? null,
      button: ids.buttons.map((id) => {
        const b = document.getElementById(id);
        return { id, shown: b.checkVisibility(), key: b.getAttribute("data-i18n"), text: b.textContent, name: b.getAttribute("aria-label") ?? "", off: b.disabled };
      }),
    };
  }, ids);

const SPEECH_ROW = { box: "download-progress", bar: "progress-bar", fill: "progress-fill", numbers: "download-numbers", select: "model-select", note: "model-note", buttons: ["download-btn"] };
const AI_ROW = { box: "ai-download-progress", bar: "ai-progress-bar", fill: "ai-progress-fill", numbers: "ai-progress-text", select: "ai-model-select", note: "ai-model-note", buttons: ["ai-download-btn", "ai-download-main"] };

/** The bar is a progress bar named after its row, with the numbers in words, and nothing of it is a live region. */
const barOk = (now, numbers, said) =>
  now.shown && now.onRow && numbers.test(now.numbers) && now.width === "43%" && now.role === "progressbar" && now.now === "43" && now.range === "0-100" && said.test(now.said ?? "") && now.named === now.label && now.live === "";

/**
 * The speech model's row on Models & GPU while its model downloads, after
 * the download failed, and at the start of the next one. `open` has started
 * a download: of the model chosen in the dropdown where one is there
 * already (populated), with the Download button where none is (first run).
 */
async function speechDownload(page, run) {
  const out = [];
  const firstrun = await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun");
  const saved = () => page.evaluate(() => window.__MOCK__.settings().whisperModel);
  const before = await saved();
  // Downloading: the bar and "43 % · 32 MB of 75 MB" on the row.
  let now = await downloadNow(page, SPEECH_ROW);
  out.push(...expect(barOk(now, firstrun ? /^43 % · 200 MB \S+ 466 MB$/ : /^43 % · 32 MB \S+ 75 MB$/, /^43 %, \d+ MB \S+ \d+ MB$/), "the speech model's row shows its download: the bar and percent with size, a progress bar named after the row, no live region", JSON.stringify(now)));
  out.push(...expect(now.resting && now.button[0].off, "the dropdown and the button rest while the model downloads", JSON.stringify(now)));
  // The rest is behaviour: once, not in every window size (the picture stays the download that runs).
  if (run.size !== BEHAVIOUR) return out;
  // Another setting is saved meanwhile: the model that is on its way is not stored.
  await choose(page, "idle-unload-select", "15");
  await wait(page, 120);
  out.push(...expect((await saved()) === before && (await page.evaluate(() => window.__MOCK__.settings().idleUnloadMinutes)) === 15, "a save while a model downloads keeps the model that was saved", `${await saved()} (was ${before})`));

  // The download fails: the row says which model, in the colour of an error, with Retry; the settings keep the old model.
  await awaitError(page, /Download failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("speech"));
  await until(page, () => !document.getElementById("download-progress").checkVisibility());
  await wait(page, 150);
  const errors = await logged(page);
  now = await downloadNow(page, SPEECH_ROW);
  const failedModel = firstrun ? /Small\s·\s466\sMB/ : /Tiny\s·\s75\sMB/;
  out.push(...expect(errors === 1 && !now.shown && now.tone === "error" && failedModel.test(now.note) && !now.resting && (await saved()) === before, "a download that fails: the row's note says which model did not finish, in the colour of an error, and the settings keep their model", JSON.stringify({ errors, now, saved: await saved() })));
  const said = await page.evaluate(() => document.getElementById("download-live").textContent);
  out.push(...expect(failedModel.test(said), "the failure is said to a screen reader", said));
  // With the backend's reason after the sentence: a full disk is not a bad connection.
  out.push(...expect(now.note.includes(`${NO_LINE}.`) && said.endsWith(`${NO_LINE}.`), "the failure says the backend's reason, on the row and to a screen reader", JSON.stringify([now.note, said])));
  if (firstrun) {
    // The dropdown is still on the model that failed: its button reads Retry, and Home's step says the same.
    const home = await page.evaluate(() => ({ text: document.getElementById("setup-model-text").textContent, tone: document.getElementById("setup-model-text").dataset.tone, button: document.getElementById("setup-model-download").textContent }));
    out.push(...expect(now.select === "small" && now.button[0].shown && now.button[0].key === "retry" && !now.button[0].off && now.button[0].name.length > now.button[0].text.length && now.noteRetry === null, "the Download button reads Retry after the failure and says what it retries", JSON.stringify(now.button)));
    // The same sentence in the same colour as on the row: an error, with the reason.
    out.push(...expect(failedModel.test(home.text) && home.tone === now.tone && home.text.endsWith(`${NO_LINE}.`) && home.button === now.button[0].text, "Home's step says the same failure in the same colour, with its reason, and offers Retry", JSON.stringify(home)));
    // Another model is chosen: its download starts clean, under a button that no longer reads Retry.
    await noteLive(page);
    await page.selectOption("#model-select", "base");
    await asked(page, "download_model", 2);
    now = await downloadNow(page, SPEECH_ROW);
    out.push(...expect(now.shown && now.numbers === "0 %" && now.width === "0%" && now.now === "0" && now.tone === "" && !failedModel.test(now.note) && now.button[0].key === "download" && now.button[0].off, "a second download starts clean: no numbers of the last one, no failure, no Retry on the resting button", JSON.stringify(now)));
    await page.evaluate(() => {
      for (let i = 1; i <= 60; i++) window.__MOCK__.emit("download-progress", { downloaded: i * 1e6, total: 142e6, percent: (i * 100) / 142 });
    });
    await page.evaluate(() => window.__MOCK__.finishDownload("speech"));
    await until(page, () => window.__MOCK__.settings().whisperModel === "base" && !document.getElementById("download-progress").checkVisibility());
    await wait(page, 150);
    const noted = await liveNoted(page);
    out.push(...expect(liveOk(noted) && spoken(noted.settings["download-live"]).length === 2, "a download is read out at its start and its end, not at every step", JSON.stringify(noted.all)));
    // The failure's sentence went with the choice, before the new download said its start: nobody finds it later.
    out.push(...expect((noted.settings["download-live"] ?? [])[0] === "", "the next choice empties what a screen reader was told of the failure", JSON.stringify(noted.settings["download-live"])));
    now = await downloadNow(page, SPEECH_ROW);
    out.push(...expect((await saved()) === "base" && now.select === "base" && now.tone === "" && !now.button[0].shown, "the model that arrived is saved, and the row is as for any model that is there", JSON.stringify(now)));
    return out;
  }
  // The dropdown is back on the model that works: Retry stands in the note, and says what it retries.
  out.push(...expect(now.select === before && !now.button[0].shown && (now.noteRetry ?? "").length > 8, "the dropdown is back on the saved model and the note offers Retry", JSON.stringify(now)));
  // A language change keeps the failure, in the new language.
  // Retry: the same model again, clean: no numbers of the last try, no failure.
  await noteLive(page);
  await page.click("#model-note button");
  await asked(page, "download_model", 2);
  now = await downloadNow(page, SPEECH_ROW);
  out.push(...expect(now.shown && now.select === "tiny" && now.resting && now.numbers === "0 %" && now.width === "0%" && now.now === "0" && now.tone === "" && now.noteRetry === null, "Retry downloads the same model again and starts clean: no numbers of the last try, no failure", JSON.stringify(now)));
  await page.evaluate(() => {
    for (let i = 1; i <= 60; i++) window.__MOCK__.emit("download-progress", { downloaded: i * 1e6, total: 75e6, percent: (i * 100) / 75 });
  });
  await page.evaluate(() => window.__MOCK__.finishDownload("speech"));
  await until(page, () => window.__MOCK__.settings().whisperModel === "tiny" && !document.getElementById("download-progress").checkVisibility());
  await wait(page, 150);
  const noted = await liveNoted(page);
  out.push(...expect(liveOk(noted) && spoken(noted.settings["download-live"]).length === 2, "a download is read out at its start and its end, not at every step", JSON.stringify(noted.all)));
  now = await downloadNow(page, SPEECH_ROW);
  const focus = await page.evaluate(() => document.activeElement?.id ?? "");
  out.push(...expect((await saved()) === "tiny" && now.select === "tiny" && now.tone === "" && now.noteRetry === null && focus === "model-select", "the model that arrived is saved, the failure is gone, and the keyboard focus is on the dropdown", JSON.stringify({ now, focus })));
  // A failure survives a change of the Display Language, in the new language, and goes with the next choice.
  await page.selectOption("#model-select", "base");
  await asked(page, "download_model", 3);
  await failNow(page, "speech", DISK_FULL);
  const lang = await page.evaluate(() => document.documentElement.lang);
  const live = () => page.evaluate(() => document.getElementById("download-live").textContent);
  const one = await page.evaluate(() => document.getElementById("model-note").textContent);
  // A reason that ends like a sentence is left as it is.
  out.push(...expect(one.includes(DISK_FULL) && !one.includes(`${DISK_FULL}.`) && (await live()).endsWith(DISK_FULL), "a full disk is said as the reason", JSON.stringify([one, await live()])));
  await choose(page, "ui-language-select", lang === "de" ? "en" : "de");
  await wait(page, 300);
  const other = await page.evaluate(() => [document.getElementById("model-note").textContent, document.getElementById("model-note").dataset.tone, document.getElementById("gpu-detected").textContent]);
  out.push(...expect(other[0] !== one && /Base/.test(other[0]) && other[0].includes(DISK_FULL) && other[1] === "error", "the failure stays through a change of the Display Language, in the new language", JSON.stringify([one, other])));
  // What a screen reader was told is in the old language: it goes, the note on the row says it in the new one.
  out.push(...expect((await live()) === "", "a change of the Display Language empties what a screen reader was told of the last download", await live()));
  out.push(...expect((lang === "de" ? /^Detected: / : /^Erkannt: /).test(other[2]), "the detected graphics cards follow the Display Language", other[2]));
  await choose(page, "ui-language-select", lang);
  await wait(page, 300);
  await page.selectOption("#model-select", "small");
  await wait(page, 200);
  now = await downloadNow(page, SPEECH_ROW);
  out.push(...expect(now.tone === "" && !/Base/.test(now.note) && (await saved()) === "small" && (await live()) === "", "the next choice ends the failure's note, also for a screen reader", JSON.stringify([now, await live()])));

  // Only a model that is on disk is saved, also in the two moments in which the dropdown is on another one and no
  // download runs. The backend answers 150 ms late for these, so each moment lasts.
  await slowAnswers(page, 150);
  // (a) After a download that failed: its flag is cleared, the dropdown is free again and still on the model that
  // failed while the rows' ticks are asked for. Another setting is saved in that moment (the page saves all of them).
  await page.selectOption("#model-select", "base");
  await asked(page, "download_model", 4);
  await page.evaluate(() => {
    const select = document.getElementById("model-select");
    window.__between = null;
    new MutationObserver((_, watch) => {
      if (select.disabled) return;
      watch.disconnect();
      const idle = document.getElementById("idle-unload-select");
      idle.value = idle.value === "60" ? "30" : "60";
      idle.dispatchEvent(new Event("change", { bubbles: true }));
      window.__between = { dropdown: select.value, saved: window.__MOCK__.settings().whisperModel, idle: window.__MOCK__.settings().idleUnloadMinutes };
    }).observe(select, { attributes: true, attributeFilter: ["disabled"] });
  });
  await awaitError(page, /Download failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("speech"));
  await until(page, () => window.__between !== null && document.getElementById("model-select").value === "small" && document.getElementById("model-note").dataset.tone === "error");
  await wait(page, 400);
  await logged(page);
  const between = await page.evaluate(() => window.__between);
  now = await downloadNow(page, SPEECH_ROW);
  out.push(...expect(between?.dropdown === "base" && [30, 60].includes(between.idle), "the check saves another setting in the moment after a failed download, with the dropdown still on the model that failed", JSON.stringify(between)));
  out.push(...expect(between?.saved === "small" && (await saved()) === "small" && now.select === "small", "a save in the moment after a failed download keeps the model that is on disk", JSON.stringify({ between, saved: await saved(), dropdown: now.select })));
  // (b) Two choices in quick succession, as the arrow keys make them: a model that is there, then a missing one
  // while the first one's ticks are asked for. The first choice's save comes before the second one's download starts.
  await page.selectOption("#model-select", "small");
  await wait(page, 700);
  await page.evaluate(async () => {
    const select = document.getElementById("model-select");
    const checks = () => window.__MOCK__.calls.filter((c) => c.cmd === "check_model_downloaded").length;
    const pick = (value) => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const from = checks();
    pick("medium");
    // The choice's own question, the row's, then the eight ticks: with the tenth question out, the ticks are on their way.
    while (checks() < from + 10) await new Promise((r) => setTimeout(r, 5));
    pick("base");
  });
  const started = await asked(page, "download_model", 5);
  // What the first choice's save stored, before the second one's download ends.
  const meanwhile = await saved();
  await awaitError(page, /Download failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("speech"));
  await until(page, () => document.getElementById("model-note").dataset.tone === "error" && document.getElementById("model-select").value !== "base");
  await wait(page, 400);
  await logged(page);
  now = await downloadNow(page, SPEECH_ROW);
  const there = ["small", "medium", "tiny", "large-v3-turbo-q8_0"];
  out.push(...expect(started && meanwhile !== "base", "two choices in quick succession: the first one's save does not store the second, missing model", JSON.stringify({ started, meanwhile })));
  out.push(...expect(there.includes(await saved()) && now.select === (await saved()), "two choices in quick succession, the second one's download fails: the settings and the dropdown are on a model that is on disk", JSON.stringify({ saved: await saved(), dropdown: now.select })));
  await slowAnswers(page, 0);

  // For the screenshot: a download that runs.
  await page.selectOption("#model-select", "large-v3");
  await asked(page, "download_model", 6);
  // A change of the Display Language meanwhile brings no Download button: the dropdown started this download, and there was none.
  await choose(page, "ui-language-select", lang === "de" ? "en" : "de");
  await wait(page, 300);
  now = await downloadNow(page, SPEECH_ROW);
  out.push(...expect(now.shown && now.resting && !now.button[0].shown, "a change of the Display Language while the dropdown's download runs shows no Download button", JSON.stringify(now.button)));
  await choose(page, "ui-language-select", lang);
  await wait(page, 300);
  await report(page, "download-progress", 2.9e9);
  return out;
}

/**
 * The AI model's row in the Advanced fold of AI cleanup, the same way.
 * `open` has opened the fold, chosen a model that is not there and scrolled
 * its row to the middle of the window, as a click on it would have it.
 */
async function aiDownload(page, run) {
  const out = [];
  const main = () => page.evaluate(() => ({ text: document.getElementById("ai-status-line").textContent, percent: document.getElementById("ai-status-percent").textContent, tone: document.getElementById("ai-status-line").dataset.tone ?? "" }));
  // Downloading: the bar and its numbers on the model's row, in view, and the percent beside the switch.
  // The model's row at the middle of the window, as after a click on its dropdown (the tool scrolled back to the top).
  await page.evaluate(() => document.getElementById("ai-model-select").scrollIntoView({ block: "center" }));
  await wait(page, 100);
  let now = await downloadNow(page, AI_ROW);
  out.push(...expect(barOk(now, /^43 % · 3\.1 GB \S+ 7\.1 GB$/, /^43 %, 3\.1 GB \S+ 7\.1 GB$/), "the AI model's row shows its download: the bar and percent with size, a progress bar named after the row, no live region", JSON.stringify(now)));
  out.push(...expect(now.inView, "the download's progress is in view beside the control that started it", `${JSON.stringify(now)} in a window of ${await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)}`));
  let line = await main();
  out.push(...expect(line.percent === "43 %" && line.text.length > 8 && !/\d/.test(line.text), "the state line beside the switch has the percent after it, outside what is read out", JSON.stringify(line)));
  out.push(...expect(now.resting && now.button.every((b) => b.off && b.name.length > b.text.length), "the dropdown and both Download buttons rest, and each says what it downloads", JSON.stringify(now.button)));
  // The rest is behaviour: once, not in every window size (the picture stays the download that runs).
  if (run.size !== BEHAVIOUR) return out;

  // It fails: the model's row and the state line say which model, in the colour of an error; both buttons read Retry.
  const errors = await failNow(page, "ai", DISK_FULL);
  now = await downloadNow(page, AI_ROW);
  line = await main();
  const model = /Gemma\s4\s12B\s·\s7\.1\sGB/;
  out.push(...expect(errors === 1 && !now.shown && now.tone === "error" && model.test(now.note) && model.test(line.text) && line.tone === "error" && line.percent === "", "a download that fails: the model's row and the state line beside the switch say which model did not finish, in the colour of an error", JSON.stringify({ errors, now, line })));
  // With the backend's reason after the sentence: a full disk is not a bad connection.
  out.push(...expect(now.note.endsWith(DISK_FULL) && line.text.endsWith(DISK_FULL), "the failure says the backend's reason, on the model's row and beside the switch", JSON.stringify([now.note, line.text])));
  out.push(...expect(now.button.every((b) => b.shown && b.key === "retry" && !b.off && b.name.length > b.text.length), "both Download buttons read Retry and say what they retry", JSON.stringify(now.button)));
  // The failure is still there after the backend reported its state again.
  await page.evaluate(() => window.__MOCK__.emit("ai-status", null));
  await wait(page, 150);
  out.push(...expect(model.test((await main()).text) && (await downloadNow(page, AI_ROW)).tone === "error", "the failure stays when the AI's state is read again", JSON.stringify(await main())));
  // Home says it under its switch, as Settings does, and has the Retry its sentence names ("try again").
  await section(page, "home");
  const home = await page.evaluate(() => {
    const said = document.getElementById("home-ai-status");
    const retry = document.getElementById("home-ai-retry");
    return { text: said.textContent, tone: said.dataset.tone, retry: retry.checkVisibility(), after: said.nextElementSibling === retry, name: retry.getAttribute("aria-label") ?? "", word: retry.textContent };
  });
  out.push(...expect(model.test(home.text) && home.text.endsWith(DISK_FULL) && home.tone === "error", "Home says the same failure under its AI cleanup switch, with its reason", JSON.stringify(home)));
  out.push(...expect(home.retry && home.after && home.name.length > home.word.length + 3, "Home has the Retry its failure names, after the sentence, and it says what it retries", JSON.stringify(home)));

  // Retry, pressed on Home, starts clean and is read out twice: at its start and at its end.
  await noteLive(page);
  await page.click("#home-ai-retry");
  await asked(page, "ai_download_model", 2);
  await wait(page, 100);
  // The button rests where it is while its download runs: it has the keyboard focus, which a button that goes would drop.
  const pressed = await page.evaluate(() => {
    const retry = document.getElementById("home-ai-retry");
    return { shown: retry.checkVisibility(), rests: retry.getAttribute("aria-disabled") === "true", focus: document.activeElement === retry, said: document.getElementById("home-ai-status").textContent };
  });
  out.push(...expect(pressed.shown && pressed.rests && pressed.focus && !model.test(pressed.said) && pressed.said.length > 8, "Retry on Home starts the download again and rests with the keyboard focus while it runs", JSON.stringify(pressed)));
  await settings(page, "ai");
  await page.evaluate(() => document.getElementById("ai-model-select").scrollIntoView({ block: "center" }));
  await wait(page, 100);
  now = await downloadNow(page, AI_ROW);
  line = await main();
  out.push(...expect(now.shown && now.numbers === "0 %" && now.width === "0%" && now.now === "0" && now.tone === "" && !model.test(now.note) && now.button.every((b) => b.key === "download" && b.off) && !model.test(line.text) && line.percent === "0 %", "a second download starts clean: no numbers of the last one, no failure, no Retry", JSON.stringify({ now, line })));
  await page.evaluate(() => {
    for (let i = 1; i <= 60; i++) window.__MOCK__.emit("ai-download-progress", { downloaded: i * 1e8, total: 7121861440, percent: (i * 1e10) / 7121861440 });
  });
  await page.evaluate(() => window.__MOCK__.finishDownload("ai"));
  await until(page, () => !document.getElementById("ai-download-progress").checkVisibility() && !document.getElementById("ai-download-btn").checkVisibility());
  await wait(page, 200);
  const noted = await liveNoted(page);
  out.push(...expect(liveOk(noted) && (noted.settings["ai-status-line"] ?? []).length === 2, "the AI model's download is read out at its start and its end, not at every step", JSON.stringify(noted.all)));
  now = await downloadNow(page, AI_ROW);
  out.push(...expect(now.tone === "" && !model.test(now.note) && now.button.every((b) => !b.shown) && (await main()).percent === "", "with the model there the row is as for any model that is there", JSON.stringify(now)));
  const gone = await page.evaluate(() => [document.getElementById("home-ai-retry").classList.contains("hidden"), document.getElementById("home-ai-retry").hasAttribute("aria-disabled")]);
  out.push(...expect(gone[0] && !gone[1], "Home's Retry goes with the failure", JSON.stringify(gone)));
  return out;
}

/** The cloud engine without its key: the main card of Models & GPU says so and leads to the key field in the fold. */
async function cloudKey(page, run) {
  const out = [];
  const note = () =>
    page.evaluate(() => {
      const el = document.getElementById("engine-cloud-note");
      const button = document.getElementById("engine-cloud-key");
      return { shown: el.checkVisibility(), tone: el.dataset.tone ?? "", key: document.getElementById("engine-cloud-text").getAttribute("data-i18n"), button: button.checkVisibility(), fold: document.querySelector('details.fold[data-fold="models"]').open };
    });
  let now = await note();
  out.push(...expect(now.shown && now.tone === "warn" && now.key === "cloud_note_no_key" && now.button && !now.fold, "the cloud engine without a key: the notice warns, says that the key is missing and has a button, with the fold closed", JSON.stringify(now)));
  await page.click("#engine-cloud-key");
  await wait(page);
  const at = await page.evaluate(() => {
    const el = document.activeElement;
    const r = el.getBoundingClientRect();
    return { id: el.id, shown: el.checkVisibility(), inView: r.top >= 0 && r.bottom <= window.innerHeight, fold: document.querySelector('details.fold[data-fold="models"]').open, remembered: JSON.parse(localStorage.getItem("rudariflow-ui") ?? "{}").folds?.models === true };
  });
  out.push(...expect(at.id === "groq-key" && at.shown && at.inView && at.fold, "the notice's button lands on the key field: the fold opens, the field is in view and has the focus", JSON.stringify(at)));
  out.push(...expect(!at.remembered, "a fold that a link opened is not remembered as open", JSON.stringify(at)));
  // Another tab and back: the visit is over, the fold is as the user left it.
  await page.evaluate(() => document.getElementById("tab-general").click());
  await page.evaluate(() => document.getElementById("tab-models").click());
  await wait(page, 150);
  now = await note();
  out.push(...expect(!now.fold, "after the visit the fold is closed again", JSON.stringify(now)));
  // So far every window size: the key field must come into view in each. The rest is behaviour: once.
  if (run.size !== BEHAVIOUR) return out;
  // The user opens it: that is remembered.
  await page.click('details.fold[data-fold="models"] > summary');
  await wait(page, 150);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("rudariflow-ui") ?? "{}").folds?.models === true);
  out.push(...expect(kept, "a fold the user opens is remembered"));
  // With a key the notice is the plain one again.
  await page.fill("#groq-key", "gsk_check");
  await wait(page, 100);
  now = await note();
  out.push(...expect(now.shown && now.tone === "" && now.key === "cloud_note" && !now.button, "with a key the notice no longer warns and has no button", JSON.stringify(now)));
  // For the screenshot and the pages that follow: no key, the fold as it was.
  await page.fill("#groq-key", "");
  await page.click('details.fold[data-fold="models"] > summary');
  await wait(page, 150);
  return out;
}

/** Every key box of a card ends on one right edge, whether its key has a × beside it or not. */
async function keyEdges(page) {
  const out = [];
  const edges = (root) =>
    page.evaluate(
      (root) =>
        [...document.querySelectorAll(`${root} .hotkey-btn`)].filter((b) => b.checkVisibility()).map((b) => ({ id: b.id, right: Math.round(b.getBoundingClientRect().right * 2) / 2, top: Math.round(b.getBoundingClientRect().top) })),
      root,
    );
  // Settings > Dictation, with the fold open: Dictate has no ×, Free GPU is not set.
  for (const root of ["#panel-dictation > .card", "#panel-dictation .fold"]) {
    const keys = await edges(root);
    out.push(...expect(keys.length >= 2 && new Set(keys.map((k) => k.right)).size === 1, `the key boxes of ${root} end on one right edge`, JSON.stringify(keys)));
  }
  // The × of a key that is not set keeps its room, and is neither shown nor reached.
  const off = await page.evaluate(() => {
    const b = document.getElementById("free-gpu-clear");
    return [b.getBoundingClientRect().width, b.checkVisibility({ visibilityProperty: true }), document.getElementById("paste-last-clear").checkVisibility({ visibilityProperty: true })];
  });
  out.push(...expect(off[0] > 20 && !off[1] && off[2], "the × of a key that is not set keeps its room and does not show", JSON.stringify(off)));
  // Each key box stays on its row's first line, beside its label.
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#panel-dictation .setting-row")]
      .filter((row) => row.querySelector(".hotkey-btn") && row.checkVisibility())
      .map((row) => [row.querySelector(".hotkey-btn").id, Math.round(row.querySelector(".hotkey-btn").getBoundingClientRect().top - row.querySelector(".label-text").getBoundingClientRect().top)]),
  );
  out.push(...expect(rows.every(([, down]) => Math.abs(down) < 16), "a key box stands beside its label, not under it", JSON.stringify(rows)));
  // Home's hotkeys card: one right edge; in one column (a window under 900 px beside the sidebar) the four keys
  // stand two by two, and the boxes of each of the two columns end on one edge.
  await section(page, "home");
  const home = await edges("#home-hotkeys");
  const two = await page.evaluate((step) => document.getElementById("content").offsetWidth < step, WIDE);
  out.push(...expect(home.length === 4 && new Set(home.map((k) => k.right)).size === (two ? 2 : 1) && (!two || (home[0].right === home[2].right && home[1].right === home[3].right && home[0].top === home[1].top)), "Home's key boxes end on one right edge, or on one per column where they stand two by two", JSON.stringify(home)));
  await settings(page, "dictation");
  return out;
}

/**
 * "Download" and "More" say what they are about: three buttons read
 * "Download" and thirteen "More". The name holds the word that shows, and
 * follows the Display Language.
 */
async function controlNames(page) {
  const out = [];
  const read = () =>
    page.evaluate(() => ({
      lang: document.documentElement.lang,
      more: [...document.querySelectorAll("#section-settings .hint-more")].map((b) => [b.textContent, b.getAttribute("aria-label") ?? ""]),
      download: ["download-btn", "ai-download-btn", "ai-download-main"].map((id) => [document.getElementById(id).textContent, document.getElementById(id).getAttribute("aria-label") ?? ""]),
    }));
  const says = (list) => list.every(([text, name]) => name.length > text.length + 3 && name.toLowerCase().includes(text.toLowerCase()));
  const one = await read();
  out.push(...expect(one.more.length >= 13 && says(one.more) && new Set(one.more.map((m) => m[1])).size === one.more.length, "every More says what it is about, each something else", JSON.stringify(one.more)));
  out.push(...expect(says(one.download) && one.download[1][1] === one.download[2][1] && one.download[0][1] !== one.download[1][1], "the Download buttons say which model they download", JSON.stringify(one.download)));
  // Open, it is "Less about …".
  const less = await page.evaluate(() => {
    const b = document.querySelector("#panel-dictation .hint-more");
    b.click();
    const open = [b.textContent, b.getAttribute("aria-label")];
    b.click();
    return [open, [b.textContent, b.getAttribute("aria-label")]];
  });
  out.push(...expect(says(less) && less[0][1] !== less[1][1] && less[1][1] === one.more[0][1], "an open More is named Less about its row, and More again once it is closed", JSON.stringify(less)));
  await choose(page, "ui-language-select", one.lang === "de" ? "en" : "de");
  await wait(page, 300);
  const two = await read();
  out.push(...expect(two.lang !== one.lang && says(two.more) && says(two.download) && two.more.every((m, i) => m[1] !== one.more[i][1]) && two.download.every((d, i) => d[1] !== one.download[i][1]), "the names follow the Display Language", JSON.stringify(two)));
  await choose(page, "ui-language-select", one.lang);
  await wait(page, 300);
  return out;
}

/** The parts of each Settings tab in the order of the page, and the column each stands in when the tab has two. */
const COLUMNS = {
  dictation: [[".card", 0], [".fold", 1]],
  ai: [[".card:has(#ai-toggle)", 0], [".card:has(#ai-rule-list)", 1], [".fold", 1]],
  dictionary: [["#dict-suggest", 0], [".card:has(#dict-list)", 0], [".card:has(#replacement-list)", 1], [".card:has(#swiss-toggle)", 1], [".fold", 1]],
  models: [[".card", 0], [".fold", 1]],
  general: [[".card:has(#ui-language-select)", 0], [".card:has(#history-mode-select)", 1]],
};

/**
 * A Settings tab as it is laid out, with its Advanced fold closed and open:
 * two columns from 1250 px beside the sidebar (the left one on the page's
 * left edge, the right one ending at its right edge, one top edge, one
 * gutter of 16 px, the parts of a column 16 px apart, every part in its
 * column), one column of the page's width below that. A hint is one line
 * where its row has 760 px or more, two lines at most in a narrower column.
 * The order in the page is the same in both,
 * and in two columns it goes down the left one and then down the right one:
 * Tab changes column once. AI cleanup is measured with the rules it has
 * (three, or none on a new PC) and with ten: the fold stands under the rules
 * however long the card beside them is.
 */
async function columns(page, run) {
  const out = [];
  const size = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
  /** The tab as it is laid out now. */
  const look = (tab) =>
    page.evaluate(
        ([tab, parts]) => {
          const panel = document.getElementById(`panel-${tab}`);
          const round = (n) => Math.round(n * 2) / 2;
          const kids = [...panel.children].filter((el) => !el.matches(".panel-lead"));
          const found = parts.map(([selector]) => panel.querySelector(`:scope > ${selector}`));
          const boxes = found.map((el, i) => {
            const r = el?.getBoundingClientRect();
            return { part: parts[i][0], column: parts[i][1], shown: !!el && el.checkVisibility(), left: r ? round(r.left) : 0, top: r ? round(r.top) : 0, right: r ? round(r.right) : 0, bottom: r ? round(r.bottom) : 0 };
          });
          const content = document.getElementById("content");
          const tabs = document.getElementById("settings-tabs").getBoundingClientRect();
          const fold = panel.querySelector(":scope > .fold > summary");
          const hints = [...panel.querySelectorAll(".setting-label .label-hint")]
            .filter((el) => el.checkVisibility() && !el.matches(".hint-long, .status-line, .ai-status, .ai-output-warn, #gpu-detected, #ai-model-note") && el.innerText.trim())
            .filter((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) > (el.closest(".setting-row").getBoundingClientRect().width >= 760 ? 1 : 2))
            .map((el) => el.innerText.trim().slice(0, 40));
          // "More" stands with the last word of its hint, never alone on a line.
          const alone = [...panel.querySelectorAll(".setting-label .label-hint > span + .hint-more")]
            .filter((b) => b.checkVisibility())
            .filter((b) => {
              const range = document.createRange();
              range.selectNodeContents(b.previousElementSibling);
              const last = [...range.getClientRects()].at(-1);
              return !last || Math.abs(last.top - b.getBoundingClientRect().top) > 8;
            })
            .map((b) => b.getAttribute("aria-controls"));
          return {
            alone,
            wider: document.getElementById("section-settings").classList.contains("roomy"),
            room: content.offsetWidth,
            order: kids.length === found.length && kids.every((el, i) => el === found[i]),
            boxes: boxes.filter((b) => b.shown),
            tabs: [round(tabs.left), round(tabs.right)],
            page: round(content.getBoundingClientRect().left + parseFloat(getComputedStyle(document.getElementById("section-settings")).paddingLeft)),
            pageRight: round(content.getBoundingClientRect().left + content.clientWidth - parseFloat(getComputedStyle(document.getElementById("section-settings")).paddingRight)),
            fold: fold ? { shown: fold.checkVisibility(), width: round(fold.getBoundingClientRect().width), height: round(fold.getBoundingClientRect().height), ground: getComputedStyle(fold).backgroundColor } : null,
            sideways: content.scrollWidth > content.clientWidth + 1,
            hints,
          };
        },
        [tab, COLUMNS[tab]],
    );
  /** What must hold of it. */
  const judge = (seen, what) => {
    const out = [];
    const detail = JSON.stringify(seen);
    out.push(...expect(seen.order, `${what}: the parts are in the order of the page`, detail));
    out.push(...expect(seen.wider === seen.room >= ROOMY, `${what}: two columns from ${ROOMY} px beside the sidebar, one below`, detail));
    out.push(...expect(!seen.sideways, `${what}: nothing scrolls sideways`, detail));
    out.push(...expect(seen.hints.length === 0, `${what}: a hint is one line where its row has 760 px or more, and two at most in a narrower one`, seen.hints.join(" | ")));
    out.push(...expect(seen.alone.length === 0, `${what}: no "More" stands alone on a line`, seen.alone.join(" | ")));
    const col = (n) => seen.boxes.filter((b) => b.column === n);
    if (!seen.wider) {
      // One column: every part from the page's left edge to its right edge, one under the other.
      const one = seen.boxes.every((b, i) => b.left === seen.page && Math.abs(b.right - seen.pageRight) <= 1 && (i === 0 || b.top >= seen.boxes[i - 1].bottom));
      out.push(...expect(one, `${what}: one column from the page's left edge to its right edge`, detail));
      return out;
    }
    const [left, right] = [col(0), col(1)];
    const width = (b) => b.right - b.left;
    out.push(...expect(left.length > 0 && right.length > 0 && left.every((b) => b.left === seen.page) && right.every((b) => b.left === right[0].left && b.left >= left[0].right + 8), `${what}: two columns, the left one on the page's left edge`, detail));
    out.push(...expect(left[0].top === right[0].top, `${what}: both columns start on one top edge`, detail));
    // The parts are listed in the order of the page, which is the order Tab takes: where each one stands
    // (not where the list above expects it), the left column comes first and is never gone back to.
    const tabbed = seen.boxes.map((b) => (b.left === seen.page ? 0 : 1));
    out.push(...expect(tabbed.every((c, i) => i === 0 || c >= tabbed[i - 1]), `${what}: Tab goes down the left column and then down the right one, it changes column once`, `${tabbed.join("")} ${detail}`));
    out.push(...expect(seen.boxes.every((b) => Math.abs(width(b) - width(seen.boxes[0])) <= 0.5 && width(b) >= 580), `${what}: every part is as wide as its column, and no column is narrower than 580 px`, detail));
    out.push(...expect(right.every((b) => Math.abs(b.right - seen.pageRight) <= 1) && Math.abs(right[0].left - left[0].right - 16) <= 0.5, `${what}: the right column ends at the page's right edge, one gutter of 16 px from the left one`, detail));
    const apart = (list) => list.every((b, i) => i === 0 || Math.abs(b.top - list[i - 1].bottom - 16) <= 1);
    out.push(...expect(apart(left) && apart(right), `${what}: the parts of a column stand 16 px apart, none is pushed away`, detail));
    out.push(...expect(seen.tabs[0] === seen.page && Math.abs(seen.tabs[1] - seen.pageRight) <= 1, `${what}: the tab bar spans the whole width`, detail));
    if (seen.fold) out.push(...expect(seen.fold.shown && Math.abs(seen.fold.width - width(seen.boxes[0])) <= 0.5 && seen.fold.height >= 40 && !/rgba\(0, 0, 0, 0\)|transparent/.test(seen.fold.ground), `${what}: the fold's heading is a bar as wide as its column`, detail));
    return out;
  };
  /** Rules per app with ten rows, or as it was again. The rows are the page's own ("Add rule"); nothing is saved, and they go without a save. */
  const tenRules = (on) =>
    page.evaluate((on) => {
      const list = document.getElementById("ai-rule-list");
      if (on) {
        for (let n = list.children.length; n < 10; n++) {
          document.getElementById("ai-rule-add").click();
          list.lastElementChild.dataset.check = "1";
        }
        document.activeElement?.blur?.();
        return list.children.length;
      }
      for (const row of list.querySelectorAll("[data-check]")) row.remove();
      document.getElementById("ai-rule-empty").classList.toggle("hidden", list.children.length > 0);
      return list.children.length;
    }, on);
  for (const tab of TABS) {
    await page.evaluate((t) => document.getElementById(`tab-${t}`).click(), tab);
    for (const open of tab === "general" ? [false] : [false, true]) {
      await page.evaluate(([t, open]) => document.querySelector(`details.fold[data-fold="${t}"]`) && (document.querySelector(`details.fold[data-fold="${t}"]`).open = open), [tab, open]);
      await wait(page, 60);
      const seen = await look(tab);
      const what = `${tab}${open ? ", Advanced open" : ""} at ${size}`;
      out.push(...judge(seen, what));
      if (tab !== "ai" || !seen.wider) continue;
      // The rules' card ten rows long: it is the higher side then, and the fold still stands 16 px under it.
      const rows = await tenRules(true);
      await wait(page, 60);
      out.push(...expect(rows === 10, `${what}: the check has ten rules to measure`, String(rows)));
      out.push(...judge(await look(tab), `${what}, ten rules`));
      await tenRules(false);
    }
  }
  // The folds as the window found them (the tool set them, the page remembers them as the user's).
  await page.evaluate(() => {
    for (const fold of document.querySelectorAll("details.fold[data-fold]")) fold.open = false;
  });
  await page.evaluate(() => document.getElementById("tab-dictation").click());
  await wait(page, 200);
  // The step with the scrollbar drawn: once per run (it opens its own window, on the populated data set).
  if (run.scenario === "populated" && run.lang === "en" && run.size === BEHAVIOUR) out.push(...(await settingsHold(run)));
  return out;
}

/**
 * The step to two columns (1250 px beside the sidebar) in a window that
 * draws its scrollbar, as Home's steps are tried (`layoutHolds`): one pixel
 * below it and at it (the last width of one form and the first of the
 * other; a pixel above the step is the second form again), at the window
 * heights where the tab just fits and just does not, for every tab with its
 * fold closed and open. Nothing may change by itself: the two forms differ
 * in height, and a step decided on a width the scrollbar takes away would
 * flip in every frame.
 */
async function settingsHold(run) {
  const win = await run.openWindow({ scenario: "populated", lang: run.lang, size: "1800x1000", url: "/", scrollbars: true });
  const { page } = win;
  const tried = [];
  const forms = new Set();
  try {
    await section(page, "settings");
    const side = await page.evaluate(() => window.innerWidth - document.getElementById("content").offsetWidth);
    const widths = [ROOMY - 1, ROOMY].map((w) => w + side);
    for (const tab of TABS) {
      await page.evaluate((t) => document.getElementById(`tab-${t}`).click(), tab);
      for (const open of tab === "general" ? [false] : [false, true]) {
        await page.evaluate(([t, open]) => document.querySelector(`details.fold[data-fold="${t}"]`) && (document.querySelector(`details.fold[data-fold="${t}"]`).open = open), [tab, open]);
        // The window height at which the tab ends at the window's bottom, for each width.
        const fits = [];
        for (const width of widths) {
          await page.setViewportSize({ width, height: 3000 });
          await wait(page, 60);
          fits.push(await page.evaluate(() => Math.round(window.innerHeight - document.getElementById("content").clientHeight + document.getElementById("section-settings").getBoundingClientRect().height)));
        }
        // One pixel too low and one to spare, for the height of each form.
        const heights = [...new Set(fits.flatMap((h) => [h - 1, h + 1]))];
        for (const width of widths) {
          for (const height of heights) {
            await page.setViewportSize({ width, height });
            await wait(page, 40);
            const seen = await page.evaluate(
              (step) =>
                new Promise((done) => {
                  const settings = document.getElementById("section-settings");
                  const content = document.getElementById("content");
                  const look = () => `${getComputedStyle(settings.querySelector(".tab-panel:not([hidden])")).display !== "block" || getComputedStyle(settings.querySelector(".tab-panel:not([hidden])")).columnCount === "2" ? "two" : "one"} ${content.offsetWidth - content.clientWidth}`;
                  let was = look();
                  let n = 0;
                  const end = performance.now() + 100;
                  const frame = () => {
                    const now = look();
                    if (now !== was) n++;
                    was = now;
                    if (performance.now() < end) requestAnimationFrame(frame);
                    else done({ changes: n, form: now, right: now.startsWith("two") === content.offsetWidth >= step });
                  };
                  requestAnimationFrame(frame);
                }),
              ROOMY,
            );
            forms.add(seen.form);
            tried.push({ tab, open, size: `${width}x${height}`, changes: seen.changes, right: seen.right });
          }
        }
      }
    }
    const moved = tried.filter((t) => t.changes > 0);
    const wrong = tried.filter((t) => !t.right);
    // The sweep has seen what it is for: both forms, each with and without the scrollbar.
    const kinds = [...forms].map((f) => `${f.split(" ")[0]} ${f.split(" ")[1] === "0" ? "without" : "with"}`);
    return [
      ...expect(new Set(kinds).size === 4, "the layout check of Settings sees one and two columns, each with and without the scrollbar", JSON.stringify([...forms])),
      ...expect(moved.length === 0, "Settings' layout holds still at its step with a scrollbar", `${moved.length} of ${tried.length} sizes change by themselves, e.g. ${JSON.stringify(moved.slice(0, 3))}`),
      // The same window width is the same form, whatever the page's height: the scrollbar's room does not count.
      ...expect(wrong.length === 0, "Settings' columns follow the room beside the sidebar alone, with or without a scrollbar", `${wrong.length} of ${tried.length} sizes, e.g. ${JSON.stringify(wrong.slice(0, 3))}`),
    ];
  } finally {
    await win.context.close();
  }
}

// ── The one way to delete (Task 7) ────────────────────

/** Longer than the guard of src/arm.ts: a second click this long after the first is an answer to "Delete?". */
const ANSWER = 340;

/** From now on the mocked backend's command `cmd` fails (`null`: all of them work again). */
const breakCommand = (page, cmd) =>
  page.evaluate((cmd) => {
    const real = (window.__invoke ??= window.__TAURI_INTERNALS__.invoke);
    window.__TAURI_INTERNALS__.invoke = cmd ? (c, a) => (c === cmd ? Promise.reject("it broke") : real(c, a)) : real;
  }, cmd);

/** The delete buttons `sel` finds, as they show, and where the keyboard focus is. */
const deletes = (page, sel) =>
  page.evaluate((sel) => {
    const all = [...document.querySelectorAll(sel)].filter((b) => b.getClientRects().length);
    const at = document.activeElement;
    return {
      n: all.length,
      armed: all.flatMap((b, i) => (b.classList.contains("armed") ? [i] : [])),
      texts: all.map((b) => b.textContent),
      names: all.map((b) => b.getAttribute("aria-label") ?? ""),
      widths: all.map((b) => Math.round(b.getBoundingClientRect().width * 10) / 10),
      focus: all.indexOf(at),
      at: at?.id || at?.dataset?.key || at?.dataset?.action || at?.className || at?.tagName,
      live: document.getElementById("delete-live")?.textContent ?? "",
    };
  }, sel);

/**
 * One delete of the app against the rule (the spec's "Delete: one pattern"; src/confirm-delete.ts).
 *   what       the list, for the report
 *   buttons    selector of the list's delete buttons
 *   elsewhere  selector of something else to click
 *   cmd        the backend's command a delete sends (none: the page deletes by itself, and nothing can fail)
 *   left       how many things the list holds (default: its delete buttons)
 *   stays      the mocked backend keeps the thing: only the command is counted
 *   labels     { en, de }: [at rest, armed] when they are not "Delete" and "Delete?"
 *   named      the button is named after what it deletes
 *   redraw     draws the list again, as a backend event does
 *   reason     the page says itself why a delete failed, in a live region of its own: resolves to whether that shows. The
 *              button says the failure like every other; the line that is read out here stays silent (one of the two speaks)
 *   said       { en, de }: what is read out when the button is armed, when the button's word is not "Delete"
 *   settles    also wait for the button to read "Delete" again after a failure (2.5 s: once is enough)
 *   gone       the delete closes the page the button is on: one delete, no second one from the keyboard
 *   landed     where the focus must be after a delete from the keyboard (default: on a Delete of the list)
 * In German only the wording is looked at: the rule does not depend on the language.
 * The findings go into `out` as they are made: a step that cannot go on (a button that is gone because
 * something was deleted too early) throws, and what was found until then is kept.
 */
async function deleteRule(page, lang, spec, out = []) {
  const say = (ok, what, detail) => out.push(...expect(ok, `${spec.what}: ${what}`, detail === undefined ? "" : JSON.stringify(detail)));
  const [rest, ask] = spec.labels?.[lang] ?? (lang === "de" ? ["Löschen", "Löschen?"] : ["Delete", "Delete?"]);
  const button = (i) => page.locator(`${spec.buttons}:visible`).nth(i);
  const sent = () => (spec.cmd ? page.evaluate((cmd) => window.__MOCK__.calls.filter((c) => c.cmd === cmd).length, spec.cmd) : 0);
  const sends = spec.cmd ? 1 : 0;
  const now = async () => {
    const s = await deletes(page, spec.buttons);
    return { ...s, left: spec.left ? await spec.left() : s.n, sent: await sent() };
  };
  const esc = () => page.keyboard.press("Escape");

  const start = await now();
  const untouched = (s) => s.left === start.left && s.sent === start.sent;
  say(start.n > 0 && start.armed.length === 0 && start.texts.every((t) => t === rest), `every button reads "${rest}"`, start.texts);
  const name = spec.named ? start.names[0].slice(rest.length + 2) : "";
  if (spec.named) say(start.names.every((n) => n.startsWith(`${rest}: `) && n.length > rest.length + 2), "every button is named after what it deletes", start.names);

  // The first click arms: the look, the words, the name, the live line. Nothing is deleted.
  await button(0).click();
  let s = await now();
  say(s.armed.join() === "0" && s.texts[0] === ask && s.focus === 0 && untouched(s), `the first click only arms ("${ask}")`, s);
  say(s.widths[0] === start.widths[0], "arming does not change the button's width", [start.widths[0], s.widths[0]]);
  say(s.live !== "" && (!spec.named || (s.names[0] === `${ask} ${name}` && s.live.includes(name))), "a screen reader hears that the button is armed and for what", [s.names[0], s.live]);
  if (spec.said) say(s.live === spec.said[lang], "what is read out follows the button's own word", s.live);
  await esc();
  s = await now();
  say(s.armed.length === 0 && s.texts[0] === rest && s.live === "" && s.focus === 0 && untouched(s), "Esc disarms", s);
  if (lang !== "en") return out;

  // A double-click is one movement of the hand, and so is a second click right after the first.
  await button(0).dblclick();
  await wait(page, 150);
  s = await now();
  say(s.armed.join() === "0" && untouched(s), "a double-click deletes nothing and leaves the button armed", s);
  await esc();
  await button(0).click();
  await button(0).click();
  await wait(page, 150);
  s = await now();
  say(s.armed.join() === "0" && untouched(s), "a second click right after the first deletes nothing", s);
  // Nor does a third, or any burst: the guard counts from the last click, not from the one that armed the button.
  // Three clicks 160 ms apart: the third comes later than the guard after the first, and too soon after the second.
  await esc();
  const box = await button(0).boundingBox();
  for (let i = 0; i < 3; i++) {
    if (i) await wait(page, 160);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await wait(page, 150);
  s = await now();
  say(s.armed.join() === "0" && untouched(s), "three clicks, each too soon after the one before, delete nothing", s);
  // A click elsewhere disarms.
  await page.click(spec.elsewhere);
  s = await now();
  say(s.armed.length === 0 && s.texts[0] === rest && untouched(s), "a click elsewhere disarms", s);
  // So does the focus when it leaves.
  await button(0).click();
  await page.keyboard.press("Shift+Tab");
  s = await now();
  say(s.armed.length === 0 && s.focus !== 0 && untouched(s), "the focus leaving disarms", s);
  // Arming another button disarms the first.
  if (start.n > 1) {
    await button(0).click();
    await button(1).click();
    s = await now();
    say(s.armed.join() === "1" && s.texts[0] === rest && untouched(s), "arming another button disarms the first", s);
    await esc();
  }
  // The list is drawn again while a button is armed: the new button is armed and has the focus.
  if (spec.redraw) {
    await button(0).click();
    await spec.redraw();
    await wait(page, 200);
    s = await now();
    say(s.armed.join() === "0" && s.focus === 0 && s.texts[0] === ask && untouched(s), "drawn again while armed, the button is still armed and has the focus", s);
    await esc();
  }
  // The keyboard: Enter arms; Enter again at once, or held down, does nothing more.
  await button(0).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await wait(page, 100);
  s = await now();
  say(s.armed.join() === "0" && untouched(s), "Enter arms, and Enter again at once deletes nothing", s);
  await esc();
  // The key's repeat starts after a moment that is longer than the guard, as a real keyboard's does.
  await page.keyboard.down("Enter");
  await wait(page, ANSWER + 100);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.down("Enter");
    await wait(page, 40);
  }
  await page.keyboard.up("Enter");
  await wait(page, 100);
  s = await now();
  say(s.armed.join() === "0" && untouched(s), "Enter held down arms and deletes nothing", s);
  await esc();

  // A delete that fails says so, and the thing stays.
  if (spec.cmd) {
    await awaitError(page, /delete "[^"]*" failed|command failed/);
    await breakCommand(page, spec.cmd);
    await button(0).click();
    await wait(page, ANSWER);
    await button(0).click();
    await wait(page, 300);
    s = await deletes(page, spec.buttons);
    const left = spec.left ? await spec.left() : s.n;
    // On the button and in its name, the same for every delete. Read out by one line: this one, or the page's own with the reason.
    const onButton = s.texts[0] !== rest && s.texts[0] !== ask && s.texts[0].includes(rest) && (!spec.named || s.names[0] === `${s.texts[0]}: ${name}`);
    const told = spec.reason ? s.live === "" && (await spec.reason()) : s.live.startsWith(s.texts[0]);
    say(onButton && left === start.left && s.armed.length === 0, "a delete that fails says so on its button and the thing stays", { ...s, left });
    say(await page.evaluate(() => !document.getElementById("save-notice")?.checkVisibility()), "a delete that fails is not said a second time by the page's save notice", s.texts[0]);
    say(told, spec.reason ? "a delete that fails is read out once, by the page's own notice with the reason" : "a delete that fails is read out", s.live);
    say(s.focus === 0, "after a delete that failed the focus is on the button again", s);
    if (spec.redraw) {
      // Also in what the list is drawn from.
      await spec.redraw();
      await wait(page, 150);
      const drawn = await deletes(page, spec.buttons);
      say((spec.left ? await spec.left() : drawn.n) === start.left, "the thing is still there when the list is drawn again after the failure", drawn.n);
    }
    await breakCommand(page, null);
    await logged(page);
    if (spec.settles) {
      // The button and its name say "Delete" again after a moment.
      await wait(page, 2600);
      s = await now();
      say(s.texts[0] === rest && s.live === "" && (!spec.named || s.names[0] === `${rest}: ${name}`), "the button reads Delete again a moment after a failure", s);
    }
  }
  const before = await now();

  // The second click deletes: one thing, once.
  await button(0).click();
  await wait(page, ANSWER);
  await button(0).click();
  await wait(page, 350);
  s = await now();
  say(s.sent === before.sent + sends && (spec.stays || s.left === before.left - 1) && s.armed.length === 0, "the second click deletes", [before.left, s.left, before.sent, s.sent]);
  if (spec.gone) return out;
  // And from the keyboard: Enter, then Space. The focus is handed on.
  await button(0).focus();
  await page.keyboard.press("Enter");
  await wait(page, ANSWER);
  await page.keyboard.press("Space");
  await wait(page, 350);
  const end = await now();
  say(end.sent === s.sent + sends && (spec.stays || end.left === s.left - 1), "Enter and then Space delete", [s.left, end.left, s.sent, end.sent]);
  say(spec.landed ? await spec.landed() : end.focus >= 0, "after a delete from the keyboard the focus is on the row that moved up", end);
  return out;
}

/** Whether `text` shows somewhere under `scope` (a failure's reason in a page's own notice). */
const written =
  (page, text, scope = "section.active") =>
  () =>
    page.evaluate(([text, scope]) => [...document.querySelectorAll(`${scope} *`)].some((el) => el.children.length === 0 && el.getClientRects().length > 0 && el.textContent.includes(text)), [text, scope]);

/** Arm the first delete button `sel` finds, with a real click: the armed look is measured and in the pictures. */
async function armFirst(page, sel) {
  await page.keyboard.press("Escape");
  // As the mouse arms it: a button that still has the focus from the keyboard would keep its ring.
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.locator(`${sel}:visible`).first().click();
  await wait(page, 150);
}

/** The pages with a button armed: [id, how to get there, the button]. */
const ARMED = [
  ["home", (page) => section(page, "home"), "#history-list [data-delete-id]"],
  ["settings-dictionary", (page) => settings(page, "dictionary"), "#dict-list [data-delete-id]"],
  ["settings-ai", (page) => settings(page, "ai"), "#ai-rule-list [data-delete-id]"],
  [
    "settings-models",
    async (page) => {
      await page.evaluate(() => (document.querySelector('details.fold[data-fold="models"]').open = true));
      await settings(page, "models");
    },
    "#unused-model-list [data-delete-id]",
  ],
  ["settings-general", (page) => settings(page, "general"), "#history-clear"],
  ["soundboard", (page) => section(page, "soundboard"), "#sb-root .sb-delete"],
  [
    "meetings-open",
    async (page) => {
      await section(page, "meetings");
      await page.click(".mt-item");
      await wait(page, 500);
    },
    "#mt-delete",
  ],
];

/** Every delete of the main window against the rule, one list after the other. */
async function deletesProbe(page, run) {
  const out = [];
  // A step that waits for something that is not there gives up soon and says so.
  page.setDefaultTimeout(5000);
  try {
    await everyDelete(page, run.lang, out);
    if (run.lang === "en") {
      // A new start: the history is whole again.
      await again(page);
      out.push(...(await scrolledAway(page)));
    }
  } catch (e) {
    out.push(...expect(false, "the check of the deletes could not go on", String(e).split("\n").slice(0, 3).join(" ")));
  }
  page.setDefaultTimeout(30_000);
  // A new start: the lists are whole again for the pages that follow.
  await again(page);
  return out;
}

async function everyDelete(page, lang, out) {
  const rule = (spec) => deleteRule(page, lang, spec, out);
  const count = (sel) => () => page.locator(sel).count();
  const savedNow = () => page.evaluate(() => window.__MOCK__.settings());
  const title = "section.active .section-title";
  const enter = async () => {
    await page.keyboard.press("Enter");
    await wait(page, ANSWER);
    await page.keyboard.press("Enter");
    await wait(page, 300);
  };

  // What reads the armed button out stands outside the layout: the page is as high as the window, not a pixel more.
  const high = await page.evaluate(() => [!!document.getElementById("delete-live"), document.documentElement.scrollHeight, window.innerHeight]);
  out.push(...expect(high[0] && high[1] === high[2], "the line that is read out does not make the page higher than the window", JSON.stringify(high)));

  // At the start, with nothing armed yet: every delete button of the window reads in the Display Language, shown or
  // not. "Delete history" and Files' "Clear" get their words when their pages are wired, before the language is known.
  const words = lang === "de" ? { rest: "Löschen", "history-clear": "Verlauf löschen", "file-clear": "Transkript entfernen" } : { rest: "Delete", "history-clear": "Delete history", "file-clear": "Remove transcript" };
  const first = await page.evaluate(() => [...document.querySelectorAll("[data-delete-id]")].map((b) => [b.id || b.dataset.deleteId, b.textContent, b.classList.contains("armed")]));
  const wrong = first.filter(([id, text, armed]) => armed || text !== (words[id] ?? words.rest));
  out.push(...expect(["history-clear", "file-clear", "mt-delete"].every((id) => first.some((b) => b[0] === id)) && first.length > 20 && wrong.length === 0, "at the start every delete button reads in the Display Language", JSON.stringify(wrong.length ? wrong : first.length)));

  // Home's recordings first, while the history is whole.
  if (lang === "en") out.push(...(await playProbe(page)));

  // Settings > Dictionary: a word, a replacement.
  await settings(page, "dictionary");
  await rule({
    what: "a dictionary word",
    buttons: "#dict-list [data-delete-id]",
    elsewhere: "#dict-input",
    cmd: "save_settings",
    named: true,
    settles: true,
    redraw: () => page.evaluate(() => document.getElementById("dict-search").dispatchEvent(new Event("input"))),
  });
  if (lang === "en") {
    const words = (await savedNow()).customPrompt;
    out.push(...expect(words.split(", ").length === 10 && !/Gemma|Groq/.test(words), "the two deleted words are gone from the settings and the others are kept", words));
  }
  await rule({
    what: "a replacement",
    buttons: "#replacement-list [data-delete-id]",
    elsewhere: "#replacement-search",
    cmd: "save_settings",
    named: true,
    left: async () => (await savedNow()).replacements.length,
  });
  if (lang === "en") {
    // The last replacement goes: "Add replacement" takes the focus, and the list says that it is empty.
    await page.locator("#replacement-list [data-delete-id]").first().focus();
    await enter();
    const last = await page.evaluate(() => [document.activeElement.id, document.querySelectorAll(".replacement-row").length, !document.getElementById("replacement-empty").classList.contains("hidden")]);
    out.push(...expect(last[0] === "replacement-add" && last[1] === 0 && last[2], "after the last replacement the focus is on Add replacement", JSON.stringify(last)));
  }

  // Settings > AI cleanup: a rule.
  await settings(page, "ai");
  await rule({
    what: "an app rule",
    buttons: "#ai-rule-list [data-delete-id]",
    elsewhere: title,
    cmd: "save_settings",
    named: true,
    left: async () => (await savedNow()).aiRules.length,
  });

  // Settings > Models & GPU > Advanced: an unused model. The mocked backend keeps the file.
  await page.evaluate(() => (document.querySelector('details.fold[data-fold="models"]').open = true));
  await settings(page, "models");
  await rule({
    what: "an unused model",
    buttons: "#unused-model-list [data-delete-id]",
    elsewhere: title,
    cmd: "delete_unused_model",
    named: true,
    stays: true,
    reason: () => page.evaluate(() => [...document.querySelectorAll(".unused-model-error")].some((el) => el.getClientRects().length > 0 && el.textContent.includes("it broke"))),
  });

  // Home: a dictation.
  await section(page, "home");
  await rule({
    what: "a dictation",
    buttons: "#history-list [data-delete-id]",
    elsewhere: "#history-search",
    cmd: "history_delete",
    named: true,
    left: count("#history-list .history-item"),
    redraw: () => page.evaluate(() => window.__MOCK__.emit("history-updated", null)),
    // Home hands the focus on itself: to Copy of the row that moved up (the action that always shows).
    landed: () => page.evaluate(() => document.activeElement === document.querySelector('#history-list .history-item [data-action="copy"]')),
  });

  // Settings > General: the whole history. The mocked backend keeps it, until the last step.
  await settings(page, "general");
  await rule({
    what: "Delete history",
    buttons: "#history-clear",
    elsewhere: title,
    cmd: "history_clear",
    labels: { en: ["Delete history", "Delete all?"], de: ["Verlauf löschen", "Alles löschen?"] },
    stays: true,
  });
  if (lang === "en") {
    // The Display Language changes while a button is armed (the pop-out learns of it this way: it is in another
    // window). The button and the line that is read out follow it; nothing is left in the old language.
    const armedIn = async (to) => {
      // The change itself, without a touch of the dropdown: the focus stays on the armed button.
      await page.evaluate((to) => {
        const select = document.getElementById("ui-language-select");
        select.value = to;
        select.dispatchEvent(new Event("change"));
      }, to);
      await wait(page, 400);
      return page.evaluate(() => [document.getElementById("history-clear").textContent, document.getElementById("history-clear").classList.contains("armed"), document.getElementById("delete-live").textContent]);
    };
    await page.click("#history-clear");
    const inGerman = await armedIn("de");
    const inEnglish = await armedIn("en");
    out.push(...expect(inGerman.join("|") === "Alles löschen?|true|Nochmals drücken löscht. Esc bricht ab." && inEnglish.join("|") === "Delete all?|true|Press again to delete. Esc cancels.", "an armed button and what is read out of it follow a change of the Display Language", JSON.stringify([inGerman, inEnglish])));
    await page.keyboard.press("Escape");
    // With the history gone the button goes too: the row above takes the focus.
    await page.evaluate(() => {
      const real = window.__TAURI_INTERNALS__.invoke;
      let gone = false;
      window.__TAURI_INTERNALS__.invoke = (c, a) => (c === "history_list" && gone ? Promise.resolve([]) : ((gone ||= c === "history_clear"), real(c, a)));
    });
    await page.focus("#history-clear");
    await enter();
    const end = await page.evaluate(() => [document.activeElement.id, document.getElementById("history-clear").classList.contains("hidden"), document.querySelectorAll("#history-list .history-item").length]);
    out.push(...expect(end[0] === "history-mode-select" && end[1] && end[2] === 0, "after Delete history the list is empty and the focus is on the row above", JSON.stringify(end)));
    // The mocked backend has kept the history: the last dictation of the list is deleted from the keyboard. The
    // focus goes to the sentence that says the list is empty, and the live line does not say it a second time.
    await breakCommand(page, null);
    await section(page, "home");
    await page.evaluate(() => window.__MOCK__.emit("history-updated", null));
    await wait(page, 200);
    await page.evaluate(async () => {
      for (const row of [...document.querySelectorAll("#history-list .history-item")].slice(1)) await window.__TAURI_INTERNALS__.invoke("history_delete", { id: Number(row.dataset.id) });
      window.__MOCK__.emit("history-updated", null);
    });
    await wait(page, 200);
    await page.focus("#history-list [data-delete-id]");
    await enter();
    const last = await page.evaluate(() => [document.querySelectorAll("#history-list .history-item").length, document.activeElement.id, document.getElementById("history-empty").textContent !== "", document.getElementById("history-live").textContent]);
    out.push(...expect(last[0] === 0 && last[1] === "history-empty" && last[2] && last[3] === "", "after the last dictation the focus is on the sentence that says the list is empty, which is not said twice", JSON.stringify(last)));
  }

  // Meetings: the open meeting. A failure is said in the meeting's own notice.
  await section(page, "meetings");
  await page.click(".mt-item");
  await wait(page, 400);
  await rule({
    what: "a meeting",
    buttons: "#mt-delete",
    elsewhere: "#mt-view-meta",
    cmd: "meeting_delete",
    named: true,
    stays: true,
    gone: true,
    reason: written(page, "it broke"),
  });
  if (lang === "en") out.push(...expect(await page.evaluate(() => document.getElementById("mt-view").classList.contains("hidden") && document.activeElement.classList.contains("mt-item")), "after its delete the meeting is closed and the focus is in the library"));

  // Files: Clear empties the page of a transcript that is kept nowhere else. It keeps its word (no file is deleted).
  await section(page, "files");
  await page.click("#file-choose");
  await wait(page, 500);
  await rule({
    what: "a file's transcript",
    buttons: "#file-clear",
    elsewhere: "#file-name",
    labels: { en: ["Remove transcript", "Remove transcript?"], de: ["Transkript entfernen", "Transkript entfernen?"] },
    said: { en: "Press again to remove the transcript. Esc cancels.", de: "Nochmals drücken entfernt das Transkript. Esc bricht ab." },
    left: () => page.evaluate(() => (document.getElementById("file-text").value ? 1 : 0)),
    gone: true,
  });
  if (lang === "en") out.push(...expect(await page.evaluate(() => document.activeElement.id === "file-choose"), "after Clear the focus is on Choose file"));

  // Soundboard: a sound, a category. The mocked backend keeps both; a failure is said in the board's notice.
  await section(page, "soundboard");
  const board = () => page.evaluate(() => window.__MOCK__.emit("soundboard-changed", null));
  await rule({
    what: "a sound",
    buttons: "#sb-root .sb-delete",
    elsewhere: title,
    cmd: "soundboard_remove",
    named: true,
    stays: true,
    redraw: board,
    reason: written(page, "it broke"),
  });
  await page.click("#sb-root .sb-chip:nth-child(2)");
  await wait(page, 200);
  await rule({
    what: "a sound category",
    buttons: '#sb-root [data-delete-id^="category-"]',
    elsewhere: title,
    cmd: "soundboard_category_remove",
    named: true,
    stays: true,
    redraw: board,
    reason: written(page, "it broke"),
  });

  // Nothing else in the window deletes at one click: every button that says "Delete" has the rule.
  const bare = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /^(Delete|Löschen|Remove|Entfernen|Clear|Leeren)/.test(b.textContent.trim()) && !b.dataset.deleteId).map((b) => b.id || b.className));
  out.push(...expect(bare.length === 0, "every Delete button of the window has the rule", bare.join(", ")));
}

/**
 * An armed button that is scrolled out of view disarms. It keeps the keyboard focus up there, and Enter would
 * delete what nobody sees: Enter then only arms it again, and brings it back into view.
 */
async function scrolledAway(page) {
  const out = [];
  await page.evaluate(() => {
    window.__MOCK__.addHistory(60);
    window.__MOCK__.emit("history-updated", null);
  });
  await wait(page, 200);
  await page.click("#history-more");
  await wait(page, 200);
  const state = () =>
    page.evaluate(() => {
      const b = document.querySelector("#history-list [data-delete-id]");
      const r = b.getBoundingClientRect();
      return { armed: b.classList.contains("armed"), focus: document.activeElement === b, shows: r.bottom > 0 && r.top < window.innerHeight, live: document.getElementById("delete-live").textContent, rows: document.querySelectorAll("#history-list .history-item").length, sent: window.__MOCK__.calls.filter((c) => c.cmd === "history_delete").length };
    });
  const first = page.locator("#history-list [data-delete-id]").first();
  await first.click();
  const start = await state();
  // A little way, and the button still shows: it stays armed.
  await page.mouse.wheel(0, 60);
  await wait(page, 200);
  let s = await state();
  out.push(...expect(start.armed && start.rows === 50 && s.armed && s.shows, "a scroll that leaves the armed button in view leaves it armed", JSON.stringify([start, s])));
  await page.mouse.wheel(0, 3000);
  await wait(page, 200);
  s = await state();
  out.push(...expect(!s.armed && !s.shows && s.live === "", "an armed button that is scrolled out of view disarms", JSON.stringify(s)));
  // It still has the focus. Enter, and Enter again as an answer would be given: the first only arms it, in view.
  await page.keyboard.press("Enter");
  await wait(page, ANSWER);
  s = await state();
  out.push(...expect(s.armed && s.shows && s.focus && s.rows === start.rows && s.sent === start.sent, "Enter on a button that was scrolled away arms it and brings it into view: nothing is deleted unseen", JSON.stringify(s)));
  await page.keyboard.press("Escape");
  return out;
}

/** Home's recordings: of two Play clicks only the one clicked last plays, and it can be stopped. */
async function playProbe(page) {
  const out = [];
  await page.evaluate(() => {
    const real = window.__TAURI_INTERNALS__.invoke;
    // A recording takes a moment to arrive.
    window.__TAURI_INTERNALS__.invoke = (c, a) => (c === "history_audio" ? new Promise((done) => setTimeout(() => done(new ArrayBuffer(64)), 200)) : real(c, a));
    window.__sound = { played: 0, sounding: new Set() };
    HTMLMediaElement.prototype.play = function () {
      window.__sound.played++;
      window.__sound.sounding.add(this);
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      window.__sound.sounding.delete(this);
    };
  });
  const plays = page.locator('#history-list [data-action="play"]');
  const label = await plays.first().textContent();
  const state = async () => {
    const s = await page.evaluate(() => ({ played: window.__sound.played, sounding: window.__sound.sounding.size }));
    const texts = await plays.allTextContents();
    return { ...s, stop: texts.flatMap((t, i) => (t !== label ? [i] : [])) };
  };
  // A double-click on Play: one recording plays, and its button stops it.
  await plays.first().dblclick();
  await wait(page, 500);
  let s = await state();
  out.push(...expect(s.played === 1 && s.sounding === 1 && s.stop.join() === "0", "a double-click on Play plays one recording", JSON.stringify(s)));
  await plays.first().click();
  await wait(page, 100);
  s = await state();
  out.push(...expect(s.sounding === 0 && s.stop.length === 0, "the recording a double-click started can be stopped", JSON.stringify(s)));
  // Play in two rows, one right after the other: only the second plays.
  await plays.nth(0).click();
  await plays.nth(1).click();
  await wait(page, 500);
  s = await state();
  out.push(...expect(s.played === 2 && s.sounding === 1 && s.stop.join() === "1", "of two Play clicks only the one clicked last plays", JSON.stringify(s)));
  await plays.nth(1).click();
  await wait(page, 100);
  s = await state();
  out.push(...expect(s.sounding === 0 && s.stop.length === 0, "and its button stops it", JSON.stringify(s)));
  return out;
}

/** The pop-out is the same board in a window of its own: its delete follows the rule there too. */
async function popoutDeletes(page, run) {
  const out = [];
  page.setDefaultTimeout(5000);
  // The pop-out starts by itself: its delete buttons read in the Display Language from the first draw.
  const first = await page.evaluate(() => [...document.querySelectorAll("[data-delete-id]")].map((b) => b.textContent));
  out.push(...expect(first.length > 0 && first.every((text) => text === (run.lang === "de" ? "Löschen" : "Delete")), "at the start every delete button of the pop-out reads in the Display Language", JSON.stringify(first)));
  try {
    await deleteRule(
      page,
      run.lang,
      {
        what: "a sound in the pop-out",
        buttons: ".sb-delete",
        elsewhere: ".sb-length",
        cmd: "soundboard_remove",
        named: true,
        stays: true,
        redraw: () => page.evaluate(() => window.__MOCK__.emit("soundboard-changed", null)),
        reason: written(page, "it broke", "body"),
      },
      out,
    );
  } catch (e) {
    out.push(...expect(false, "the check of the pop-out's delete could not go on", String(e).split("\n").slice(0, 3).join(" ")));
  }
  page.setDefaultTimeout(30_000);
  // A new start: the board is as it was for the page that follows.
  await page.reload({ waitUntil: "networkidle" });
  await wait(page, 500);
  return out;
}

// ── The tool pages (Task 8) ───────────────────────────

/** From this much room beside the sidebar the Soundboard's settings panel is a column of its own (`WIDE` in src/shell.ts). */
const BOARD_STEP = 900;

/**
 * The Soundboard as its page shows it at its top (the keyboard walk before a probe leaves the page where its last
 * control is). `wide` is decided as src/soundboard/board.ts decides it: on the room beside the sidebar with the
 * scrollbar's own room in it.
 */
const boardNow = (page) =>
  page.evaluate((step) => {
    const content = document.getElementById("content");
    for (const el of [document.scrollingElement, content]) if (el) el.scrollTop = 0;
    const button = document.querySelector('#sb-root [data-key="settings"]');
    const panel = document.getElementById("sb-panel");
    const first = document.querySelector("#sb-root .sb-row, #sb-root .sb-list .empty-state");
    const toggle = document.querySelector('#sb-root .sb-bar [data-key="enabled"]')?.closest("label")?.getBoundingClientRect();
    return {
      wide: content ? content.offsetWidth >= step : false,
      popOut: !content,
      panel: !!panel,
      expanded: button?.getAttribute("aria-expanded"),
      controls: !!panel && button?.getAttribute("aria-controls") === panel.id,
      switchShown: !!toggle && toggle.width > 0 && toggle.top >= 0 && toggle.bottom <= window.innerHeight,
      firstSound: first ? Math.round(first.getBoundingClientRect().top) : -1,
      height: window.innerHeight,
      focus: document.activeElement?.dataset?.key ?? "",
      inPanel: !!document.activeElement?.closest("#sb-panel"),
    };
  }, BOARD_STEP);

/** The panel as a window without a choice has it: open only where it has a column of its own. A page that changed it for its picture puts it back. */
async function panelAtRest(page) {
  const now = await boardNow(page);
  if (now.expanded === undefined || now.panel === (now.wide && !now.popOut)) return;
  await page.click('#sb-root [data-key="settings"]');
  await wait(page, 150);
}

/**
 * The sound tiles: they fill the library's width (the last of a row ends at
 * its right edge), and the controls of every tile stand under each other
 * (category, hotkey and volume start at the same place in each tile).
 */
async function tiles(page) {
  const see = await page.evaluate(() => {
    const library = document.querySelector("#sb-root .sb-col-library").getBoundingClientRect();
    const rows = [...document.querySelectorAll("#sb-root .sb-row")].map((row) => {
      const r = row.getBoundingClientRect();
      const at = (sel) => Math.round(row.querySelector(sel).getBoundingClientRect().left - r.left);
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width), controls: [at(".sb-category"), at(".sb-hotkey"), at(".sb-controls .sb-slider")].join("/") };
    });
    return { library: [Math.round(library.left), Math.round(library.right)], rows };
  });
  if (!see.rows.length) return [];
  const columns = new Set(see.rows.map((r) => r.left)).size;
  const reach = Math.max(...see.rows.filter((r) => r.top === see.rows[0].top).map((r) => r.right));
  const fits = Math.max(1, Math.floor((see.library[1] - see.library[0] + 8) / 448));
  return [
    ...expect(new Set(see.rows.map((r) => r.controls)).size === 1, "the controls of every sound tile stand under each other", JSON.stringify(see.rows.map((r) => r.controls))),
    ...expect(columns === Math.min(fits, see.rows.length) || (columns === fits && see.rows.length >= fits), "the sound tiles take as many columns as the library has room for", `${columns} columns, room for ${fits}, ${JSON.stringify(see.library)}`),
    ...expect(see.rows.length < fits || Math.abs(reach - see.library[1]) <= 1, "a row of sound tiles ends at the library's right edge", `${reach} of ${see.library[1]}`),
    ...expect(see.rows.every((r) => r.left >= see.library[0] - 1 && r.right <= see.library[1] + 1), "no sound tile leaves the library", JSON.stringify(see)),
  ];
}

/** The "More" of the panel's rows: named after its row like every "More" of Settings, opened in place, the focus stays. */
async function panelMore(page) {
  const out = [];
  const mores = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#sb-panel .hint-more")].map((b) => ({
        text: b.textContent,
        name: b.getAttribute("aria-label") ?? "",
        label: b.closest(".setting-row").querySelector(".label-text").textContent,
        open: b.getAttribute("aria-expanded"),
        long: !document.getElementById(b.getAttribute("aria-controls")).hidden,
        focused: document.activeElement === b,
      })),
    );
  let now = await mores();
  out.push(...expect(now.length === 3 && now.every((m) => m.name.length > m.text.length && m.name.includes(m.label)), 'every "More" of the Soundboard\'s panel is named after its row', JSON.stringify(now.map((m) => m.name))));
  // A hint that ends in "More" is one line where its row has the line free: in the pop-out, where a row's label
  // stands over its control, the label was as wide as its own words and the hint broke before its last word
  // ("Stoppt jeden / Sound. Mehr" in a row of 388 px).
  const hints = await page.evaluate(() =>
    [...document.querySelectorAll("#sb-panel .label-hint:has(> .hint-more)")].map((hint) => {
      const words = hint.querySelector("span");
      const range = document.createRange();
      range.selectNodeContents(words);
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;white-space:nowrap;visibility:hidden";
      probe.textContent = words.textContent;
      hint.append(probe);
      const need = probe.getBoundingClientRect().width + parseFloat(getComputedStyle(words).paddingRight);
      probe.remove();
      return { text: words.textContent, lines, need: Math.round(need), room: Math.round(hint.closest(".setting-row").getBoundingClientRect().width) };
    }),
  );
  out.push(...expect(hints.length === 3 && hints.every((h) => h.lines === 1 || h.need > h.room), 'in the Soundboard\'s panel a hint that ends in "More" is one line where its row has the room', JSON.stringify(hints)));
  await page.focus("#sb-panel .hint-more");
  await page.keyboard.press("Enter");
  await wait(page, 150);
  now = await mores();
  out.push(...expect(now[0]?.open === "true" && now[0].long && now[0].focused && now[0].name !== now[1]?.name && !now[1]?.long, "More opens its row's long text in place and keeps the focus", JSON.stringify(now[0])));
  await page.keyboard.press("Enter");
  await wait(page, 150);
  now = await mores();
  out.push(...expect(now[0]?.open === "false" && !now[0].long && now[0].focused, "Less closes it again", JSON.stringify(now[0])));
  await page.evaluate(() => document.activeElement?.blur?.());
  return out;
}

/** "Soundboard settings" is a disclosure: it says whether its panel is open, the keyboard opens and closes it without losing its place, and the panel holds no one. */
async function panelByKeyboard(page) {
  const out = [];
  const before = await boardNow(page);
  await page.focus('#sb-root [data-key="settings"]');
  await page.keyboard.press("Enter");
  await wait(page, 150);
  let now = await boardNow(page);
  out.push(...expect(now.panel === !before.panel && now.expanded === String(now.panel) && now.focus === "settings", "Enter on Soundboard settings opens or closes the panel and the focus stays on the button", JSON.stringify(now)));
  await page.keyboard.press("Enter");
  await wait(page, 150);
  now = await boardNow(page);
  out.push(...expect(now.panel === before.panel && now.focus === "settings", "and Enter again puts it back", JSON.stringify(now)));
  if (!now.panel) {
    await page.keyboard.press("Enter");
    await wait(page, 150);
  }
  now = await boardNow(page);
  out.push(...expect(now.panel && now.controls && now.expanded === "true", "the open panel is the one its button names (aria-controls, aria-expanded)", JSON.stringify(now)));
  // Tab goes from the button into the panel (past the link of the missing-cable hint, where that shows),
  // Esc changes nothing there, and Tab leaves it at its end.
  await page.keyboard.press("Tab");
  if (!(await boardNow(page)).inPanel) await page.keyboard.press("Tab");
  now = await boardNow(page);
  out.push(...expect(now.inPanel, "Tab goes from the button into its panel", JSON.stringify(now)));
  await page.keyboard.press("Escape");
  await wait(page, 100);
  now = await boardNow(page);
  out.push(...expect(now.panel && now.inPanel, "Esc in the panel closes nothing and moves nothing", JSON.stringify(now)));
  let left = false;
  for (let i = 0; i < 40 && !left; i++) {
    await page.keyboard.press("Tab");
    left = !(await boardNow(page)).inPanel;
  }
  out.push(...expect(left, "Tab leaves the panel at its end"));
  if (!before.panel) await page.click('#sb-root [data-key="settings"]');
  await wait(page, 150);
  await page.evaluate(() => document.activeElement?.blur?.());
  return out;
}

/**
 * The Soundboard's step (900 px beside the sidebar: from there the settings
 * panel is open as a column of its own) in a window that draws its scrollbar,
 * as Home's and Settings' steps are tried (`layoutHolds`, `settingsHold`).
 * With no sound in the library the form with the panel is much higher than
 * the one without: a step decided on a width the scrollbar takes away would
 * open the panel, get a scrollbar, close it, lose the scrollbar, and so on in
 * every frame. Tried around the step and across the scrollbar's own width,
 * at the window heights where each form just fits and just does not and at
 * one between the two. Nothing may change by itself, and the same width is
 * the same form whatever the page's height.
 */
async function boardHolds(run) {
  const win = await run.openWindow({ scenario: "firstrun", lang: run.lang, size: "1300x1000", url: "/", scrollbars: true });
  const { page } = win;
  const tried = [];
  const forms = new Set();
  try {
    await section(page, "soundboard");
    const side = await page.evaluate(() => window.innerWidth - document.getElementById("content").offsetWidth);
    const fit = async (width) => {
      await page.setViewportSize({ width: width + side, height: 3000 });
      await wait(page, 120);
      return page.evaluate(() => Math.round(window.innerHeight - document.getElementById("content").clientHeight + document.getElementById("section-soundboard").getBoundingClientRect().height));
    };
    const low = await fit(BOARD_STEP - 1);
    const high = await fit(BOARD_STEP);
    const heights = [...new Set([low - 1, low + 1, Math.round((low + high) / 2), high - 1, high + 1])];
    for (const width of [BOARD_STEP - 1, BOARD_STEP, BOARD_STEP + 1, BOARD_STEP + 3, BOARD_STEP + 6, BOARD_STEP + 10, BOARD_STEP + 15, BOARD_STEP + 16]) {
      for (const height of heights) {
        await page.setViewportSize({ width: width + side, height });
        await wait(page, 60);
        const seen = await page.evaluate(
          (step) =>
            new Promise((done) => {
              const root = document.getElementById("sb-root");
              const content = document.getElementById("content");
              const look = () => `${root.classList.contains("wide") ? "wide" : "narrow"} ${document.getElementById("sb-panel") ? "open" : "closed"} ${content.offsetWidth - content.clientWidth}`;
              let was = look();
              let n = 0;
              const end = performance.now() + 150;
              const frame = () => {
                const now = look();
                if (now !== was) n++;
                was = now;
                if (performance.now() < end) requestAnimationFrame(frame);
                else done({ changes: n, form: now, right: now.startsWith(content.offsetWidth >= step ? "wide open" : "narrow closed") });
              };
              requestAnimationFrame(frame);
            }),
          BOARD_STEP,
        );
        forms.add(seen.form);
        tried.push({ size: `${width}x${height}`, changes: seen.changes, form: seen.form, right: seen.right });
      }
    }
    const moved = tried.filter((t) => t.changes > 0);
    const wrong = tried.filter((t) => !t.right);
    const kinds = new Set([...forms].map((f) => `${f.split(" ")[0]} ${f.split(" ")[2] === "0" ? "without" : "with"}`));
    return [
      ...expect(high > low + 100, "the layout check of the Soundboard has a form with the panel that is much the higher one", `${low} and ${high} px`),
      ...expect(kinds.size === 4, "the layout check of the Soundboard sees the panel as a column and closed, each with and without the scrollbar", JSON.stringify([...forms])),
      ...expect(moved.length === 0, "the Soundboard's layout holds still at its step with a scrollbar", `${moved.length} of ${tried.length} sizes change by themselves, e.g. ${JSON.stringify(moved.slice(0, 3))}`),
      ...expect(wrong.length === 0, "the Soundboard's panel follows the room beside the sidebar alone, with or without a scrollbar", `${wrong.length} of ${tried.length} sizes, e.g. ${JSON.stringify(wrong.slice(0, 3))}`),
    ];
  } finally {
    await win.context.close();
  }
}

/**
 * The main window and the pop-out share the store of what is remembered.
 * Each keeps the panel's state for its own layout, and neither writes back
 * what it read at its own start: a change in one window does not undo the
 * other's (the rule itself is pinned in tests/unit/prefs.test.ts).
 */
async function twoWindows(page) {
  const out = [];
  const saved = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("rudariflow-ui") ?? "{}").panels ?? {});
  const press = async (p) => {
    await p.click('#sb-root [data-key="settings"]');
    await wait(p, 150);
  };
  const pop = await page.context().newPage();
  try {
    await pop.setViewportSize({ width: 460, height: 680 });
    await pop.goto(new URL("/soundboard.html", page.url()).href, { waitUntil: "networkidle" });
    await wait(pop, 400);
    const mainWas = await boardNow(page);
    const popWas = await boardNow(pop);
    // Both windows are open. The main window changes its panel, then the pop-out its own,
    // then the main window remembers something else (the place it is on).
    await press(page);
    await press(pop);
    await settings(page, "general");
    await section(page, "soundboard");
    let panels = await saved(page);
    const layout = mainWas.wide ? "wide" : "narrow";
    out.push(...expect(panels[layout] === !mainWas.panel && panels.popout === !popWas.panel, "the main window and the pop-out each keep their panel's state, and neither undoes the other's", JSON.stringify(panels)));
    // The other way round: the pop-out first, then the main window, then the pop-out again.
    await press(pop);
    await press(page);
    await press(pop);
    panels = await saved(pop);
    out.push(...expect(panels[layout] === mainWas.panel && panels.popout === !popWas.panel, "also when the pop-out writes last", JSON.stringify(panels)));
    // A new start of each window shows its own choice.
    await page.reload({ waitUntil: "networkidle" });
    await wait(page, 400);
    await section(page, "soundboard");
    await pop.reload({ waitUntil: "networkidle" });
    await wait(pop, 400);
    const mainNow = await boardNow(page);
    const popNow = await boardNow(pop);
    out.push(...expect(mainNow.panel === mainWas.panel && popNow.panel === !popWas.panel, "after a new start each window shows the state it was left in", JSON.stringify({ main: mainNow.panel, popOut: popNow.panel })));
    await press(pop);
  } finally {
    await pop.close();
  }
  return out;
}

/** Files: the drop zone and the options, alone and with a file loaded. */
const filesNow = (page) =>
  page.evaluate(() => {
    const section = document.getElementById("section-files");
    const content = document.getElementById("content");
    const cs = getComputedStyle(section);
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const page = section.getBoundingClientRect();
    const options = section.querySelector(".files-options");
    const more = document.getElementById("file-options-more");
    return {
      roomy: section.classList.contains("roomy"),
      room: content.offsetWidth,
      loaded: section.classList.contains("has-file"),
      page: { left: Math.round(page.left + parseFloat(cs.paddingLeft)), right: Math.round(page.right - parseFloat(cs.paddingRight)), bottom: Math.round(page.bottom - parseFloat(cs.paddingBottom)) },
      scrolls: content.scrollHeight > content.clientHeight + 1,
      zone: box(document.getElementById("file-drop")),
      // The zone's one-line form: its title and its button side by side, the formats gone.
      oneLine: getComputedStyle(document.getElementById("file-drop")).flexDirection === "row" && !document.querySelector("#file-drop .label-hint").checkVisibility(),
      options: box(options),
      // The options' short form: both choices on one level, no hint, "More" at their end.
      selects: [...options.querySelectorAll("select")].map((el) => Math.round(el.getBoundingClientRect().top)),
      hints: [...options.querySelectorAll(".setting-label .label-hint")].filter((el) => el.checkVisibility()).length,
      more: more.checkVisibility() ? more.getAttribute("aria-expanded") : null,
      moreNamed: more.getAttribute("aria-label") ?? "",
      title: section.querySelector(".section-title").textContent,
      transcript: document.getElementById("file-text").getAttribute("aria-label") ?? "",
      inCard: options.classList.contains("card"),
    };
  });

/**
 * Files without a result. What to set comes before where to drop: the options, and under them the zone, both
 * from the page's left edge to its right one. No file: the zone is as high as the window leaves (its top 16 px
 * under the options, its bottom the page's); from 1250 px the two choices stand side by side in their card. With
 * a file the zone is one line and the options are their short form (both choices on one level, no hint, "More"
 * at their end); from 1250 px both stand in the side column.
 */
function filesLayout(see, lang) {
  const detail = JSON.stringify(see);
  const out = [
    ...expect(see.title === (lang === "de" ? "Dateien" : "Files"), "the page is called Files", see.title),
    ...expect(see.inCard && see.transcript.length > 0, "the options stand in a card and the transcript has a name", detail),
    ...expect(see.roomy === see.room >= ROOMY, `Files has room for two columns from ${ROOMY} px beside the sidebar`, detail),
    ...expect(see.zone.left === see.page.left && see.options.left === see.page.left && see.zone.top >= see.options.bottom, "the options and the drop zone start on the page's left edge, the options first and the zone under them", detail),
    ...expect(see.loaded ? see.oneLine && see.zone.height <= 56 : !see.oneLine, "with a file loaded the drop zone is one line, and only then", detail),
  ];
  if (!see.loaded) {
    out.push(...expect(Math.abs(see.zone.right - see.page.right) <= 1 && Math.abs(see.options.right - see.page.right) <= 1, "without a file the drop zone and the options end at the page's right edge", detail));
    out.push(...expect(see.scrolls || (see.zone.top - see.options.bottom === 16 && Math.abs(see.zone.bottom - see.page.bottom) <= 1 && see.zone.height >= 110), "without a file the drop zone takes the height the window leaves, under the options", detail));
    out.push(...expect(see.more === null && see.hints === 2 && (see.roomy ? see.selects[0] === see.selects[1] : see.selects[1] > see.selects[0]), "without a file the options show their hints; in a window with room for two columns the two choices stand side by side", detail));
    return out;
  }
  const side = see.zone.right - see.zone.left;
  out.push(...expect(see.more === "false" && see.hints === 0 && see.selects[0] === see.selects[1] && see.options.height <= 84 && /Sprache und Sprechern|language and speakers/.test(see.moreNamed), "with a file loaded the options are one line: both choices on one level, no hint, and a More that says what it is about", detail));
  out.push(
    ...expect(
      see.roomy ? side >= 360 && side <= 622 && see.options.right === see.zone.right : Math.abs(see.zone.right - see.page.right) <= 1 && Math.abs(see.options.right - see.page.right) <= 1,
      "with a file loaded the zone and the options have the page's width, or the side column's in a window with room for two",
      detail,
    ),
  );
  return out;
}

/** "More" opens the options as they are without a file (the hints under the names), and closes them again; the transcript's place follows. */
async function optionsMore(page) {
  const top = () => page.evaluate(() => Math.round(document.getElementById("file-text").getBoundingClientRect().top));
  const was = [await filesNow(page), await top()];
  await page.click("#file-options-more");
  await wait(page, 80);
  const open = [await filesNow(page), await top()];
  await page.click("#file-options-more");
  await wait(page, 80);
  const shut = [await filesNow(page), await top()];
  return expect(
    open[0].more === "true" && open[0].hints === 2 && open[0].options.height > was[0].options.height && /Weniger|Less/.test(open[0].moreNamed) && shut[0].hints === 0 && shut[0].options.height === was[0].options.height && shut[1] === was[1],
    "More opens the options' hints and Less closes them again, and the transcript is back where it was",
    JSON.stringify({ was: [was[0].hints, was[0].options.height, was[1]], open: [open[0].more, open[0].hints, open[0].options.height, open[0].moreNamed, open[1]], shut: [shut[0].hints, shut[0].options.height, shut[1]] }),
  );
}

/**
 * Files with a result: the one rule it shares with an open meeting. One column: every part has the page's width
 * (the file's line, "Summarise with AI", the summary, the toolbar, the transcript). Two columns, from 1250 px
 * beside the sidebar: the side column at the left (the options, the zone's line, the file's line, Summarise and
 * the summary, all on one left and one right edge, 340 to 622 px wide) and the transcript at the right under its
 * toolbar, both ending at the page's right edge, one gutter of 16 px from the side column; the frame runs down
 * to the page's bottom. In both the frame is as wide as its column and the text keeps its measure in it (what
 * is left of the frame at the right is its own padding).
 */
async function resultLayout(page) {
  const see = await page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
    };
    const section = document.getElementById("section-files");
    const scs = getComputedStyle(section);
    const page = section.getBoundingClientRect();
    const text = document.getElementById("file-text");
    const cs = getComputedStyle(text);
    const summary = document.getElementById("file-summary-box");
    return {
      roomy: section.classList.contains("roomy"),
      page: { left: Math.round(page.left + parseFloat(scs.paddingLeft)), right: Math.round(page.right - parseFloat(scs.paddingRight)), bottom: Math.round(page.bottom - parseFloat(scs.paddingBottom)) },
      scrolls: document.getElementById("content").scrollHeight > document.getElementById("content").clientHeight + 1,
      text: box(text),
      // The room the text has in its frame, and the measure it must not pass.
      line: Math.round(text.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      measure: Math.round(parseFloat(cs.fontSize) * 42),
      toolbar: box(section.querySelector(".file-toolbar")),
      actions: box(section.querySelector(".file-actions")),
      zone: box(document.getElementById("file-drop")),
      options: box(section.querySelector(".files-options")),
      job: box(document.getElementById("file-job")),
      clear: box(document.getElementById("file-clear")),
      summarize: box(document.getElementById("file-summarize")),
      summary: summary.checkVisibility() ? { ...box(summary), copy: box(document.getElementById("file-summary-copy")), outline: getComputedStyle(summary).borderTopWidth } : null,
      order: [...section.children].filter((el) => el.checkVisibility()).map((el) => el.id || el.className.split(" ")[0]),
    };
  });
  const detail = JSON.stringify(see);
  const out = [
    ...expect(see.line <= see.measure + 1 && see.line >= Math.min(see.measure, see.text.width - 40) - 4, "a transcript's text keeps its measure in a frame of any width", detail),
    ...expect(Math.abs(see.text.right - see.page.right) <= 1 && Math.abs(see.toolbar.right - see.page.right) <= 1 && Math.abs(see.actions.right - see.page.right) <= 1, "the transcript and its toolbar end at the page's right edge", detail),
    ...expect(see.order.indexOf("file-summarize") === see.order.indexOf("file-job") + 1 && see.order.at(-1) === "file-result", "the page's order: the file's line, Summarise with AI and its summary, then the transcript", JSON.stringify(see.order)),
    ...expect(!see.summary || see.summary.outline === "0px", "the summary is a card like every card: no outline", detail),
  ];
  const left = [see.zone, see.options, see.job, see.summarize, ...(see.summary ? [see.summary] : [])];
  if (!see.roomy) {
    out.push(...expect(left.every((b) => b.left === see.page.left) && see.text.left === see.page.left && [see.zone, see.options, see.job, ...(see.summary ? [see.summary] : [])].every((b) => Math.abs(b.right - see.page.right) <= 1), "in one column every part of Files has the page's width", detail));
    return out;
  }
  const side = see.zone.right - see.zone.left;
  out.push(
    ...expect(
      left.every((b) => b.left === see.page.left) && [see.zone, see.options, see.job, ...(see.summary ? [see.summary] : [])].every((b) => b.right === see.zone.right) && see.summarize.right <= see.zone.right && side >= 360 && side <= 622,
      "in two columns the side column holds the zone, the options, the file's line, Summarise and the summary on one left and one right edge",
      detail,
    ),
    ...expect(see.text.left - see.zone.right === 16 && see.toolbar.left === see.text.left && see.toolbar.top === see.options.top && Math.abs(see.toolbar.bottom - see.options.bottom) <= 1 && see.text.top >= see.toolbar.bottom, "the transcript stands one gutter (16 px) right of the side column, under its toolbar, which has the options' line and its height", detail),
    ...expect(see.scrolls || Math.abs(see.text.bottom - see.page.bottom) <= 1, "the transcript's frame runs down to the page's bottom", detail),
    ...expect(Math.abs(see.clear.right - see.zone.right) <= 12, "the file's line ends with the side column", detail),
  );
  if (see.summary) out.push(...expect(see.summary.top >= see.summarize.bottom && see.summary.copy.right <= see.summary.right && see.summary.copy.left >= see.summary.left, "the summary stands under Summarise with AI in the side column, with Hide and Copy over its own text", detail));
  return out;
}

/**
 * With "prefers-reduced-motion: reduce" nothing moves: no element of the
 * window, the pop-out or the pill has an animation or a transition with a
 * duration, in the states that move without the setting (a page that comes,
 * a fold that opens, a meeting that records, a file's bar, a sound that
 * plays, the pill while it transcribes and polishes).
 */
async function reducedMotion(page, run) {
  const out = [];
  if (run.lang !== "en") return out;
  const moving = (p) => p.evaluate(() => window.__uic.stillMoving());
  await section(page, "home");
  out.push(...expect((await moving(page)).some((m) => m.includes("page-in")), "the motion check sees the page's own animation while motion is allowed", JSON.stringify((await moving(page)).slice(0, 4))));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const places = [
    ["Home", () => section(page, "home")],
    [
      "Files with a file",
      async () => {
        await section(page, "files");
        await page.click("#file-choose");
        await wait(page, 500);
      },
    ],
    [
      "a meeting that records",
      async () => {
        await section(page, "meetings");
        await page.evaluate(() => window.__MOCK__.emit("meeting-status", window.__MOCK__.meetingRecording()));
        await wait(page, 500);
      },
    ],
    [
      "the Soundboard with a sound playing",
      async () => {
        await section(page, "soundboard");
        await page.evaluate(() => window.__MOCK__.emit("soundboard-playing", [{ id: "s4", posMs: 31000, durationMs: 94000 }]));
        await wait(page, 200);
      },
    ],
    ...TABS.map((tab) => [
      `Settings, ${tab}, with its fold open`,
      async () => {
        await page.evaluate((t) => document.querySelector(`details.fold[data-fold="${t}"]`) && (document.querySelector(`details.fold[data-fold="${t}"]`).open = true), tab);
        await settings(page, tab);
      },
    ]),
  ];
  for (const [name, open] of places) {
    await open();
    const left = await moving(page);
    out.push(...expect(left.length === 0, `with reduced motion nothing moves: ${name}`, left.slice(0, 5).join("; ")));
  }
  await page.emulateMedia({ reducedMotion: null });
  // The pop-out and the pill are windows of their own, the pill with its own styles.
  const others = [
    ["the pop-out", "/soundboard.html", "460x680", `window.__MOCK__.emit("soundboard-playing", [{ id: "s4", posMs: 31000, durationMs: 94000 }]);`],
    ["the pill while it transcribes", "/src/overlay.html", "320x64", `window.__overlayUpdate("recording"); window.__overlayUpdate("transcribing");`],
    ["the pill while it polishes", "/src/overlay.html", "320x64", `window.__overlayUpdate("recording"); window.__overlayUpdate("transcribing"); window.__overlayUpdate("polishing");`],
    ["the pill with a notice", "/src/overlay.html", "320x64", `window.__MOCK__.emit("gpu-notice", "freed");`],
  ];
  for (const [name, url, size, script] of others) {
    const win = await run.openWindow({ scenario: run.scenario, lang: run.lang, size, url });
    try {
      await win.page.evaluate(script);
      await wait(win.page, 200);
      const free = await moving(win.page);
      await win.page.emulateMedia({ reducedMotion: "reduce" });
      await wait(win.page, 100);
      const left = await moving(win.page);
      // The pill moves while motion is allowed: the check has something to find there.
      if (url.includes("overlay")) out.push(...expect(free.length > 0, `the motion check sees what moves in ${name}`, String(free.length)));
      out.push(...expect(left.length === 0, `with reduced motion nothing moves: ${name}`, left.slice(0, 5).join("; ")));
    } finally {
      await win.context.close();
    }
  }
  // A new start: the meeting no longer records for the pages that follow.
  await again(page);
  return out;
}

// ── The states the pages above never open (review of Task 8) ──
//
// A page is measured and shot as its `open` leaves it, and until the review of
// Task 8 every page was opened at rest. What a state changes was never seen:
// a key box that asks for its key covered its own label, and the second line
// of a sound's tile lay on the tile beside it. Each state below is a page.
// They are opened with the data of a PC in daily use, at the smallest window
// and at the usual one, in both languages (`state`), and each starts the
// window anew, because a state would stay: by what the page shows, not by the
// clock (`restart`).
//
// A state page proves its state (re-review of Task 8). 23 of the 55 passed
// with an `open` that never reached the state: the tray's question was never
// asked, the key was never refused, and the checks measured the page at rest,
// which is clean. So every state page has a `shows` (`onScreen`), asked right
// after `open` and before anything is measured: the dialog is open, the line
// is red and says the backend's words, the key box listens and shows its
// prompt, the menu is open. run.mjs does not start with a state page that has
// none. Proven for five by taking the state out of their `open` in a copy of
// this file: each then fails.

const STATE_SIZES = ["900x600", "1600x900"];

/** A state page: `open` runs in a window that was just started. `more.shows` says what the state looks like. */
const state = (id, open, more = {}) => ({
  id,
  state: true,
  scenarios: ["populated"],
  sizes: STATE_SIZES,
  ...more,
  open: async (page) => {
    await restart(page);
    await open(page);
  },
});

/** Run in the page: tell it something of the mocked backend. */
const emit = (page, event, payload = null) => page.evaluate(([event, payload]) => window.__MOCK__.emit(event, payload), [event, payload]);

/** The control that has the keyboard focus shows it. Asked of the in-page check as the keyboard walk asks it, for a control the walk cannot reach (its first step would end the state). */
async function ring(page, what) {
  const stop = await page.evaluate(() => window.__uic.focusStop());
  return expect(!!stop && !stop.ring, `${what} has the keyboard focus and shows it`, stop ? `${stop.what}: ${stop.ring}` : "nothing has the focus");
}

/**
 * A menu that opens under its button (Export). The walk's first step takes the focus away, which closes
 * it, so its items are tabbed through here: each is reached and shows the focus, and the menu closes when
 * the focus leaves it. It is opened again for the picture.
 */
async function menuItems(page, button, list) {
  const out = [];
  const n = await page.locator(`${list} button`).count();
  await page.focus(button);
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate((list) => ({ ...window.__uic.focusStop(), inside: !!document.activeElement?.closest(list) }), list);
    out.push(...expect(stop.inside && !stop.ring, `Tab reaches item ${i + 1} of the menu, and it shows the focus`, JSON.stringify(stop)));
  }
  await page.keyboard.press("Tab");
  out.push(...expect(await page.evaluate((list) => document.querySelector(list).classList.contains("hidden"), list), "the menu closes when the focus leaves it"));
  await page.click(button);
  await wait(page, 100);
  return out;
}

// ── Key boxes ──

/**
 * A key that was refused stays on its box for 2.5 s, with the reason (src/hotkey-capture.ts). From here
 * on that time does not run out by itself: the state can be measured and is in the picture. `endRefusal`
 * lets it end at once.
 */
const holdRefusal = (page) =>
  page.evaluate(() => {
    if (window.__held) return;
    const real = window.setTimeout;
    window.__held = [];
    window.setTimeout = (fn, ms, ...rest) => (ms === 2500 ? (window.__held.push(fn), 0) : real(fn, ms, ...rest));
  });
const endRefusal = (page) =>
  page.evaluate(() => {
    for (const fn of window.__held?.splice(0) ?? []) fn();
  });

/** The key box `box` asks for its key. */
async function listen(page, box) {
  await page.locator(box).first().click();
  await wait(page, 80);
}

/** The key box `box` says why `keys` was refused (Ctrl+C: a Windows shortcut, the longest reason), and goes on saying it. */
async function refused(page, box, keys = "Control+KeyC") {
  await awaitError(page, /setting the hotkey failed/);
  await holdRefusal(page);
  await listen(page, box);
  await page.keyboard.press(keys);
  await wait(page, 150);
}

/** The checks of the layout: what a state can break without a control or a colour changing. */
const LAYOUT = ["overflow", "clipped", "overlap", "hint-lines"];

/**
 * Every key box `boxes` finds, while it asks for its key and while it says why a key was refused. One box
 * listens at a time, so a page shows one of them in one state; here each is brought into both, and the
 * layout checks are run again each time: nothing is cut, nothing covers the label or the hint, nothing
 * leaves its card or its tile.
 */
async function keyBoxes(page, boxes, scope = "#content") {
  const out = [];
  await awaitError(page, /setting the hotkey failed/);
  await holdRefusal(page);
  // The state the page itself was opened in ends first.
  await page.keyboard.press("Escape");
  await endRefusal(page);
  await wait(page, 80);
  const n = await page.locator(boxes).count();
  out.push(...expect(n > 0, `the key boxes are there (${boxes})`));
  for (let i = 0; i < n; i++) {
    for (const how of ["asks for its key", "says why a key was refused"]) {
      const box = page.locator(boxes).nth(i);
      await box.click();
      await wait(page, 60);
      if (how !== "asks for its key") {
        await page.keyboard.press("Control+KeyC");
        await wait(page, 120);
      }
      const now = await box.evaluate((b) => ({ name: b.id || b.dataset.key || "", listens: b.classList.contains("capturing"), text: b.textContent.length }));
      out.push(...expect(now.listens && now.text > 20, `the key box ${now.name} ${how}`, JSON.stringify(now)));
      const found = await page.evaluate((o) => window.__uic.collect(o), { scope, userText: USER_TEXT });
      out.push(...found.filter((f) => LAYOUT.includes(f.check)).map((f) => ({ ...f, what: `${f.what}, while the key box ${now.name} ${how}` })));
      if (how === "asks for its key") await page.keyboard.press("Escape");
      else await endRefusal(page);
      await wait(page, 80);
    }
  }
  await logged(page);
  return out;
}

// ── Soundboard ──

/** The Soundboard with its settings panel open or closed, whatever the window's size and whatever was chosen before. */
async function boardWith(page, panel) {
  await section(page, "soundboard");
  if ((await page.evaluate(() => !!document.getElementById("sb-panel"))) !== panel) {
    await page.click('#sb-root [data-key="settings"]');
    await wait(page, 150);
  }
}

/** Change what the mocked backend has of the Soundboard (`change` runs in the page), and tell the page as the backend does. */
async function boardSays(page, change) {
  await page.evaluate(change);
  await emit(page, "soundboard-changed");
  await wait(page, 250);
}

/**
 * The hard states of the sound tiles and of the panel's two keys, all at once: a key another program has
 * (on a tile and on both keys of the panel), combinations of three and four keys, a sound whose file is
 * gone, a sound that plays and loops.
 */
const hardBoard = () => {
  const m = window.__MOCK__;
  m.sb.taken = ["s2", "toggleSoundHotkeys", "stopSounds"];
  m.sb.missing = ["s6"];
  m.sb.playing = [{ id: "s4", posMs: 31000, durationMs: 94000 }];
  m.board.sounds[2].hotkey = "CmdOrCtrl+Shift+Numpad3";
  m.board.sounds[4].hotkey = "CmdOrCtrl+Shift+Alt+Numpad5";
};

/** No sound's tile holds anything that leaves it, and the tiles of a row are one height. */
async function tilesHold(page) {
  const see = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#sb-root .sb-row")].map((row) => {
      const r = row.getBoundingClientRect();
      const out = [...row.querySelectorAll("*")].filter((el) => {
        const e = el.getBoundingClientRect();
        return e.width > 2 && e.height > 0 && el.checkVisibility({ visibilityProperty: true }) && Math.max(e.right - r.right, r.left - e.left, e.bottom - r.bottom, r.top - e.top) > 1;
      });
      return { name: row.dataset.name, top: Math.round(r.top), height: Math.round(r.height), out: out.map((el) => el.className || el.tagName) };
    });
    const tops = [...new Set(rows.map((r) => r.top))];
    return { rows: rows.length, leaving: rows.filter((r) => r.out.length), uneven: tops.filter((top) => new Set(rows.filter((r) => r.top === top).map((r) => r.height)).size > 1) };
  });
  return [
    ...expect(see.rows > 0 && see.leaving.length === 0, "nothing leaves its sound tile", JSON.stringify(see.leaving)),
    ...expect(see.uneven.length === 0, "the sound tiles of a row are one height", JSON.stringify(see.uneven)),
  ];
}

const TILE_KEYS = "#sb-root .sb-row .sb-hotkey .hotkey-btn";
const PANEL_KEYS = "#sb-panel .sb-hotkey .hotkey-btn";

/** A PC without a virtual cable, where "Got it" was pressed on an earlier day. The board asks for its devices once, at its start: set for the next start. */
const NO_CABLE = { inputs: ["Microphone (Realtek(R) Audio)"], outputs: ["Speakers (Realtek(R) Audio)"], automatic: { microphone: "Microphone (Realtek(R) Audio)", cable: null, headphones: "Speakers (Realtek(R) Audio)" } };

// ── Meetings ──

/** Open a meeting of the library. */
async function meeting(page, id) {
  await section(page, "meetings");
  await page.click(`#mt-list .mt-item[data-id="${id}"]`);
  await wait(page, 450);
}
const M1 = "m-20261005-1400";
const M2 = "m-20261002-1000";
const M3 = "m-20260928-0900";

/** The live transcript, scrolled up to its start: it no longer follows what comes. */
async function scrolledUp(page) {
  await page.evaluate(() => {
    const box = document.getElementById("mt-transcript");
    box.scrollTop = 0;
    box.dispatchEvent(new Event("scroll"));
  });
  await wait(page, 150);
}

/** A meeting records: the page hears of it as from the backend, and opens its live view. */
async function recording(page, patch = {}) {
  await section(page, "meetings");
  await page.evaluate((patch) => window.__MOCK__.emit("meeting-status", window.__MOCK__.meetingRecording(patch)), patch);
  await wait(page, 600);
}

// ── Files ──

/** A file is being transcribed (the answer waits), and Whisper has sent its first blocks. */
async function fileRuns(page) {
  await section(page, "files");
  await page.evaluate(() => window.__MOCK__.holdNext("transcribe_file"));
  await page.click("#file-choose");
  await asked(page, "transcribe_file");
  await page.evaluate(() => {
    const de = document.documentElement.lang === "de";
    const blocks = de
      ? ["Gut, fangen wir an. Heute geht es um den Shop-Launch und die offenen Punkte beim Checkout.", "Der Checkout läuft auf Staging. Was noch fehlt, ist die Mehrwertsteuer-Anzeige im Warenkorb, das mache ich bis Mittwoch.", "Bei den Produktfotos fehlen noch zwölf Stück."]
      : ["Right, let's start. Today is about the shop launch and the open points in the checkout.", "The checkout works on staging. What is still missing is the VAT display in the cart, I'll do that by Wednesday.", "Twelve product photos are still missing."];
    window.__MOCK__.emit("file-progress", { phase: "reading", done: 172_000, total: 172_000, text: "" });
    window.__MOCK__.emit("file-progress", { phase: "loading", done: 0, total: 1, text: "" });
    blocks.forEach((text, i) => window.__MOCK__.emit("file-progress", { phase: "transcribing", done: 21_000 * (i + 1), total: 172_000, text }));
  });
  await wait(page, 150);
}

/** A file with its transcript, as `files-loaded` has it. */
async function fileLoaded(page) {
  await section(page, "files");
  await page.click("#file-choose");
  await wait(page, 500);
}

// ── Settings ──

/** A Settings tab with its Advanced fold open. */
async function advanced(page, tab) {
  await page.evaluate((t) => (document.querySelector(`details.fold[data-fold="${t}"]`).open = true), tab);
  await settings(page, tab);
}

const SETTINGS_KEYS = "#panel-dictation .hotkey-btn";
const HOME_KEYS = "#home-hotkeys .hotkey-btn";

/** "Try it" with a sentence as it is spoken. */
async function tryIt(page) {
  await advanced(page, "ai");
  await page.fill("#ai-test-input", "um so I think we should uh meet on tuesday no wait wednesday at 3 and bring the slides");
  await page.click("#ai-test-run");
  await wait(page, 250);
}

/** "Try it" has answered: the result shows, its line under it has `tone` and says `says`. */
const triedIt = (what, tone, says, cleaned) =>
  onScreen(
    `Try it: ${what}`,
    ([tone, says, cleaned]) => {
      const meta = document.getElementById("ai-test-meta");
      const now = { result: document.getElementById("ai-test-result").checkVisibility(), tone: meta.dataset.tone ?? "", meta: meta.textContent, cleaned: document.getElementById("ai-test-output").textContent !== document.getElementById("ai-test-input").value && document.getElementById("ai-test-output").textContent.length > 10 };
      return (now.result && now.tone === tone && new RegExp(says).test(now.meta) && (!cleaned || now.cleaned)) || now;
    },
    [tone, says.source, cleaned],
  );

/**
 * The text boxes of AI cleanup for a sentence or two ("Try it", a rule's instructions) are at most 720 px wide and
 * use all of it: none keeps a part of itself empty by padding (the measure inside the box made typed text wrap at
 * 588 px of a field of 1048), and the result has its field's width.
 */
async function tryItFields(page) {
  const see = await page.evaluate(() => {
    const field = (el) => {
      const cs = getComputedStyle(el);
      return { width: Math.round(el.getBoundingClientRect().width), empty: Math.round(parseFloat(cs.paddingRight) - parseFloat(cs.paddingLeft)) };
    };
    return { input: field(document.getElementById("ai-test-input")), result: Math.round(document.getElementById("ai-test-result").getBoundingClientRect().width), rules: [...document.querySelectorAll("#ai-rule-list .rule-instructions")].map(field) };
  });
  const fields = [see.input, ...see.rules];
  return expect(see.rules.length === 3 && fields.every((f) => f.empty === 0 && f.width <= 720) && see.result === see.input.width, "a text box of AI cleanup is at most 720 px wide and uses its whole width; Try it's result is as wide as its field", JSON.stringify(see));
}

// ── Running text ──

/**
 * Running text keeps its measure in a window of 1920 px, where every frame is wide enough to let a line run on
 * (a meeting's transcript had lines of 265 characters there before the measure). Place by place, and each place
 * must have such text to show: Home's dictations, a file's summary and transcript, a meeting's notes and transcript
 * with and without notes, what "Try it" answers, the Soundboard's instructions. With `--measure: 999em` in
 * tokens.css this page fails. The same is asked of every page that is opened at 1920 px or wider (inpage.js,
 * check `measure`).
 */
async function measureProbe(page) {
  const out = [];
  const place = async (name, scope, atLeast = 1) => {
    const m = await page.evaluate((scope) => window.__uic.runningText(scope), scope);
    out.push(...expect(m.pieces >= atLeast && m.longest > 20 && m.longest <= m.most, `running text keeps its measure: ${name}`, `${m.pieces} pieces of text, the longest line has ${m.longest} characters (at most ${m.most})`));
  };
  await section(page, "home");
  await place("Home's dictations", "#history-list", 3);
  await fileLoaded(page);
  await page.click("#file-summarize");
  await wait(page, 400);
  await place("a file's summary", "#file-summary-box");
  await place("a file's transcript", "#file-result");
  await meeting(page, M1);
  await place("a meeting's notes", "#section-meetings .mt-notes", 3);
  await place("a meeting's transcript beside its notes", "#mt-transcript", 7);
  await page.click("#mt-back");
  await wait(page, 300);
  await meeting(page, M3);
  await place("the transcript of a meeting without notes", "#mt-transcript", 7);
  // "Try it" with a long sample that comes back as it was typed.
  await page.evaluate(() => (window.__MOCK__.aiFallback = "The AI model is not downloaded"));
  await advanced(page, "ai");
  await page.fill("#ai-test-input", "um so I think we should uh meet on tuesday no wait wednesday at 3 and bring the slides and also the new price list for the storage rooms because the client asked for it twice last week and nobody had it at hand when he called");
  await page.click("#ai-test-run");
  await wait(page, 250);
  await place("what Try it answers", "#ai-test-result");
  // The Soundboard without a virtual cable: how to get one, in a box as wide as the board.
  await page.evaluate((devices) => window.__MOCK__.keep({ sb: { devices, status: { state: "error", problem: { reason: "no_cable", device: "cable", name: "", detail: "" } } } }), NO_CABLE);
  await restart(page);
  await boardWith(page, false);
  await place("the Soundboard's instructions", "#sb-root");
  return out;
}

// ── After the whole-branch review, wave 1 ──
// What the review of the whole branch found in behaviour, robustness and accessibility: the history that
// was unreachable under the setup steps, saves during the load window, the start's order, saves the backend
// refuses, the Display Language's change, the speech models' list, and the smaller ones. Each has a page or
// a probe here; the pages stand before `measure`, the last page of the main window.

/** The two language tables of src/i18n.ts, and the texts of each that read differently in the other one. */
const I18N = (() => {
  const source = fs.readFileSync(path.join(HERE, "../../src/i18n.ts"), "utf8");
  const en = literal(source, "const en: Translations = {");
  const de = literal(source, "const de: Translations = {");
  const only = (a, b) => {
    const others = new Set(Object.values(b));
    return [...new Set(Object.keys(a).filter((key) => key in b && a[key] !== b[key] && !a[key].includes("{") && a[key].length > 3).map((key) => a[key]))].filter((text) => !others.has(text));
  };
  return { en, de, onlyEn: only(en, de), onlyDe: only(de, en) };
})();

/** The texts of the language the window is NOT in. */
const otherLanguage = (lang) => (lang === "de" ? I18N.onlyEn : I18N.onlyDe);

/**
 * Runs in the page: the texts among `others` that the window shows. What a user can read: the text of
 * every element that shows, a select's chosen option, and the names a screen reader or the pointer gets
 * (aria-label, title, placeholder). `hidden`: also what does not show (a page that is not open).
 */
function foreignTexts([others, hidden]) {
  const set = new Set(others);
  const found = new Set();
  const seen = (text) => {
    const said = (text ?? "").trim();
    if (set.has(said)) found.add(said);
  };
  for (const el of document.querySelectorAll("#app *, dialog *")) {
    if (el.closest("script, style") || el.id === "pc-check-report") continue;
    if (!hidden && !el.checkVisibility()) {
      // A select's chosen option shows, though an <option> has no box.
      if (!(el instanceof HTMLOptionElement && el.selected && el.parentElement?.checkVisibility())) continue;
    }
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) seen(node.textContent);
    for (const name of ["aria-label", "title", "placeholder"]) if (el.hasAttribute(name)) seen(el.getAttribute(name));
  }
  return [...found];
}

/** A real click at the middle of `selector`, scrolled into view first. It goes where the pointer is: a page that rests (`inert`) does not get it. */
async function mouseClick(page, selector) {
  const at = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, selector);
  if (at) await page.mouse.click(at.x, at.y);
  return !!at;
}

/** What the mocked backend holds as saved settings, as one string. */
const savedNow = (page) => page.evaluate(() => JSON.stringify(window.__MOCK__.settings()));

/** The mocked backend answers `ms` late from the first moment of the next start (0: at once again, also now). */
const lateStart = (page, ms) =>
  page.evaluate((ms) => {
    window.__MOCK__.keep({ answerDelay: ms });
    if (!ms) window.__MOCK__.answerDelay = 0;
  }, ms);

// ── The history under the setup steps ──

/** Home, with the steps and what stands under them. */
const underSteps = (page) =>
  page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const shown = (id) => document.getElementById(id).checkVisibility();
    const steps = box("home-setup");
    const list = box("home-recent");
    return {
      steps: shown("home-setup"),
      controls: shown("home-controls"),
      list: shown("home-recent"),
      rows: document.querySelectorAll("#history-list .history-item").length,
      search: shown("history-search"),
      under: list.top >= steps.bottom,
      beside: list.left >= steps.right && Math.abs(list.top - steps.top) <= 1,
      room: document.getElementById("content").offsetWidth,
      edges: [Math.round(steps.left), Math.round(list.left), Math.round(steps.right), Math.round(list.right)],
      title: document.getElementById("home-title").textContent,
      pill: document.getElementById("home-status-text").textContent,
      states: ["setup-mic", "setup-model", "setup-key"].map((id) => document.getElementById(id).dataset.state).join(),
      section: document.querySelector(".content-section.active")?.id,
    };
  });

/** The state of both pages: the steps show, the controls do not, and the recent dictations stand under the steps. */
const stepsAndList = (what) =>
  onScreen(what, () => {
    const shown = (id) => document.getElementById(id).checkVisibility();
    const now = { home: document.getElementById("section-home").classList.contains("active"), steps: shown("home-setup"), list: shown("home-recent"), controls: shown("home-controls"), rows: document.querySelectorAll("#history-list .history-item").length };
    return (now.home && now.steps && now.list && !now.controls && now.rows === 8) || now;
  });

/**
 * Someone who has dictated before and lacks something today (`reason`: what the pill says): the steps, and
 * under them the recent dictations with everything they can do. In 0.16.0 the history was a page of its own;
 * before this fix Home hid the whole daily view behind the steps, and the list was nowhere.
 */
async function historyStays(page, run, reason) {
  const out = [];
  const t = I18N[run.lang];
  const see = await underSteps(page);
  // Under the steps; in a large window (1600 px beside the sidebar) beside them, in Home's grid.
  const grid = see.room >= WIDER;
  out.push(...expect(see.steps && !see.controls && see.list && see.rows === 8 && see.search && (grid ? see.beside : see.under), "while the setup steps show, the recent dictations stay on screen: under them, beside them in a large window", JSON.stringify(see)));
  out.push(...expect(grid ? see.edges[1] - see.edges[2] === 16 : see.edges[0] === see.edges[1] && see.edges[2] === see.edges[3], "the steps and the list share their left and right edge, or stand one gutter apart", JSON.stringify(see.edges)));
  // No newcomer: the plain heading with the reason, not the welcome.
  out.push(...expect(see.title === t.home_title_setup && see.pill === t[reason], "someone with a history is not welcomed as new: the heading is Setup needed, with the reason", JSON.stringify([see.title, see.pill])));
  if (!(run.lang === "en" && run.size === BEHAVIOUR)) return out;
  // The list works: its search, and a dictation is copied.
  await page.fill("#history-search", "olk");
  await wait(page, 150);
  const found = await page.locator("#history-list .history-item").count();
  await page.fill("#history-search", "");
  await wait(page, 150);
  const text = await page.evaluate(() => document.querySelector("#history-list .history-text").textContent);
  await page.click('#history-list .history-item:first-child [data-action="copy"]');
  await wait(page, 150);
  const copied = await page.evaluate(() => [window.__MOCK__.calls.filter((c) => c.cmd === "copy_text").at(-1)?.args.text, document.querySelector('#history-list .history-item:first-child [data-action="copy"]').textContent]);
  out.push(...expect(found === 2 && copied[0] === text && copied[1] === "Copied", "under the steps the list is searched and a dictation is copied", JSON.stringify([found, copied])));
  // Original and Delete too: every action of a row is there.
  const actions = await page.evaluate(() => [...document.querySelectorAll("#history-list .history-item:first-child .history-actions button")].map((b) => b.textContent));
  out.push(...expect(actions.length === 5 && actions[0] === "Delete" && actions.includes("Original") && actions.includes("Play") && actions.includes("Re-run") && actions.at(-1) === "Copied", "a dictation under the steps has every action: Delete, Original, Play, Re-run, and Copy at its end", JSON.stringify(actions)));
  // The window opens where it was left: only a first run is brought to Home.
  await settings(page, "general");
  await restart(page);
  const place = await page.evaluate(() => [document.querySelector(".content-section.active")?.id, document.getElementById("status-indicator").dataset.kind]);
  out.push(...expect(place[0] === "section-settings" && place[1] === "setup", "with a history the window opens where it was left, also while something is missing", JSON.stringify(place)));
  await section(page, "home");
  return out;
}

// ── Saves during the load window ──

const LATE = 600;

/**
 * A click while the settings are still on their way must change nothing: before, every control of
 * Settings was live while only the first of them were filled, and a save reads them all. One click on
 * "Hold" then saved the microphone as "", the model as "small", no replacement and no rule. The pages
 * rest until the settings are shown (a real click does not arrive), a save is refused until then (a
 * click from code arrives and still saves nothing), and the controls are filled in one go right after the
 * answer, with nothing waited for in between.
 */
async function loadWindow(page) {
  const out = [];
  const before = await savedNow(page);
  const places = [
    ["dictation", ["#mode-ptt", "#mode-toggle"]],
    ["ai", ["#ai-rule-add", "#ai-edit-toggle"]],
    ["dictionary", ["#replacement-add", "#swiss-toggle"]],
    ["general", ["#autostart-toggle", "#history-mode-select"]],
  ];
  for (const [tab, controls] of places) {
    await settings(page, tab);
    await lateStart(page, LATE);
    await page.reload({ waitUntil: "domcontentloaded" });
    const rests = await page.evaluate(() => ({ inert: document.getElementById("section-settings").inert, loaded: document.body.dataset.loaded ?? "", asked: window.__MOCK__.calls.some((c) => c.cmd === "get_settings") }));
    for (const selector of controls) {
      // The pointer's click, and the same from code (a script, an assistive tool that presses the element itself).
      await mouseClick(page, selector);
      await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (el instanceof HTMLSelectElement) {
          el.selectedIndex = el.options.length - 1;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else el.click();
      }, selector);
    }
    const still = await page.evaluate(() => document.body.dataset.loaded ?? "");
    await started(page);
    await wait(page, 150);
    const after = await page.evaluate(() => ({
      saves: window.__MOCK__.calls.filter((c) => c.cmd === "save_settings").length,
      autostart: window.__MOCK__.calls.filter((c) => c.cmd === "set_autostart").length,
      rules: document.querySelectorAll("#ai-rule-list .rule-row").length,
      replacements: document.querySelectorAll("#replacement-list .replacement-row").length,
      inert: document.getElementById("section-settings").inert,
      shown: [document.getElementById("mode-ptt").classList.contains("active"), document.getElementById("ai-edit-toggle").checked, document.getElementById("swiss-toggle").checked, document.getElementById("autostart-toggle").checked, document.getElementById("history-mode-select").value].join(),
    }));
    out.push(...expect(rests.asked && rests.inert && rests.loaded === "" && still === "", `Settings > ${tab}: the check pressed while the settings were still on their way (the pages rest until then)`, JSON.stringify({ rests, still })));
    out.push(
      ...expect(
        after.saves === 0 && after.autostart === 0 && (await savedNow(page)) === before && after.rules === 3 && after.replacements === 3 && !after.inert && after.shown === "true,true,true,true,audio",
        `Settings > ${tab}: ${controls.join(" and ")} pressed during the load window change nothing, and every control shows its setting afterwards`,
        JSON.stringify(after),
      ),
    );
  }
  // The moment the settings are read every control shows them: nothing is waited for between the answer
  // and the last control. A click right then is a real one, and saves that one value and nothing else.
  await settings(page, "dictation");
  await lateStart(page, LATE);
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(page, () => document.body.dataset.loaded === "true", 5000);
  const filled = await page.evaluate(() => ({
    started: document.body.dataset.started ?? "",
    mic: document.getElementById("mic-select").value,
    model: document.getElementById("model-select").value,
    replacements: document.querySelectorAll("#replacement-list .replacement-row").length,
    rules: document.querySelectorAll("#ai-rule-list .rule-row").length,
    words: document.querySelectorAll("#dict-list .dict-row").length,
    send: document.getElementById("send-command-select").value,
    mute: document.getElementById("mute-audio-toggle").checked,
    game: document.getElementById("game-free-toggle").checked,
    idle: document.getElementById("idle-unload-select").value,
    key: document.getElementById("hotkey-text").textContent,
    inert: document.getElementById("section-settings").inert,
  }));
  out.push(
    ...expect(
      filled.started === "" && filled.mic === "default" && filled.model === "large-v3-turbo-q8_0" && filled.replacements === 3 && filled.rules === 3 && filled.words === 12 && filled.send === "enter" && filled.mute && filled.game && filled.idle === "30" && filled.key === "Ctrl+Shift+Space" && !filled.inert,
      "the moment the settings are read every control shows its saved value, while the start's later answers are still out",
      JSON.stringify(filled),
    ),
  );
  await mouseClick(page, "#mode-toggle");
  const early = await page.evaluate(() => document.body.dataset.started ?? "");
  await started(page);
  await wait(page, 200);
  const was = JSON.parse(before);
  const now = JSON.parse(await savedNow(page));
  const changed = Object.keys(was).filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
  out.push(...expect(early === "" && changed.join() === "recordingMode" && now.recordingMode === "toggle", "a click right after the settings are shown, before the start is over, saves that one setting and loses none (the microphone, the model, the replacements, the rules)", JSON.stringify({ early, changed, mic: now.microphone, model: now.whisperModel, replacements: now.replacements?.length, rules: now.aiRules?.length })));
  await lateStart(page, 0);
  await restart(page);
  return out;
}

// ── The start ──

/** Runs in the page: what the window shows now; null before the page's own script has run. */
function startFrame(others) {
  const title = document.getElementById("home-title");
  if (!title || !window.__MOCK__?.calls.some((c) => c.cmd === "get_settings")) return null;
  const shown = (id) => !!document.getElementById(id)?.checkVisibility();
  const set = new Set(others);
  const foreign = new Set();
  const seen = (text) => {
    const said = (text ?? "").trim();
    if (set.has(said)) foreign.add(said);
  };
  for (const el of document.querySelectorAll("#app *")) {
    if (!el.checkVisibility() && !(el instanceof HTMLOptionElement && el.selected && el.parentElement?.checkVisibility())) continue;
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) seen(node.textContent);
    for (const name of ["aria-label", "title", "placeholder"]) if (el.hasAttribute(name)) seen(el.getAttribute(name));
  }
  const pill = document.getElementById("status-indicator");
  return {
    loaded: document.body.dataset.loaded === "true",
    started: document.body.dataset.started === "true",
    lang: document.documentElement.lang,
    title: title.textContent,
    kind: pill.dataset.kind ?? "",
    status: document.getElementById("status-text").textContent,
    daily: shown("home-daily"),
    steps: shown("home-setup"),
    how: shown("home-how"),
    keys: [...document.querySelectorAll("#home-hotkeys kbd")].filter((k) => k.checkVisibility()).map((k) => k.textContent.trim()),
    inert: document.getElementById("section-home").inert,
    foreign: [...foreign],
  };
}

/**
 * Load the window again and note what Home shows about every 100 ms until the start is over. With `film`
 * (a path without its ending) each frame is also saved as a picture: UI_CHECK_FILM=<folder> for the run.
 */
async function startFrames(page, lang, film = "") {
  await page.reload({ waitUntil: "commit" });
  const frames = [];
  const from = Date.now();
  for (;;) {
    const frame = await page.evaluate(startFrame, otherLanguage(lang)).catch(() => null);
    if (frame) {
      frames.push({ at: Date.now() - from, ...frame });
      if (film) await page.screenshot({ path: `${film}-${String(frames.length).padStart(2, "0")}-${frames.at(-1).at}ms.png` });
    }
    if (frame?.started || Date.now() - from > 12_000) break;
    await page.waitForTimeout(100);
  }
  return frames;
}

/**
 * The start with a backend that takes 300 ms for every answer. Before, the window showed English text in
 * a German window, empty key boxes and an empty daily view (on a new PC the daily view first, then the
 * steps), and "Ready" before the AI's state was known; Home was wired after eight answers in a row.
 */
async function startSequence(page, run) {
  const out = [];
  const t = I18N[run.lang];
  const firstrun = run.scenario === "firstrun";
  const film = process.env.UI_CHECK_FILM ? path.join(process.env.UI_CHECK_FILM, `start-${run.scenario}-${run.lang}`) : "";
  await lateStart(page, 300);
  const frames = await startFrames(page, run.lang, film);
  const brief = (list) => JSON.stringify(list.map((f) => `${f.at}:${f.loaded ? "L" : "-"}${f.daily ? "D" : "-"}${f.steps ? "S" : "-"} ${f.kind || "?"} "${f.title}"`));
  const early = frames.filter((f) => !f.loaded);
  out.push(...expect(frames.length >= 4 && early.length >= 1 && frames.at(-1).started, "the start is watched from before the first answer to its end", brief(frames)));
  // The start's questions go out together: Home shows its view after one answer's time (it was wired after
  // the eighth answer in a row: 2.4 s here), and everything is drawn and wired after a few.
  const homeAt = frames.find((f) => f.daily || f.steps)?.at ?? 0;
  const done = frames.find((f) => f.started)?.at ?? 0;
  out.push(...expect(homeAt > 0 && homeAt < (film ? 1500 : 900) && done > 0 && done < (film ? 3500 : 2000), "with 300 ms for every answer Home shows its view after one answer's time, and the start is over within two seconds", `Home ${homeAt} ms, the start ${done} ms`));
  // One view, and never the other one first.
  const wrong = frames.filter((f) => (firstrun ? f.daily : f.steps) || (f.daily && f.steps));
  const settled = frames.findIndex((f) => f.daily || f.steps);
  const flips = settled >= 0 && frames.slice(settled).some((f) => f.daily !== frames[settled].daily || f.steps !== frames[settled].steps);
  out.push(...expect(wrong.length === 0 && settled >= 0 && !flips, firstrun ? "a new PC never sees the daily view: nothing, then the steps" : "a PC in daily use never sees the steps: nothing, then the daily view", brief(frames)));
  // Before Home knows which view it shows: the neutral heading, no sentence about a key that is not known yet, no empty key box.
  const blank = frames.filter((f) => !f.daily && !f.steps);
  out.push(...expect(blank.length >= 1 && blank.every((f) => f.title === t.home_title_loading && !f.how && f.keys.length === 0 && f.inert !== f.loaded), "until Home knows what it shows it has its neutral heading alone, and rests until the settings are read", JSON.stringify(blank.map((f) => [f.at, f.title, f.how, f.keys, f.inert, f.loaded]))));
  out.push(...expect(frames.every((f) => f.keys.every((key) => key !== "")), "no key box ever shows empty", JSON.stringify(frames.map((f) => f.keys))));
  // "Ready" only once it is true: never on a new PC, and on a PC in daily use never taken back.
  const ready = (f) => f.kind === "ready" || f.title === t.home_title_ready;
  const firstReady = frames.findIndex(ready);
  const takenBack = firstReady >= 0 && frames.slice(firstReady).some((f) => f.kind !== "ready");
  const headed = frames.filter((f) => f.title === t.home_title_ready && !(f.daily && f.loaded));
  out.push(...expect(firstrun ? firstReady < 0 : firstReady >= 0 && !takenBack && headed.length === 0 && frames.at(-1).kind === "ready", firstrun ? "a new PC is never called ready" : "Ready is said once it is true and never taken back, and Home says it only with its daily view", brief(frames)));
  // The language: the window's from its first moment, and nothing of the other one once the settings are read.
  const mixed = frames.filter((f) => f.lang !== run.lang || f.foreign.length > 0);
  out.push(...expect(mixed.length === 0, `no text of the other language in a ${run.lang === "de" ? "German" : "English"} window at any moment of the start`, JSON.stringify(mixed.map((f) => [f.at, f.lang, f.foreign.slice(0, 5)]))));
  if (run.lang === "en" && !firstrun) {
    // The Display Language is not Windows' own (English Windows, German chosen): German from the first answer
    // on, and at the next start from the first moment (the window remembers the language it was shown in).
    await page.evaluate(() => {
      window.__MOCK__.keep({ settings: { uiLanguage: "de" } });
      localStorage.removeItem("rudariflow-ui");
    });
    const first = await startFrames(page, "de");
    const late = first.filter((f) => f.loaded && (f.lang !== "de" || f.foreign.length > 0));
    out.push(...expect(first.some((f) => f.loaded) && late.length === 0, "a Display Language that is not Windows' own shows from the first answer on, with no English text left", JSON.stringify(late.map((f) => [f.at, f.lang, f.foreign.slice(0, 5)]))));
    const second = await startFrames(page, "de");
    const any = second.filter((f) => f.lang !== "de" || f.foreign.length > 0);
    out.push(...expect(second.length >= 4 && any.length === 0, "at the next start the window is in its Display Language from the first moment", JSON.stringify(any.map((f) => [f.at, f.lang, f.foreign.slice(0, 5)]))));
    await page.evaluate(() => window.__MOCK__.keep({ settings: null }));
  }
  // A form has its handler from the start: Enter in "Add a word" adds the word and does not load the page again.
  if (run.lang === "en" && !firstrun) {
    await lateStart(page, 0);
    await restart(page);
    await section(page, "home");
    await page.evaluate(() => (window.__sameLoad = true));
    await page.fill("#home-word-input", "Winterthur");
    await page.press("#home-word-input", "Enter");
    await wait(page, 200);
    const added = await page.evaluate(() => [window.__sameLoad === true, window.__MOCK__.settings().customPrompt.endsWith(", Winterthur")]);
    out.push(...expect(added[0] && added[1], "Enter in Add a word adds the word and does not load the page again", JSON.stringify(added)));
  }
  await lateStart(page, 0);
  await restart(page);
  return out;
}

// ── A save the backend refuses ──

/**
 * Where the page's notice lies: at the bottom of the content area, on the pages' left edge. It covers no way
 * through the window: no tab of Settings and no page's head (under the title's row it lay over all five tabs,
 * which could not be clicked until it was closed, and over Home's "Hold … and speak"). And with the page
 * scrolled to its end nothing of the page is under it: the page leaves the notice's height free there.
 */
async function noticePlace(page) {
  const out = [];
  const look = (what) =>
    page.evaluate((what) => {
      const content = document.getElementById("content");
      const section = document.querySelector(".content-section.active");
      const notice = document.getElementById("save-notice").getBoundingClientRect();
      const under = (el) => {
        const r = el.getBoundingClientRect();
        return el.checkVisibility() && r.width > 0 && r.height > 0 && r.bottom > notice.top && r.top < notice.bottom && r.right > notice.left && r.left < notice.right;
      };
      content.scrollTop = 0;
      const ways = [...document.querySelectorAll("#settings-tabs .tab, .content-section.active .section-header, .content-section.active .section-header *, #sidebar .nav-item")].filter(under).length;
      // A tab can be clicked: what is at its middle is the tab.
      const tabs = [...document.querySelectorAll("#settings-tabs .tab")].filter((tab) => tab.checkVisibility());
      const reached = tabs.filter((tab) => {
        const r = tab.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === tab;
      }).length;
      // The page scrolled to its end: the lowest thing that is drawn on it.
      content.scrollTop = content.scrollHeight;
      let low = 0;
      for (const el of section.querySelectorAll("*")) {
        if (!el.checkVisibility() || el.closest(".sr-only, .mt-sr-only, option")) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) low = Math.max(low, r.bottom);
      }
      const now = { what, shown: document.getElementById("save-notice").checkVisibility(), left: Math.round(notice.left), pageLeft: Math.round(section.getBoundingClientRect().left + parseFloat(getComputedStyle(section).paddingLeft)), below: Math.round(window.innerHeight - notice.bottom), top: Math.round(notice.top), ways, tabs: tabs.length, reached, low: Math.round(low), close: document.elementFromPoint(notice.right - 20, notice.top + 20)?.closest("button")?.id ?? "" };
      content.scrollTop = 0;
      return now;
    }, what);
  const places = [["Settings", null], ["Home", "home"]];
  for (const [what, name] of places) {
    if (name) await section(page, name);
    const see = await look(what);
    out.push(...expect(see.shown && see.left === see.pageLeft && see.below === 24 && see.close === "save-notice-close", `${what}: the notice lies at the bottom of the content area, on the page's left edge, with its button to close it`, JSON.stringify(see)));
    out.push(...expect(see.ways === 0 && see.reached === see.tabs && (name || see.tabs === 5), `${what}: the notice covers no tab and nothing of the page's head`, JSON.stringify(see)));
    out.push(...expect(see.low <= see.top, `${what}: with the page scrolled to its end, its last row stands over the notice, not under it`, JSON.stringify(see)));
  }
  await settings(page, "dictation");
  return out;
}

/** The page's notice, the line that is read out, and what the mocked backend holds. */
const noticeNow = (page) =>
  page.evaluate(() => ({
    shown: document.getElementById("save-notice").checkVisibility(),
    text: document.getElementById("save-notice-text").textContent,
    said: document.getElementById("save-live").textContent,
    tone: document.getElementById("save-notice").dataset.tone,
    live: document.getElementById("save-live").getAttribute("role"),
  }));

const DENIED = "Access is denied. (os error 5)";

/** The next save is refused, in the backend's words. */
const refuseSave = (page) => page.evaluate((why) => window.__MOCK__.refuseNext("save_settings", why), DENIED);

/**
 * A save that is refused says so in the page, and the control is back on what is saved. Before, the
 * control went on showing the new value, nothing was said, and the console had an unhandled rejection.
 */
async function saveFails(page) {
  const out = [];
  const before = await savedNow(page);
  // The page's state: "Toggle" was pressed and refused (see the page's `open`).
  let see = await noticeNow(page);
  const mode = await page.evaluate(() => [document.getElementById("mode-ptt").getAttribute("aria-pressed"), document.getElementById("mode-toggle").getAttribute("aria-pressed")]);
  out.push(...expect(see.shown && see.text === `Could not save: ${DENIED}` && see.said === see.text && see.tone === "error" && see.live === "status", "a refused save is said in the page's notice, with the backend's reason, and read out", JSON.stringify(see)));
  out.push(...expect(mode.join() === "true,false" && (await savedNow(page)) === before, "the segmented choice is back on the saved value", JSON.stringify(mode)));
  // Its button closes it; the focus goes to the page's heading.
  await page.focus("#save-notice-close");
  await page.keyboard.press("Enter");
  await wait(page, 100);
  see = await noticeNow(page);
  const at = await page.evaluate(() => document.activeElement?.className ?? "");
  out.push(...expect(!see.shown && see.said === "" && at.includes("section-title"), "the notice's button closes it, and the keyboard focus goes to the page's heading", JSON.stringify([see, at])));
  // Every kind of control: a select, a switch, a text field, a row's field, Home's quick switch, Files' own setting.
  const cases = [
    ["a select", "dictation", () => choose(page, "send-command-select", "off"), () => page.evaluate(() => document.getElementById("send-command-select").value), "enter"],
    ["a switch", "dictation", () => page.evaluate(() => document.getElementById("mute-audio-toggle").click()), () => page.evaluate(() => String(document.getElementById("mute-audio-toggle").checked)), "true"],
    ["a text field", "ai", () => page.evaluate(() => {
      const field = document.getElementById("ai-instructions");
      field.value = "Short.";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }), () => page.evaluate(() => document.getElementById("ai-instructions").value), "Always use du, never Sie. No emojis."],
    ["a rule's field", "ai", () => page.evaluate(() => {
      const field = document.querySelector("#ai-rule-list .rule-row .rule-app");
      field.value = "telegram";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }), () => page.evaluate(() => [...document.querySelectorAll("#ai-rule-list .rule-app")].map((f) => f.value).join()), "whatsapp,code,outlook"],
    ["a replacement's field", "dictionary", () => page.evaluate(() => {
      const field = document.querySelector("#replacement-list .replacement-row .replacement-to");
      field.value = "nobody@example.com";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }), () => page.evaluate(() => document.querySelector("#replacement-list .replacement-row .replacement-to").value), "info@0ggi.ch"],
    ["the AI cleanup switch", "ai", () => page.evaluate(() => document.getElementById("ai-toggle").click()), () => page.evaluate(() => [document.getElementById("ai-toggle").checked, document.getElementById("home-ai-toggle").checked].join()), "true,true"],
    ["Start with Windows", "general", () => page.evaluate(() => document.getElementById("autostart-toggle").click()), () => page.evaluate(() => `${document.getElementById("autostart-toggle").checked} ${window.__MOCK__.calls.filter((c) => c.cmd === "set_autostart").map((c) => c.args.enabled).join()}`), "true false,true"],
  ];
  for (const [what, tab, change, read, saved] of cases) {
    await settings(page, tab);
    await refuseSave(page);
    await change();
    await wait(page, 200);
    see = await noticeNow(page);
    const got = await read();
    out.push(...expect(see.shown && see.said === `Could not save: ${DENIED}` && got === saved && (await savedNow(page)) === before, `${what}: a refused save is said, and the control is back on the saved value`, JSON.stringify({ got, saved, notice: see.text })));
    await page.click("#save-notice-close");
  }
  // Files' Speakers, which is saved with the settings.
  await section(page, "files");
  await refuseSave(page);
  await choose(page, "file-speakers", "3");
  await wait(page, 200);
  see = await noticeNow(page);
  const speakers = await page.evaluate(() => document.getElementById("file-speakers").value);
  out.push(...expect(see.shown && speakers === "auto", "Files' Speakers: a refused save is said, and the list is back on the saved value", JSON.stringify([see.text, speakers])));
  // A word added on Home: it is not in the list, it stays in the field, and nothing says "Added".
  await section(page, "home");
  await refuseSave(page);
  await page.fill("#home-word-input", "Winterthur");
  await page.press("#home-word-input", "Enter");
  await wait(page, 200);
  see = await noticeNow(page);
  const word = await page.evaluate(() => [document.getElementById("home-word-input").value, document.getElementById("home-word-status").textContent, document.querySelectorAll("#dict-list .dict-row").length]);
  out.push(...expect(see.shown && word[0] === "Winterthur" && word[1] === "" && word[2] === 12, "a word that could not be saved stays in its field, and Home does not say that it was added", JSON.stringify(word)));
  // The next save that works ends the notice.
  await settings(page, "dictation");
  await page.click("#mode-toggle");
  await wait(page, 200);
  see = await noticeNow(page);
  out.push(...expect(!see.shown && see.said === "" && JSON.parse(await savedNow(page)).recordingMode === "toggle", "a save that works ends the notice", JSON.stringify(see)));
  await page.click("#mode-ptt");
  await wait(page, 200);
  // The Display Language: saved first; refused, the window is back in the saved language, and says so in it.
  await settings(page, "general");
  await refuseSave(page);
  await choose(page, "ui-language-select", "de");
  await wait(page, 300);
  see = await noticeNow(page);
  const language = await page.evaluate(() => [document.documentElement.lang, document.getElementById("ui-language-select").value, document.getElementById("tab-general").textContent, window.__MOCK__.settings().uiLanguage]);
  out.push(...expect(see.shown && see.text.startsWith("Could not save") && language.join() === "en,en,General,en", "a refused save of the Display Language puts the window back in the saved language", JSON.stringify([see.text, language])));
  await page.click("#save-notice-close");
  // Two saves in a row, the first refused: the second carries the first one's change too, so nothing is lost and nothing is said.
  await settings(page, "dictation");
  await page.evaluate(() => (window.__MOCK__.saveDelay = 150));
  await refuseSave(page);
  await page.evaluate(() => {
    document.getElementById("mute-audio-toggle").click();
    document.getElementById("send-command-select").value = "off";
    document.getElementById("send-command-select").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait(page, 500);
  see = await noticeNow(page);
  const both = JSON.parse(await savedNow(page));
  const shown = await page.evaluate(() => [document.getElementById("mute-audio-toggle").checked, document.getElementById("send-command-select").value]);
  out.push(...expect(!see.shown && both.muteAudio === false && both.sendCommand === "off" && shown.join() === "false,off", "a refused save that a later one makes good is not said: the later save carries both changes", JSON.stringify([see, both.muteAudio, both.sendCommand, shown])));
  await page.evaluate(() => (window.__MOCK__.saveDelay = 0));
  return out;
}

// ── A change of the Display Language ──

/**
 * The choice is saved before anything is drawn again (it was the tenth step, after four questions to the
 * backend), and what was written once in the old language is drawn again or emptied.
 */
async function languageChange(page) {
  const out = [];
  // What is on screen in English, written once: "Added …" on Home, an export's line, "Try it"'s time,
  // the Soundboard's notice, the PC check while it runs, and the detected graphics cards.
  await section(page, "home");
  await page.fill("#home-word-input", "Zeitgeist");
  await page.press("#home-word-input", "Enter");
  await wait(page, 200);
  await tryIt(page);
  await advanced(page, "dictionary");
  await page.evaluate(() => (window.__MOCK__.savePath = "C:\\Users\\Oggi\\Documents\\words.txt"));
  await page.click("#dict-export");
  await wait(page, 200);
  await section(page, "soundboard");
  await page.evaluate(() => window.__MOCK__.emit("tauri://drag-drop", { paths: ["C:\\notes.txt"], position: { x: 400, y: 300 } }));
  await wait(page, 300);
  await advanced(page, "models");
  await page.evaluate(() => window.__MOCK__.holdNext("pc_check"));
  await page.click("#pc-check-btn");
  await page.evaluate(() => window.__MOCK__.emit("pc-check-progress", [1, 4, ""]));
  await wait(page, 150);
  const texts = () =>
    page.evaluate(() => ({
      word: document.getElementById("home-word-status").textContent,
      io: document.getElementById("dict-io-status").textContent,
      tried: document.getElementById("ai-test-meta").textContent,
      board: document.querySelector("#sb-root .sb-notice")?.textContent ?? "",
      check: document.getElementById("pc-check-btn").textContent,
      checking: document.getElementById("pc-check-btn").disabled,
      gpus: document.getElementById("gpu-detected").textContent,
    }));
  const english = await texts();
  out.push(...expect(english.word.length > 5 && english.io.length > 5 && /412/.test(english.tried) && english.board.length > 5 && /2\/4/.test(english.check) && english.checking && english.gpus.startsWith("Detected"), "the texts that are written once are on screen before the language changes", JSON.stringify(english)));
  // A question of the redraw fails: the language is saved all the same.
  await awaitError(page, /drawing the Meetings page again failed|meeting_list/);
  await page.evaluate(() => window.__MOCK__.refuseNext("meeting_list", "it broke"));
  await settings(page, "general");
  const from = await page.evaluate(() => window.__MOCK__.calls.length);
  await choose(page, "ui-language-select", "de");
  await wait(page, 400);
  const sent = await page.evaluate((from) => window.__MOCK__.calls.slice(from).map((c) => c.cmd).filter((cmd) => !cmd.startsWith("plugin:")), from);
  const saved = await page.evaluate(() => [window.__MOCK__.settings().uiLanguage, document.documentElement.lang, document.getElementById("save-notice").checkVisibility()]);
  out.push(...expect(sent[0] === "save_settings" && saved.join() === "de,de,false", "the Display Language is saved first, before anything is asked or drawn again, and a failing redraw does not lose it", JSON.stringify([sent.slice(0, 6), saved])));
  // The redraw asks the backend nothing that it knows already: only the Meetings page reads its list.
  const asked = sent.filter((cmd) => cmd !== "save_settings" && cmd !== "meeting_list" && cmd !== "meeting_default_title");
  out.push(...expect(asked.length === 0, "the window is drawn in the new language from what it knows: nothing is asked again", JSON.stringify(asked)));
  const german = await texts();
  out.push(
    ...expect(
      german.word === "" && german.io === "" && /^Dauer: 412 ms$/.test(german.tried) && german.board === "" && /^Prüfe 2\/4/.test(german.check) && german.checking && german.gpus.startsWith("Erkannt"),
      "after a language change nothing keeps its old text: what is drawn from data is in the new language, what was said once is gone",
      JSON.stringify(german),
    ),
  );
  // Nothing in the whole window, shown or not, is still English. (The Meetings page's list, whose question
  // was refused above, is read again when the page is opened.)
  await section(page, "meetings");
  await settings(page, "general");
  const left = await page.evaluate(foreignTexts, [I18N.onlyEn, true]);
  out.push(...expect(left.length === 0, "no English text is left anywhere in the window after the change to German", JSON.stringify(left.slice(0, 12))));
  await logged(page);
  await page.evaluate(() => window.__MOCK__.release("pc_check"));
  await choose(page, "ui-language-select", "en");
  await wait(page, 300);
  const back = await page.evaluate(foreignTexts, [I18N.onlyDe, true]);
  out.push(...expect(back.length === 0, "and none is German after the change back", JSON.stringify(back.slice(0, 12))));
  return out;
}

// ── The speech models' list ──

/**
 * Every model with its one line behind the row's "More". Before, a description showed only for the chosen
 * model (Base and Medium had none), and choosing a model to read about it started its download.
 */
async function modelList(page, run) {
  const out = [];
  const t = I18N[run.lang];
  const firstrun = run.scenario === "firstrun";
  const see = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#model-more .model-list-item")];
    const select = document.getElementById("model-select");
    return {
      role: [document.getElementById("model-more").getAttribute("role"), items.every((item) => item.getAttribute("role") === "listitem")],
      names: items.map((item) => item.querySelector(".model-list-name").textContent),
      notes: items.map((item) => [...item.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join("")),
      marks: items.map((item) => item.querySelector(".model-list-mark")?.textContent ?? ""),
      options: [...select.options].map((o) => o.textContent),
      value: select.value,
      note: document.getElementById("model-note").textContent,
      more: [document.querySelector("#local-settings .hint-more").getAttribute("aria-expanded"), document.querySelector("#local-settings .hint-more").getAttribute("aria-label")],
      downloads: window.__MOCK__.calls.filter((c) => c.cmd === "download_model").length,
      saves: window.__MOCK__.calls.filter((c) => c.cmd === "save_settings").length,
      saved: window.__MOCK__.settings().whisperModel,
    };
  });
  const plain = (option) => option.replace(/ ✓$/, "").replace(` · ${t.model_recommended_short}`, "");
  out.push(...expect(see.role[0] === "list" && see.role[1] && see.names.length === 8 && see.names.join("|") === see.options.map(plain).join("|") && see.names.every((name) => / · \d/.test(name)), "More lists all eight speech models with name and size, in the dropdown's order", JSON.stringify([see.names, see.options])));
  out.push(...expect(see.notes.every((note) => note.length >= 15 && /\.$/.test(note)), "every model has its one-line description, Base and Medium too", JSON.stringify(see.notes)));
  // The mocked PC has an RTX 5080 with 16 GB: Large v3 Turbo q8 is the one for it.
  const marked = see.marks.map((mark, i) => (mark ? see.names[i] : "")).filter(Boolean);
  const suffixed = see.options.filter((option) => option.includes(` · ${t.model_recommended_short}`));
  out.push(...expect(marked.length === 1 && marked[0].startsWith("Large v3 Turbo q8 ·") && see.marks.includes(t.model_recommended_here) && suffixed.length === 1 && suffixed[0].startsWith("Large v3 Turbo q8 ·"), "the model recommended for this PC's graphics card is marked in the list and in the dropdown, and no other", JSON.stringify([marked, suffixed])));
  // Reading costs nothing: no download, no save, the dropdown where the settings have it.
  out.push(...expect(see.downloads === 0 && see.value === see.saved && see.more[0] === "true" && see.more[1] === t.hint_less_about.replace("{label}", t.model_label), "reading about the models starts no download and changes no setting", JSON.stringify([see.downloads, see.value, see.saved, see.more])));
  if (firstrun) {
    // A new PC: the dropdown stays on what the settings say, and the row says which model is recommended and why.
    out.push(...expect(see.value === "small" && see.saves === 0 && see.note.includes("NVIDIA GeForce RTX 5080") && /Large\sv3\sTurbo\sq8/.test(see.note), "on a new PC the dropdown keeps the settings' model, and the row says which one is recommended for the graphics card", JSON.stringify([see.value, see.saves, see.note])));
  } else {
    out.push(...expect(!see.note.includes("RTX"), "with the chosen model on disk the row's note is the model's own line", see.note));
  }
  return out;
}

// ── Smaller ones ──

/** Runs in the page: the levels of the headings that show, in the page's order. */
function headingLevels() {
  return [...document.querySelectorAll("#content :is(h1, h2, h3, h4, h5, h6)")].filter((h) => h.checkVisibility()).map((h) => Number(h.tagName[1]));
}

/** One h1 at the top, and no level left out below it. */
const outlineOk = (levels) => levels[0] === 1 && levels.filter((l) => l === 1).length === 1 && levels.every((l, i) => i === 0 || l <= levels[i - 1] + 1);

/** Every page's outline: its title is the h1, a card's heading an h2, what stands under that an h3. */
async function outlines(page) {
  const bad = [];
  const look = async (where) => {
    const levels = await page.evaluate(headingLevels);
    if (!outlineOk(levels)) bad.push(`${where}: ${levels.join(" ") || "no heading"}`);
  };
  for (const name of ["home", "files", "meetings", "soundboard"]) {
    await section(page, name);
    await look(name);
  }
  for (const tab of TABS) {
    // With its Advanced fold open, where the tab has one.
    await page.evaluate((tab) => document.querySelector(`details.fold[data-fold="${tab}"]`)?.setAttribute("open", ""), tab);
    await settings(page, tab);
    await look(`settings/${tab}`);
  }
  await section(page, "home");
  return expect(bad.length === 0, "every page has one h1, its title, and its headings leave no level out", bad.join("; "));
}

/** The way from the list to its two settings: the link under it, and with the history off the sentence itself. */
async function historyLinks(page) {
  const out = [];
  await section(page, "home");
  await page.click("#history-settings");
  await wait(page);
  let at = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
  out.push(...expect(at[0] === "history-mode-select" && at[1], "the link under the recent dictations leads to Keep history", JSON.stringify(at)));
  await choose(page, "history-mode-select", "off");
  await wait(page, 200);
  await section(page, "home");
  const off = await page.evaluate(() => {
    const empty = document.getElementById("history-empty");
    return [empty.checkVisibility(), empty.textContent, !!empty.querySelector(".link-btn"), document.getElementById("history-settings").checkVisibility()];
  });
  out.push(...expect(off[0] && off[2] && /Settings › General/.test(off[1]) && !off[3], "with the history off the sentence says where to turn it on, and is the one link there", JSON.stringify(off)));
  await page.click("#history-empty .link-btn");
  await wait(page);
  at = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
  out.push(...expect(at[0] === "history-mode-select" && at[1], "the sentence's link leads to Keep history", JSON.stringify(at)));
  await choose(page, "history-mode-select", "audio");
  await wait(page, 200);
  await section(page, "home");
  return out;
}

/**
 * The window crosses the 900 px step and the list is moved to its other place: whoever was in it keeps
 * the keyboard focus (a moved node loses it, and the next Tab started at the top of the page).
 */
async function focusOverStep(page) {
  const out = [];
  const size = page.viewportSize();
  const where = () =>
    page.evaluate(() => {
      const at = document.activeElement;
      return [at?.id || at?.closest(".history-item")?.dataset.id || at?.tagName, at instanceof HTMLInputElement ? `${at.selectionStart}-${at.selectionEnd}` : "", document.getElementById("home-recent").previousElementSibling?.id];
    });
  const cross = async (what) => {
    const before = await where();
    await page.setViewportSize({ width: 1000, height: size.height });
    await wait(page, 200);
    const narrow = await where();
    await page.setViewportSize(size);
    await wait(page, 200);
    const wide = await where();
    out.push(...expect(before[0] === narrow[0] && before[0] === wide[0] && before[1] === narrow[1] && before[1] === wide[1] && narrow[2] === "home-switches" && wide[2] === "home-controls", `${what} keeps the keyboard focus when the window crosses the 900 px step, both ways`, JSON.stringify([before, narrow, wide])));
  };
  await section(page, "home");
  await page.fill("#history-search", "olk");
  await page.evaluate(() => document.getElementById("history-search").setSelectionRange(1, 3));
  await cross("the search field, with its selection,");
  await page.fill("#history-search", "");
  await wait(page, 150);
  await page.focus('#history-list .history-item:nth-child(2) [data-action="copy"]');
  await cross("a dictation's Copy");
  await page.evaluate(() => document.activeElement?.blur?.());
  return out;
}

/**
 * A question of the start that never answers. The start's questions return plain values in the backend, so this
 * is a hang and nothing a healthy app does; still, one answer that never came left Home on "Getting ready…" for
 * ever (the settings), or on its heading alone (the microphones, the speech model's state, or the meetings'
 * state, which kept the other three answers of the status from being read). After five seconds the window goes
 * on with what it has: Home shows its daily view from what is known, a list of microphones that never came is
 * unknown and not "no microphone", the page's notice says what is the matter, and the sidebar never says "Ready"
 * while Home says "Getting ready…". An answer that comes later still lands, and with the last one the notice goes.
 */
async function startHangs(page) {
  const out = [];
  const SILENT = "Could not reach the app's backend. Restart RudariFlow.";
  const see = () =>
    page.evaluate(() => {
      const shown = (id) => document.getElementById(id).checkVisibility();
      const notice = document.getElementById("save-notice");
      return {
        title: document.getElementById("home-title").textContent,
        sidebar: document.getElementById("status-text").textContent,
        kind: document.getElementById("status-indicator").dataset.kind ?? "",
        daily: shown("home-daily"),
        steps: shown("home-setup"),
        notice: notice.checkVisibility() ? document.getElementById("save-notice-text").textContent : "",
        said: document.getElementById("save-live").textContent,
        mic: document.getElementById("home-loaded-mic").textContent,
        speech: document.getElementById("home-loaded-speech").textContent,
        inert: document.getElementById("section-home").inert,
        started: document.body.dataset.started === "true",
        home: document.getElementById("section-home").classList.contains("active"),
      };
    });
  // What Home and the sidebar must show five seconds after a start in which this question never answered.
  const cases = [
    // The microphones are unknown, not "none": a dictation works as far as anyone knows.
    ["list_microphones", (s) => s.daily && !s.steps && s.title === "Ready to dictate" && s.kind === "ready" && !/No microphone/.test(s.mic) && !s.inert],
    // Without the speech model's state nobody knows whether a dictation works: the daily view, and neither says Ready.
    ["speech_status", (s) => s.daily && !s.steps && s.title === "Getting ready…" && s.kind === "loading" && s.speech === "" && !s.inert],
    // The meetings' state is one of the status's four questions: the other three answers are read all the same.
    ["meeting_state", (s) => s.daily && !s.steps && s.title === "Ready to dictate" && s.kind === "ready" && s.speech !== "" && !s.inert],
    // Without the settings Home has nothing to show: its heading, and the sidebar does not say Ready beside it.
    ["get_settings", (s) => !s.daily && !s.steps && s.title === "Getting ready…" && s.kind !== "ready" && s.sidebar !== "Ready" && s.inert],
  ];
  await section(page, "home");
  for (const [cmd, goesOn] of cases) {
    await page.evaluate((cmd) => window.__MOCK__.keep({ hold: [cmd] }), cmd);
    await page.reload({ waitUntil: "load" });
    await wait(page, 1500);
    const early = await see();
    await wait(page, 4200);
    const late = await see();
    const held = await page.evaluate((cmd) => window.__MOCK__.calls.filter((c) => c.cmd === cmd).length, cmd);
    await page.evaluate((cmd) => window.__MOCK__.release(cmd), cmd);
    await until(page, () => document.body.dataset.started === "true", 3000);
    await wait(page, 250);
    const landed = await see();
    const detail = JSON.stringify({ early, late, landed });
    out.push(...expect(held === 1 && early.home && !early.started && early.title === "Getting ready…" && early.kind !== "ready" && early.notice === "" && !early.daily, `${cmd} never answers: within the first five seconds Home waits on its heading, the sidebar does not say Ready, and nothing is said yet`, detail));
    out.push(...expect(!late.started && goesOn(late) && late.notice === SILENT && late.said === SILENT, `${cmd} never answers: after five seconds the window goes on with what it has and says in the page's notice that the backend cannot be reached`, detail));
    out.push(...expect(!(late.title === "Getting ready…" && (late.kind === "ready" || late.sidebar === "Ready")), `${cmd} never answers: the sidebar never says Ready while Home says Getting ready`, detail));
    out.push(...expect(landed.started && landed.daily && !landed.steps && landed.title === "Ready to dictate" && landed.kind === "ready" && landed.notice === "" && landed.said === "" && /Fast Track/.test(landed.mic) && landed.speech !== "" && !landed.inert, `${cmd} answers late: the answer still lands, Home and the sidebar say Ready, and the notice goes`, detail));
  }
  await page.evaluate(() => window.__MOCK__.keep({ hold: null }));
  return out;
}

/** User text with "$&" in it is text: as a plain replacement string it was a pattern, and "$&" came out as the placeholder itself. */
async function dollarText(page) {
  const out = [];
  const odd = "$& $1 $$";
  // A rule's app, in the sentence under "Write in".
  await settings(page, "ai");
  await page.evaluate((odd) => {
    const app = document.querySelector("#ai-rule-list .rule-row:nth-child(2) .rule-app");
    app.value = odd;
    app.dispatchEvent(new Event("change", { bubbles: true }));
  }, odd);
  await choose(page, "ai-output-select", "en");
  await wait(page, 200);
  const skip = await page.evaluate(() => document.getElementById("ai-output-skip").textContent);
  out.push(...expect(skip.includes(odd), "an app's name with $& in it stands as it is in the sentence under Write in", skip));
  // The backend's own words about a model that cannot be deleted.
  await awaitError(page, /delete "[^"]*" failed|command failed/);
  await advanced(page, "models");
  await page.evaluate((odd) => window.__MOCK__.refuseNext("delete_unused_model", odd), odd);
  const del = page.locator("#unused-model-list [data-delete-id]").first();
  await del.click();
  await wait(page, ANSWER);
  await del.click();
  await wait(page, 300);
  const why = await page.evaluate(() => document.querySelector("#unused-model-list .unused-model-error")?.textContent ?? "");
  await logged(page);
  out.push(...expect(why.includes(odd), "the backend's reason with $& in it stands as it is in the model's row", why));
  // A suggestion's "heard as".
  await page.evaluate((odd) => window.__MOCK__.emit("dictionary-suggestions", [{ word: "Shiggy", heard: odd, count: 2 }]), odd);
  await settings(page, "dictionary");
  const heard = await page.evaluate(() => document.querySelector("#dict-suggest-list .list-secondary")?.textContent ?? "");
  out.push(...expect(heard.includes(odd), "what was heard, with $& in it, stands as it is in the suggestion", heard));
  return out;
}

/** An older answer that lands after a newer one is not drawn: the recent dictations, and the AI's state. */
async function olderAnswers(page) {
  const out = [];
  await section(page, "home");
  // The list is asked for; before its answer is back a dictation is deleted and the list is asked for again.
  const second = await page.evaluate(() => Number(document.querySelectorAll("#history-list .history-item")[1].dataset.id));
  await page.evaluate(async (id) => {
    window.__MOCK__.lateNext("history_list", 400);
    window.__MOCK__.emit("history-updated");
    await window.__TAURI_INTERNALS__.invoke("history_delete", { id });
    window.__MOCK__.emit("history-updated");
  }, second);
  await wait(page, 700);
  const rows = await page.evaluate(() => [...document.querySelectorAll("#history-list .history-item")].map((row) => Number(row.dataset.id)));
  out.push(...expect(rows.length === 7 && !rows.includes(second), "the older answer about the history, arriving last, does not bring a deleted dictation back", JSON.stringify([rows.length, rows.includes(second)])));
  // The AI's state: "ready" is on its way while the backend already says "loading".
  await settings(page, "ai");
  await page.evaluate(() => {
    window.__MOCK__.lateNext("ai_status", 400);
    window.__MOCK__.emit("ai-status");
    window.__MOCK__.ai = { server: { state: "loading" } };
    window.__MOCK__.emit("ai-status");
  });
  await wait(page, 700);
  const line = await page.evaluate(() => [document.getElementById("ai-status-line").textContent, document.getElementById("status-indicator").dataset.kind]);
  out.push(...expect(/^Loading/.test(line[0]) && line[1] === "loading", "the older answer about the AI, arriving last, does not put Ready back over Loading", JSON.stringify(line)));
  await page.evaluate(() => {
    window.__MOCK__.ai = null;
    window.__MOCK__.emit("ai-status");
  });
  await wait(page, 200);
  return out;
}

/**
 * The window is loaded again while the AI model downloads: the backend goes on, and says so. The model's
 * row, the line beside the switch and the sidebar follow the same word (before, the sidebar followed only a
 * download this window had started, and said "Ready" beside "Downloading the model…").
 */
async function downloadAfterReload(page) {
  const out = [];
  await page.evaluate(() => window.__MOCK__.keep({ ai: { downloading: "gemma-4-e4b" } }));
  await restart(page);
  await advanced(page, "ai");
  const now = () =>
    page.evaluate(() => ({
      line: document.getElementById("ai-status-line").textContent,
      percent: document.getElementById("ai-status-percent").textContent,
      bar: document.getElementById("ai-download-progress").checkVisibility(),
      numbers: document.getElementById("ai-progress-text").textContent,
      kind: document.getElementById("status-indicator").dataset.kind,
      status: document.getElementById("status-text").textContent,
      select: document.getElementById("ai-model-select").disabled,
    }));
  let see = await now();
  out.push(...expect(/^Downloading/.test(see.line) && see.bar && see.numbers === "0 %" && see.kind === "downloading" && see.select, "after a reload during the AI model's download the row, the state line and the sidebar all say that it downloads", JSON.stringify(see)));
  await page.evaluate(() => window.__MOCK__.emit("ai-download-progress", { downloaded: 2.14e9, total: 4977171584, percent: 43.2 }));
  await wait(page, 150);
  see = await now();
  out.push(...expect(see.percent === "43 %" && / 43 %$/.test(see.status) && /^43 %/.test(see.numbers), "its progress shows in all three", JSON.stringify(see)));
  // It ends: the backend says so, and all three are done with it.
  await page.evaluate(() => {
    window.__MOCK__.keep({ ai: null });
    window.__MOCK__.ai = null;
    window.__MOCK__.emit("ai-status");
  });
  await wait(page, 250);
  // A progress event that arrives late brings nothing back.
  await page.evaluate(() => window.__MOCK__.emit("ai-download-progress", { downloaded: 4.9e9, total: 4977171584, percent: 99 }));
  await wait(page, 150);
  see = await now();
  out.push(...expect(!/^Downloading/.test(see.line) && !see.bar && see.kind === "ready" && see.percent === "" && !see.select, "when the backend says the download is over all three are done with it, and a late progress event brings nothing back", JSON.stringify(see)));
  return out;
}

/** What wave 1 fixed that has no page of its own: one probe, in one window. */
async function wave1(page) {
  return [...(await outlines(page)), ...(await historyLinks(page)), ...(await focusOverStep(page)), ...(await dollarText(page)), ...(await olderAnswers(page)), ...(await downloadAfterReload(page))];
}

// ── Windows contrast themes ──

/**
 * `forced-colors: active`: Windows paints with the theme's few colours, and every colour of the app's own
 * is gone. Before there was no rule for it: a switch could not be seen unless it had the focus, and no
 * selected state showed. What is asserted here is the least: a switch has an edge and its two states
 * differ, and what is selected differs from what is not. The pictures are for the eye.
 */
async function forcedColors(page) {
  const out = [];
  const forced = await page.evaluate(() => matchMedia("(forced-colors: active)").matches);
  out.push(...expect(forced, "the window is in a contrast theme (forced colours)"));
  const style = (selector, pseudo, props) =>
    page.evaluate(
      ([selector, pseudo, props]) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const cs = getComputedStyle(el, pseudo || undefined);
        return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
      },
      [selector, pseudo, props],
    );
  const EDGE = ["border-top-width", "border-top-style", "border-top-color", "background-color"];
  const differs = (a, b, props) => !!a && !!b && props.some((p) => a[p] !== b[p]);
  const edged = (s) => !!s && parseFloat(s["border-top-width"]) >= 1 && s["border-top-style"] !== "none" && s["border-top-color"] !== s["background-color"];
  // Home: the AI cleanup switch, on and off.
  await section(page, "home");
  const on = await style("#home-ai-toggle + .switch-slider", "", EDGE);
  const thumbOn = await style("#home-ai-toggle + .switch-slider", "::before", ["background-color"]);
  await page.evaluate(() => document.getElementById("ai-toggle").click());
  await wait(page, 200);
  const off = await style("#home-ai-toggle + .switch-slider", "", EDGE);
  const thumbOff = await style("#home-ai-toggle + .switch-slider", "::before", ["background-color"]);
  await page.evaluate(() => document.getElementById("ai-toggle").click());
  await wait(page, 200);
  out.push(...expect(edged(off) && !!on && parseFloat(on["border-top-width"]) >= 1 && differs(on, off, ["background-color"]) && thumbOff["background-color"] !== off["background-color"] && thumbOn["background-color"] !== on["background-color"], "a switch has a visible edge and thumb, and on differs from off", JSON.stringify({ on, off, thumbOn, thumbOff })));
  // The sidebar's current page.
  const current = await style('.nav-item[aria-current="page"]', "", ["background-color", "color", "border-top-color"]);
  const other = await style(".nav-item:not([aria-current])", "", ["background-color", "color", "border-top-color"]);
  out.push(...expect(differs(current, other, ["background-color"]), "the sidebar's current page differs from the others", JSON.stringify({ current, other })));
  // Settings: the selected tab, and a segmented choice.
  await settings(page, "dictation");
  const tabOn = await style('.tab[aria-selected="true"]', "::after", ["background-color", "height"]);
  const tabOnEdge = await style('.tab[aria-selected="true"]', "", ["border-bottom-color"]);
  const tabOff = await style('.tab[aria-selected="false"]', "", ["border-bottom-color", "background-color"]);
  out.push(...expect(!!tabOn && parseFloat(tabOn.height) >= 2 && tabOn["background-color"] !== tabOff["background-color"] && tabOnEdge["border-bottom-color"] !== tabOff["border-bottom-color"], "the selected tab has a mark the others lack", JSON.stringify({ tabOn, tabOnEdge, tabOff })));
  const chosen = await style('.toggle-btn[aria-pressed="true"]', "", ["background-color", "color"]);
  const unchosen = await style('.toggle-btn[aria-pressed="false"]', "", ["background-color", "color"]);
  out.push(...expect(differs(chosen, unchosen, ["background-color"]) && chosen.color !== chosen["background-color"], "the chosen half of a segmented choice differs from the other", JSON.stringify({ chosen, unchosen })));
  // A card is an area with an edge.
  const card = await style("#panel-dictation .card", "", EDGE);
  out.push(...expect(edged(card), "a card has an edge (its own ground is gone)", JSON.stringify(card)));
  // The Soundboard: a tile has an edge, loop on differs from loop off, and the chosen chip from the others.
  await section(page, "soundboard");
  await wait(page, 200);
  const tile = await style("#sb-root .sb-row", "", EDGE);
  const loopOn = await style('#sb-root .sb-loop[aria-pressed="true"]', "", ["background-color", "color"]);
  const loopOff = await style('#sb-root .sb-loop[aria-pressed="false"]', "", ["background-color", "color"]);
  const chipOn = await style('#sb-root .sb-chip[aria-pressed="true"]', "", ["background-color", "color"]);
  const chipOff = await style('#sb-root .sb-chip[aria-pressed="false"]', "", ["background-color", "color"]);
  out.push(...expect(edged(tile) && differs(loopOn, loopOff, ["background-color"]) && differs(chipOn, chipOff, ["background-color"]), "a sound's tile has an edge, and loop on and the chosen chip differ from the others", JSON.stringify({ tile, loopOn, loopOff, chipOn, chipOff })));
  await section(page, "home");
  return out;
}

// ── The pill ──
// A window of its own, 320 × 64 px, transparent over whatever is on the desktop, with a small style sheet of
// its own. Until the review of Task 8 its pages were pictures only: it has none of the window's tokens, the
// ground behind it is not known (mid-grey stands in for the desktop here), and it never has the keyboard
// focus (it opens unfocused over the app the user dictates into, and is used with the mouse). What can be
// measured is measured now: nothing leaves the window or the pill, no text is cut (the dictated words are the
// user's: while Whisper sends them the pill keeps their end in view and lets their beginning go, and while the AI
// works on them they end in an ellipsis), the cancel button has a name and its 24 px, the contrast on the
// stand-in ground, and what moves. Not the keyboard walk. Every pill page says what its state looks like (`shows`).
const pill = (id, script, shows, probe) => ({
  id: `pill-${id}`,
  state: true,
  shows,
  url: "/src/overlay.html",
  scope: "body",
  scenarios: ["populated"],
  sizes: ["320x64"],
  walk: false,
  fresh: true,
  open: async (page) => {
    // The real window is transparent over the desktop; mid-grey stands in for it.
    await page.addStyleTag({ content: "html{background:#5a5f66 !important}" });
    await page.evaluate(script);
    await wait(page);
  },
  probe,
});

/** The pill is in `state`, in Edit mode or not, and the element `text` (an id) says something. */
const pillShows = (what, state, text, edit = false) =>
  onScreen(
    `the pill ${what}`,
    ([state, text, edit]) => {
      const now = { state: document.body.dataset.state, edit: document.body.dataset.edit === "1", text: text ? document.getElementById(text).textContent.trim() : "(not asked)" };
      return (now.state === state && now.edit === edit && now.text.length > 0) || now;
    },
    [state, text, edit],
  );

/** The pill polishes: the label of what the AI does, and the text. */
const pillPolishes = (what, edit) =>
  onScreen(
    `the pill ${what}`,
    (edit) => {
      const now = { state: document.body.dataset.state, edit: document.body.dataset.edit === "1", label: document.getElementById("transcript").dataset.phase ?? "", text: document.getElementById("transcript-text").textContent.length };
      return (now.state === "polishing" && now.edit === edit && now.label.length > 3 && now.text > 10) || now;
    },
    edit,
  );

/** The pill's text is one line and stands inside the pill from top to bottom, however long it is. */
async function pillOneLine(page) {
  const see = await page.evaluate(() => {
    const text = document.getElementById("transcript-text");
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const box = document.getElementById("transcript").getBoundingClientRect();
    return { characters: text.textContent.length, lines: new Set(rects.map((r) => Math.round(r.top))).size, inside: rects.every((r) => r.top >= box.top && r.bottom <= box.bottom) };
  });
  return expect(see.characters > 0 && see.lines === 1 && see.inside, "the pill's text is one line, inside the pill", JSON.stringify(see));
}

/** The font of the window and the pill, as the browser reads the token (src/styles/tokens.css, --font). */
const SYSTEM_FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

/**
 * The pill keeps its outline from state to state: the ground of a text state (the transcript, a notice) is the
 * pill's own box, 304 by 48 px with the same round ends, not the whole window of 320 by 64 px. And it writes in
 * the window's font, which is Windows' own: no font file is loaded, so no chip or label stands in another face
 * first and changes its width when a file comes (as the heavier weight of the bundled font once did).
 */
async function pillOutline(page, ground) {
  const see = await page.evaluate((ground) => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10).join();
    };
    const pill = document.getElementById("pill");
    const text = document.getElementById(ground);
    return { pill: box(pill), ground: box(text), ends: [getComputedStyle(pill).borderRadius, getComputedStyle(text).borderRadius], shown: getComputedStyle(text).opacity, font: getComputedStyle(text).fontFamily, files: document.fonts.size };
  }, ground);
  return [
    ...expect(see.pill === "8,8,304,48" && see.ground === see.pill && see.ends[0] === see.ends[1] && see.shown === "1", "the ground of the pill's text states is the pill's own shape and size: its outline does not change between states", JSON.stringify(see)),
    ...expect(see.font === SYSTEM_FONT && see.files === 0, "the pill writes in Windows' own Segoe UI and loads no font file", JSON.stringify([see.font, see.files])),
  ];
}

/** What Whisper sends for a dictation of three sentences: a segment each, one after the other (whisper_engine.rs, the segment callback). */
const SEGMENTS = {
  en: ["Could you send me the quote for the move by tomorrow noon?", "I need it for the meeting with Mr Keller on Thursday.", "And please add the price of the storage room."],
  de: ["Kannst du mir bitte bis morgen Mittag die Offerte für den Umzug schicken?", "Ich brauche sie für die Besprechung mit Herrn Keller am Donnerstag.", "Und schreib bitte den Preis für den Lagerraum dazu."],
};
/** The pill's text fades out over this many px at its left end (src/overlay.html, .transcript-line). */
const PILL_FADE = 16;

/**
 * The pill is what the user watches while dictating, and what matters there is the end of the text: after every
 * segment the last word that was said is inside the pill, whole and past the fade at the left, on one line. A
 * text that fits stands in the middle. Until the re-review of Task 8 the text was one line that ended in an
 * ellipsis: it showed its first 45 characters and then never changed again, however long the dictation went on.
 */
async function pillSegments(page) {
  const out = [];
  const lang = await page.evaluate(() => window.__MOCK_CFG__.lang);
  const say = async (text) => {
    await emit(page, "partial-transcript", { text, is_final: false });
    await wait(page, 60);
  };
  const see = () =>
    page.evaluate(() => {
      const text = document.getElementById("transcript-text");
      const node = text.firstChild;
      const whole = document.createRange();
      whole.selectNodeContents(text);
      const all = whole.getBoundingClientRect();
      const at = node ? node.textContent.search(/\S+$/) : -1;
      const last = document.createRange();
      if (at >= 0) {
        last.setStart(node, at);
        last.setEnd(node, node.textContent.length);
      }
      const word = last.getBoundingClientRect();
      // Where the text can be seen: its line's box, inside the pill's own and the window.
      const pill = document.getElementById("transcript").getBoundingClientRect();
      const line = text.parentElement.getBoundingClientRect();
      return {
        text: text.textContent,
        word: at >= 0 ? node.textContent.slice(at) : "",
        wordAt: [Math.round(word.left), Math.round(word.right)],
        textAt: [Math.round(all.left), Math.round(all.right)],
        box: [Math.round(Math.max(pill.left, line.left, 0)), Math.round(Math.min(pill.right, line.right, window.innerWidth))],
        lines: new Set([...whole.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size,
        offCentre: Math.round((all.left + all.right) / 2 - window.innerWidth / 2),
        shown: getComputedStyle(document.getElementById("transcript")).opacity,
      };
    });
  await wait(page, 200); // the pill's text has faded in
  // A short text: whole, in the middle.
  await say(lang === "de" ? "Ja, passt." : "Yes, that works.");
  let now = await see();
  out.push(...expect(now.shown === "1" && now.lines === 1 && Math.abs(now.offCentre) <= 1 && now.textAt[0] >= now.box[0] + PILL_FADE && now.textAt[1] <= now.box[1], "a short text stands whole in the middle of the pill", JSON.stringify(now)));
  // A new dictation of three sentences.
  await page.evaluate(() => {
    window.__overlayUpdate("recording");
    window.__overlayUpdate("transcribing");
  });
  for (const [i, segment] of SEGMENTS[lang].entries()) {
    await say(segment);
    now = await see();
    out.push(
      ...expect(
        now.text.endsWith(segment) && now.word === segment.split(" ").at(-1) && now.lines === 1 && now.wordAt[0] >= now.box[0] + PILL_FADE && now.wordAt[1] <= now.box[1],
        `after segment ${i + 1} of 3 the pill shows the end of what was said: the last word is inside it, on its one line`,
        JSON.stringify(now),
      ),
    );
  }
  // The three together are longer than the pill, and what is cut is the beginning.
  out.push(...expect(now.textAt[1] - now.textAt[0] > now.box[1] - now.box[0] && now.textAt[0] < now.box[0], "a text longer than the pill loses its beginning, at the left", JSON.stringify(now)));
  return out;
}

/**
 * Edit mode: beside the chip the bars have less room than the 32 need, and each bar that shows is whole. A bar
 * cut to a sliver of 1 px stood at the left end at some chip widths ("128 Wörter"). Tried from one word to five
 * digits; the newest bar, the one at the right, always shows.
 */
async function wholeBars(page) {
  const bad = [];
  for (const words of [1, 12, 128, 1280, 12800]) {
    await emit(page, "edit-target", words);
    await wait(page, 40);
    const see = await page.evaluate(() => {
      const box = document.getElementById("waveform").getBoundingClientRect();
      const bars = [...document.querySelectorAll("#waveform .bar")];
      const seen = bars.map((bar) => bar.getBoundingClientRect()).filter((r) => r.top < box.bottom && r.bottom > box.top && r.right > box.left && r.left < box.right);
      const newest = bars[0].getBoundingClientRect();
      return { chip: document.getElementById("edit-chip").textContent, bars: seen.length, cut: seen.filter((r) => r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.width < 1.9).length, newest: newest.top < box.bottom && Math.abs(newest.right - box.right) <= 0.5 };
    });
    if (!(see.bars >= 8 && see.cut === 0 && see.newest)) bad.push(JSON.stringify(see));
  }
  await emit(page, "edit-target", 128);
  await wait(page, 40);
  return expect(bad.length === 0, "beside the edit chip every bar that shows is whole, and the newest one shows", bad.join("; "));
}

/** The Dictionary tab: the searches, and the one way to delete. */
async function dictionaryProbe(page, run) {
  const out = [];
  if (await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun")) return out;
  const words = () => page.locator("#dict-list .dict-row").count();
  const saved = () => page.evaluate(() => window.__MOCK__.settings());
  const first = page.locator("#dict-list .dict-row [data-delete-id]").first();
  // In every view, what depends on the language and on the window's width.
  // The suggestions are in the Display Language too.
  const add = await page.evaluate(() => [document.documentElement.lang, document.querySelector("#dict-suggest-list button").textContent]);
  out.push(...expect(add[1] === (add[0] === "de" ? "Hinzufügen" : "Add"), "the suggestions follow the Display Language", JSON.stringify(add)));
  // The headings stand over their columns, whatever the width of Delete in this language.
  const cols = await page.evaluate(() => {
    const left = (el) => Math.round(el.getBoundingClientRect().left);
    const heads = [...document.querySelectorAll("#replacement-cols span")].map(left);
    const row = document.querySelector("#replacement-list .replacement-row");
    return [heads, [left(row.querySelector(".replacement-from")), left(row.querySelector(".replacement-to"))]];
  });
  out.push(...expect(cols[0].join() === cols[1].join(), "the replacements' headings stand over their columns", JSON.stringify(cols)));
  // The words read downwards, column after column, in the order of the page (the alphabet's, and Tab's); no word
  // is split over two columns; and the lines under the last words keep a distance from the card's edge.
  const flow = await page.evaluate(() => {
    const list = document.getElementById("dict-list");
    const rows = [...list.children].map((row) => row.getBoundingClientRect());
    const columns = [...new Set(rows.map((r) => Math.round(r.left)))];
    // In reading order: down a column, then the next column to the right, never back.
    const ordered = rows.every((r, i) => i === 0 || (Math.round(r.left) === Math.round(rows[i - 1].left) ? r.top >= rows[i - 1].bottom - 0.5 : r.left > rows[i - 1].left && r.top < rows[i - 1].top));
    const whole = [...list.children].every((row) => row.getClientRects().length === 1);
    const under = list.closest(".card").getBoundingClientRect().bottom - Math.max(...rows.map((r) => r.bottom));
    return { words: rows.length, columns: columns.length, ordered, whole, under: Math.round(under) };
  });
  out.push(...expect(flow.words === 12 && flow.columns > 1 && flow.ordered && flow.whole && flow.under >= 16, "the words read downwards in columns, with room under the last line", JSON.stringify(flow)));
  // From here on what the tab does, which depends neither on the window's size nor on the language: in one view.
  if (!(run.lang === "en" && run.size === BEHAVIOUR)) return out;
  // Nothing deletes on a single click; Esc disarms; the second click deletes.
  await first.click();
  out.push(...expect((await words()) === 12 && (await first.getAttribute("class")).includes("armed"), "the first click on Delete only arms it"));
  await page.keyboard.press("Escape");
  out.push(...expect(!(await first.getAttribute("class")).includes("armed"), "Esc disarms Delete"));
  await first.click();
  await page.click("#dict-input");
  out.push(...expect(!(await first.getAttribute("class")).includes("armed") && (await words()) === 12, "a click elsewhere disarms Delete"));
  await first.click();
  // Not at once: a second click right after the first is a double-click, which deletes nothing.
  await wait(page, ANSWER);
  await first.click();
  await wait(page, 150);
  out.push(...expect((await words()) === 11, "the second click deletes the word", String(await words())));
  // The word search ignores case and accents.
  await page.fill("#dict-search", "zurich");
  await wait(page, 100);
  out.push(...expect((await words()) === 1, "the word search finds Zürich for zurich", String(await words())));
  // The count says how many of the words show, and a search that finds nothing says so.
  const count = () => page.evaluate(() => [document.getElementById("dict-count").textContent, !document.getElementById("dict-no-match").classList.contains("hidden"), !document.getElementById("dict-empty").classList.contains("hidden")]);
  const found = await count();
  await page.fill("#dict-search", "qqq");
  await wait(page, 100);
  const none = await count();
  out.push(...expect(/^1 \D+ 11$/.test(found[0]) && !found[1] && /^0 \D+ 11$/.test(none[0]) && none[1] && !none[2] && (await words()) === 0, "the word count follows the search, and no match says so", JSON.stringify([found, none])));
  if (run.size === BEHAVIOUR) {
    // What a search found is said once the typing rests, for both lists.
    await page.fill("#dict-search", "o");
    await page.fill("#replacement-search", "qqq");
    await wait(page, 900);
    const said = await page.evaluate(() => [document.getElementById("dict-live").textContent, document.getElementById("replacement-live").textContent, document.getElementById("replacement-no-match").textContent]);
    const some = await words();
    out.push(...expect(some > 0 && some < 11 && new RegExp(`^${some} \\D+ 11 `).test(said[0]) && said[1] === said[2] && said[1] !== "", "a screen reader hears what the two searches found", JSON.stringify([some, ...said])));
    await page.fill("#replacement-search", "");
  }
  await page.fill("#dict-search", "");
  // The replacement search hides rows and loses none of them.
  await page.fill("#replacement-search", "signat");
  await wait(page, 100);
  const shown = await page.locator("#replacement-list .replacement-row:not(.hidden)").count();
  out.push(...expect(shown === 1, "the replacement search shows the rows it finds", String(shown)));
  await page.evaluate(() => {
    const to = document.querySelector("#replacement-list .replacement-row:not(.hidden) .replacement-to");
    to.value = "Best regards";
    to.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait(page, 150);
  out.push(...expect((await saved()).replacements.length === 3, "a save while searching keeps the hidden replacements", String((await saved()).replacements.length)));
  await page.fill("#replacement-search", "");
  const del = page.locator("#replacement-list .replacement-row [data-delete-id]").first();
  await del.click();
  out.push(...expect((await saved()).replacements.length === 3, "one click deletes no replacement"));
  await wait(page, ANSWER);
  await del.click();
  await wait(page, 150);
  out.push(...expect((await saved()).replacements.length === 2, "the second click deletes the replacement"));
  // A word added while the search is on would be hidden by it at once: the search ends, and the list shows the word.
  await page.fill("#dict-search", "zur");
  await wait(page, 100);
  await page.fill("#dict-input", "Winterthur");
  await page.press("#dict-input", "Enter");
  await wait(page, 200);
  const shownWords = () => page.evaluate(() => [document.getElementById("dict-search").value, [...document.querySelectorAll("#dict-list .dict-term")].filter((el) => el.getClientRects().length).map((el) => el.textContent)]);
  let added = await shownWords();
  out.push(...expect(added[0] === "" && added[1].length === 12 && added[1].includes("Winterthur"), "a word added while the search is on ends the search and shows", JSON.stringify(added)));
  // A word that is there already adds nothing: the search stays as it is.
  await page.fill("#dict-search", "zur");
  await page.fill("#dict-input", "winterthur");
  await page.press("#dict-input", "Enter");
  await wait(page, 200);
  added = await shownWords();
  out.push(...expect(added[0] === "zur" && added[1].join() === "Zürich", "an add that adds nothing leaves the search on", JSON.stringify(added)));
  await page.fill("#dict-search", "");
  // The same for a replacement: its new row would go as soon as the rows are looked at again.
  await page.fill("#replacement-search", "signat");
  await wait(page, 100);
  await page.click("#replacement-add");
  await wait(page, 150);
  const row = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#replacement-list .replacement-row")];
    return [document.getElementById("replacement-search").value, rows.length, rows.filter((r) => !r.classList.contains("hidden")).length, document.activeElement === rows.at(-1).querySelector(".replacement-from")];
  });
  out.push(...expect(row[0] === "" && row[1] === 3 && row[2] === 3 && row[3], "a replacement added while the search is on ends the search", JSON.stringify(row)));
  await page.reload({ waitUntil: "networkidle" });
  await wait(page, 500);
  await settings(page, "dictionary");
  return out;
}

export const PAGES = [
  {
    id: "shell",
    scope: "#sidebar",
    open: (page) => section(page, "home"),
    probe: async (page, run) => {
      const out = [];
      const read = () => page.evaluate(() => ({ text: document.getElementById("status-text").textContent, tone: document.getElementById("status-indicator").dataset.tone, kind: document.getElementById("status-indicator").dataset.kind, marker: !document.getElementById("status-marker").classList.contains("hidden") }));
      const firstrun = await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun");
      const start = await read();
      out.push(...expect(start.kind === (firstrun ? "setup" : "ready"), "the status at the start", JSON.stringify(start)));
      // Every page starts at the same left edge.
      const lefts = [];
      for (const name of ["home", "files", "meetings", "soundboard", "settings"]) {
        await section(page, name);
        lefts.push(await page.evaluate((s) => Math.round(document.querySelector(`#section-${s} .section-title`).getBoundingClientRect().left), name));
      }
      out.push(...expect(new Set(lefts).size === 1, "every page starts at the same left edge", JSON.stringify(lefts)));
      await section(page, "home");
      // From here on what the window does (its status, what it remembers), which depends neither on its
      // size nor on the language: in one view per data set.
      if (!(run.lang === "en" && run.size === BEHAVIOUR)) return out;
      if (firstrun) {
        // The first speech model downloads: the status shows its percent, and a
        // screen reader is told of the download once, not of every percent.
        await settings(page, "models");
        await page.evaluate(() => {
          const live = document.getElementById("status-live");
          window.__said = [];
          new MutationObserver((changes) => window.__said.push(...changes.map(() => live.textContent))).observe(live, { childList: true, characterData: true, subtree: true });
          document.getElementById("download-btn").click();
          for (let i = 0; i <= 200; i++) window.__MOCK__.emit("download-progress", { downloaded: i * 1e6, total: 465e6, percent: i * 0.215 });
        });
        await wait(page, 150);
        const fetching = { ...(await read()), said: await page.evaluate(() => window.__said) };
        out.push(...expect(fetching.kind === "downloading" && / 43 %$/.test(fetching.text) && fetching.said.length === 1, "the first model's download shows its percent and is announced once", JSON.stringify(fetching)));
        // The download never ends in the mock: a new start for the pages that follow.
        await again(page);
        return out;
      }
      // A dictation, then a meeting with a dictation on top: the marker.
      await page.evaluate(() => window.__MOCK__.emit("recording-state", "Recording"));
      await wait(page, 100);
      out.push(...expect((await read()).kind === "recording", "the status while recording", JSON.stringify(await read())));
      await page.evaluate(() => window.__MOCK__.emit("meeting-status", window.__MOCK__.meetingRecording()));
      await wait(page, 100);
      const both = await read();
      out.push(...expect(both.kind === "recording" && both.marker, "a meeting keeps a marker while a dictation shows", JSON.stringify(both)));
      await page.evaluate(() => window.__MOCK__.emit("recording-state", "Ready"));
      await wait(page, 100);
      out.push(...expect((await read()).kind === "meeting", "the status while a meeting records", JSON.stringify(await read())));
      await page.evaluate(() => window.__MOCK__.emit("meeting-status", { recording: null, finishing: [] }));
      await wait(page, 100);
      out.push(...expect((await read()).kind === "ready", "the status after the meeting", JSON.stringify(await read())));
      // The place is remembered: Settings > General, a new start, still there.
      await settings(page, "general");
      await restart(page);
      const place = await page.evaluate(() => ({ nav: document.querySelector('.nav-item[aria-current="page"]')?.dataset.section, tab: document.querySelector('#settings-tabs [aria-selected="true"]')?.dataset.tab, shown: !document.getElementById("panel-general").hidden }));
      out.push(...expect(place.nav === "settings" && place.tab === "general" && place.shown, "the section and the tab are remembered", JSON.stringify(place)));
      // A window that opens on a remembered place tells the page that it is shown.
      // Settings > AI cleanup asks for the open apps (the rule suggestions), once.
      await settings(page, "ai");
      await restart(page);
      // The page tells its tabs where the window starts once everything is wired: wait for the question, then a moment for a second one.
      await until(page, () => window.__MOCK__.calls.some((c) => c.cmd === "list_open_apps"));
      await wait(page, 250);
      const asked = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === "list_open_apps").length);
      out.push(...expect(asked === 1, "opened on Settings > AI cleanup, the open apps are asked for once", String(asked)));
      // The Soundboard takes a file that is dragged over the window.
      await section(page, "soundboard");
      await page.reload({ waitUntil: "networkidle" });
      await wait(page, 500);
      await page.evaluate(() => window.__MOCK__.emit("tauri://drag-enter", { paths: ["C:\\sound.wav"], position: { x: 400, y: 300 } }));
      await wait(page, 100);
      out.push(...expect(await page.evaluate(() => document.getElementById("sb-root").classList.contains("dragging")), "opened on the Soundboard, a dragged file is for the board"));
      await page.evaluate(() => window.__MOCK__.emit("tauri://drag-leave", {}));
      await section(page, "home");
      return out;
    },
  },
  {
    id: "home",
    // The two columns at their narrowest are measured too (German: "Schreiben in" beside its select), and the
    // most common large window, where the quick switches' card is at its narrowest again (377 px between its
    // paddings: "Gesprochene Sprache" stood over its select there while "Schreiben in" stood beside its own).
    alsoSizes: ["1200x800", "1920x1080"],
    open: (page) => section(page, "home"),
    probe: async (page, run) => {
      const out = [];
      const firstrun = await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun");
      const shown = (id) => page.evaluate((id) => !document.getElementById(id).classList.contains("hidden"), id);
      // What is loaded: a value is plain, a missing thing is tinted and named. The AI's state under its
      // switch shows only when there is something to say.
      const loaded = () =>
        page.evaluate(() => ({
          tones: ["speech", "ai", "mic"].map((id) => document.getElementById(`home-loaded-${id}`).dataset.tone || ""),
          ai: document.getElementById("home-loaded-ai").textContent,
          line: document.getElementById("home-ai-status").textContent,
          lineShown: !document.getElementById("home-ai-status").classList.contains("hidden"),
          retry: !document.getElementById("home-ai-retry").classList.contains("hidden"),
          missing: document.documentElement.lang === "de" ? "nicht heruntergeladen" : "not downloaded",
        }));
      const state = await loaded();
      if (firstrun) {
        out.push(...expect(state.tones.join() === "warn,warn," && state.ai.endsWith(state.missing), "what is not downloaded is tinted and says so, in both model lines", JSON.stringify(state)));
        out.push(...expect(state.lineShown && state.line.length > 10 && !state.retry, "AI cleanup says under its switch why it cannot be turned on", JSON.stringify(state)));
      } else {
        out.push(...expect(state.tones.join() === ",,", "what is loaded has no colour while nothing is missing", JSON.stringify(state)));
        out.push(...expect(!state.lineShown && state.line === "" && !state.retry, "AI cleanup shows no state line while it is simply ready", JSON.stringify(state)));
      }
      if (firstrun) return [...out, ...(await firstRun(page, run))];
      out.push(...expect((await shown("home-daily")) && !(await shown("home-setup")), "the daily view shows once the setup is done"));
      // No setup means no microphone held open, and no optional card when the AI model is there.
      const quiet = await page.evaluate(() => [window.__MOCK__.calls.some((c) => c.cmd === "mic_meter_start"), document.getElementById("home-ai-card").checkVisibility()]);
      out.push(...expect(!quiet[0] && !quiet[1], "the daily view opens no microphone and shows no setup card", JSON.stringify(quiet)));
      // One column: the recent dictations follow the quick switches; two columns: they are the right column.
      // The width with the scrollbar's room, as src/home.ts decides it.
      const wide = await page.evaluate(() => document.getElementById("content").offsetWidth >= 900);
      const before = await page.evaluate(() => document.getElementById("home-recent").previousElementSibling?.id);
      out.push(...expect(before === (wide ? "home-controls" : "home-switches"), "the recent dictations are where the layout wants them", `${wide ? "wide" : "narrow"}: after #${before}`));
      // A large window: both sides start on one top edge, and the list is the wider side.
      if (wide) {
        const sides = await page.evaluate(() => ["home-controls", "home-recent"].map((id) => document.getElementById(id).getBoundingClientRect()).map((r) => [Math.round(r.top), Math.round(r.width)]));
        out.push(...expect(sides[0][0] === sides[1][0] && sides[1][1] > sides[0][1], "the two sides start on one top edge and the list is the wider one", JSON.stringify(sides)));
      }
      // A dictation keeps the measure of running text only in the wide list (a card of 840 px or more), where it
      // stands beside its actions; in the narrower forms it has its row's width (capped there, it wrapped early
      // and made the page higher).
      const texts = await page.evaluate(() => {
        const list = document.getElementById("history-list");
        const card = document.getElementById("home-recent");
        const room = card.clientWidth - parseFloat(getComputedStyle(card).paddingLeft) - parseFloat(getComputedStyle(card).paddingRight);
        const widths = [...list.querySelectorAll(".history-text")].map((el) => [getComputedStyle(el).maxWidth, Math.round(el.getBoundingClientRect().width), Math.round(el.closest(".history-item").getBoundingClientRect().width)]);
        return { wideList: room >= 840, capped: widths.filter((w) => w[0] !== "none").length, short: widths.filter((w) => w[1] < w[2] - 1).length, rows: widths.length };
      });
      out.push(...expect(texts.rows > 0 && (texts.wideList ? texts.capped === texts.rows : texts.capped === 0 && texts.short === 0), "a dictation has its row's width, and the measure only in the wide list", JSON.stringify(texts)));
      // Every row is an item of the list, named after its text, and all rows have one shape.
      const rowsAre = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#history-list .history-item")];
        const beside = rows.map((row) => row.querySelector('[data-action="copy"]').getBoundingClientRect().top < row.querySelector(".history-parts").getBoundingClientRect().bottom - 1);
        return {
          list: document.getElementById("history-list").getAttribute("role"),
          named: rows.every((row) => row.getAttribute("role") === "listitem" && document.getElementById(row.getAttribute("aria-labelledby"))?.textContent === row.querySelector(".history-text").textContent),
          ids: new Set(rows.map((row) => row.getAttribute("aria-labelledby"))).size === rows.length,
          shapes: new Set(beside).size,
          beside: beside.every(Boolean),
          // App, time and length are one line that never breaks: no dot at a line's end, none at its start.
          parts: rows.every((row) => {
            const line = row.querySelector(".history-parts");
            const range = document.createRange();
            range.selectNodeContents(line);
            return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size === 1 && !/^\s*·|·\s*$/.test(line.textContent);
          }),
          // "01:55 · 6 s": a time of day and a length that cannot be read as each other; no model's id.
          metas: rows.map((row) => row.querySelector(".history-parts").textContent),
        };
      });
      out.push(...expect(rowsAre.list === "list" && rowsAre.named && rowsAre.ids, "every dictation is a list item named after its text", JSON.stringify(rowsAre)));
      out.push(...expect(rowsAre.shapes === 1 && rowsAre.beside, "every row has one shape, and Copy never has a line of its own: it stands beside the text or on the row's second line", JSON.stringify(rowsAre)));
      out.push(...expect(rowsAre.parts, "a row's second line is one line, with no dot at its end", JSON.stringify(rowsAre)));
      out.push(...expect(rowsAre.metas.every((m) => /\d\d:\d\d · (\d+ min( \d+ s)?|\d+ s)$/.test(m) && !/large|turbo|q8|ggml/i.test(m)), "a row's second line ends in the time and the length (\"01:55 · 6 s\") and names no model", JSON.stringify(rowsAre.metas)));
      // The quick switches' two choices have one form at every size: each select beside its name, which keeps
      // its one line, or both under their names; never one of them alone.
      const choices = await page.evaluate(() =>
        [...document.querySelectorAll("#home-switches .setting-row")]
          .filter((row) => row.querySelector("select"))
          .map((row) => {
            const range = document.createRange();
            range.selectNodeContents(row.querySelector(".label-text"));
            const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
            const label = range.getBoundingClientRect();
            const select = row.querySelector("select").getBoundingClientRect();
            const ends = row.getBoundingClientRect().right;
            return { name: row.querySelector(".label-text").textContent, beside: select.top < label.bottom && select.left >= label.right, under: select.top >= label.bottom, lines, select: Math.round(select.width), inRow: select.right <= ends + 0.5 && Math.abs(select.right - ends) <= 1 };
          }),
      );
      out.push(
        ...expect(
          choices.length === 2 && choices.every((c) => c.lines === 1 && c.inRow && c.select >= 180 && c.beside !== c.under) && new Set(choices.map((c) => c.beside)).size === 1,
          "the quick switches' two choices have one form: both selects beside their names or both under them, each name on one line and each select 180 px or more, ending at the card's edge",
          JSON.stringify(choices),
        ),
      );
      out.push(...(await rowActions(page, run)));
      // The smallest window: the list that is used every day starts on the first screen, with its first dictation.
      if (run.size === "900x600") {
        const first = await page.evaluate(() => {
          const rect = (el) => el.getBoundingClientRect();
          const row = document.querySelector("#history-list .history-item");
          const keys = [...document.querySelectorAll("#home-hotkeys .setting-row")].map((r) => [Math.round(rect(r).left), Math.round(rect(r).top)]);
          return { head: Math.round(rect(document.querySelector("#home-recent .list-title")).bottom), text: Math.round(rect(row.querySelector(".history-text")).bottom), meta: Math.round(rect(row.querySelector(".history-meta")).bottom), window: window.innerHeight, keys };
        });
        out.push(...expect(first.head < first.window && first.meta <= first.window, "at 900×600 the head of Recent dictations and the first dictation with its second line are on the first screen", JSON.stringify(first)));
        out.push(...expect(new Set(first.keys.map((k) => k[0])).size === 2 && new Set(first.keys.map((k) => k[1])).size === 2, "in one column the four keys stand two by two", JSON.stringify(first.keys)));
      }
      // So far how the page is laid out, in every view. From here on what it does, which depends neither on
      // the window's size nor on the language: in one view.
      if (!(run.lang === "en" && run.size === BEHAVIOUR)) return out;
      out.push(...(await loadFailed(page)));
      // A key that is not set is a key box that says so, in the words and the form Settings has for it (one
      // form for one thing); while it listens it is the accent box of any key.
      const unset = await page.evaluate(() => {
        const look = (id) => {
          const key = document.getElementById(id);
          const cs = getComputedStyle(key);
          return [key.textContent, cs.borderTopStyle, cs.backgroundColor, cs.color, cs.fontFamily].join(" | ");
        };
        return [look("home-free-gpu-text"), look("free-gpu-text"), document.getElementById("home-free-gpu-text").textContent, document.getElementById("home-free-gpu-btn").classList.contains("key-unset")];
      });
      out.push(...expect(unset[0] === unset[1] && unset[2] === "Not set" && unset[3] && !/transparent|, 0\)/.test(unset[0].split(" | ")[2]), "a key that is not set is a key box that says Not set, on Home as in Settings", JSON.stringify(unset)));
      await page.click("#home-free-gpu-btn");
      await wait(page, 80);
      const listening = await page.evaluate(() => {
        const cs = getComputedStyle(document.getElementById("home-free-gpu-text"));
        return [cs.borderTopColor, cs.backgroundColor];
      });
      out.push(...expect(!/, 0\)$|transparent/.test(listening[0]) && !/, 0\)$|transparent/.test(listening[1]), "an unset key that listens shows the accent box", JSON.stringify(listening)));
      await page.keyboard.press("Escape");
      await wait(page, 80);
      // A quick switch and its setting are one value.
      await page.click("#home-ai-toggle", { force: true });
      await wait(page, 150);
      let both = await page.evaluate(() => [document.getElementById("ai-toggle").checked, window.__MOCK__.settings().aiCleanup]);
      out.push(...expect(both[0] === false && both[1] === false, "Home's AI cleanup switch changes the setting", JSON.stringify(both)));
      // "Write in" with AI cleanup off translates nothing: Home says so under the select, as Settings does.
      const hint = () =>
        page.evaluate(() => {
          const el = document.getElementById("home-output-hint");
          return [!el.classList.contains("hidden"), el.textContent, document.getElementById("ai-output-skip").textContent, document.getElementById("home-output-select").getAttribute("aria-describedby")];
        });
      await page.selectOption("#home-output-select", "de");
      await wait(page, 150);
      let why = await hint();
      out.push(...expect(why[0] && why[1].length > 10 && why[1] === why[2] && why[3] === "home-output-hint", "Write in says on Home why nothing is translated while AI cleanup is off", JSON.stringify(why)));
      out.push(...expect(await page.evaluate(() => window.__MOCK__.settings().aiOutputLanguage === "de"), "Home's Write in changes the setting"));
      await page.selectOption("#home-output-select", "");
      await wait(page, 150);
      why = await hint();
      out.push(...expect(!why[0] && why[1] === "", "without a Write in language the hint is gone and empty", JSON.stringify(why)));
      await page.evaluate(() => document.getElementById("ai-toggle").click());
      await wait(page, 150);
      out.push(...expect(await page.evaluate(() => document.getElementById("home-ai-toggle").checked), "Home follows the switch in Settings"));
      await page.selectOption("#home-language-select", "de");
      await wait(page, 150);
      both = await page.evaluate(() => [document.getElementById("language-select").value, window.__MOCK__.settings().language]);
      out.push(...expect(both[0] === "de" && both[1] === "de", "Home's Language changes the setting", JSON.stringify(both)));
      // A hotkey is set in place, and Settings shows the same key.
      await page.click("#home-paste-last-btn");
      await wait(page, 80);
      await page.keyboard.press("Control+Alt+KeyP");
      await wait(page, 200);
      const keys = await page.evaluate(() => [document.getElementById("home-paste-last-text").textContent, document.getElementById("paste-last-text").textContent]);
      out.push(...expect(keys[0] === "Ctrl+Alt+P" && keys[1] === "Ctrl+Alt+P", "a hotkey set on Home shows in both places", JSON.stringify(keys)));
      // Add a word.
      await page.fill("#home-word-input", "Zeitgeist");
      await page.press("#home-word-input", "Enter");
      await wait(page, 150);
      out.push(...expect(await page.evaluate(() => window.__MOCK__.settings().customPrompt.endsWith(", Zeitgeist")), "a word added on Home is in the dictionary"));
      // Search over text and app.
      await page.fill("#history-search", "olk");
      await wait(page, 150);
      out.push(...expect((await page.locator("#history-list .history-item").count()) === 2, "the search finds dictations by their app"));
      // What a search found is said once the typing rests.
      await wait(page, 800);
      const said = await page.evaluate(() => document.getElementById("history-live").textContent);
      out.push(...expect(/^2 /.test(said), "the search says how many dictations it found", said));
      await page.fill("#history-search", "");
      await wait(page, 150);
      // Delete from the keyboard: the focus goes to the first action of the row that moves up.
      const row = (n) => page.evaluate((n) => document.querySelectorAll("#history-list .history-item")[n]?.dataset.id, n);
      const second = await row(1);
      await page.focus("#history-list .history-item:first-child [data-delete-id]");
      await page.keyboard.press("Enter");
      // The first press only arms Delete; the second one answers it (not at once: src/arm.ts).
      await wait(page, ANSWER);
      await page.keyboard.press("Enter");
      await wait(page, 200);
      const after = await page.evaluate(() => {
        const at = document.activeElement;
        return [document.querySelectorAll("#history-list .history-item").length, at.closest(".history-item")?.dataset.id ?? at.tagName, at === at.closest(".history-actions")?.querySelector('[data-action="copy"]') && getComputedStyle(at).opacity === "1"];
      });
      out.push(...expect(after[0] === 7 && after[1] === second && after[2] === true, "after Delete from the keyboard the focus is on the next row's Copy, which shows", JSON.stringify([...after, second])));
      // The cloud engine without its key is a setup again: the Speech model line says what is missing, and
      // Home shows the steps, whose second one leads to the key. Of the daily view the recent dictations
      // stay, under the steps (the controls are what the steps stand in for).
      await page.evaluate(() => document.getElementById("engine-cloud").click());
      await present(page);
      await wait(page, 200);
      const cloud = await page.evaluate(() => [document.getElementById("home-loaded-speech").textContent, document.getElementById("home-loaded-speech").dataset.tone]);
      const asks = [await shown("home-setup"), await page.evaluate(() => document.getElementById("home-controls").checkVisibility()), (await micOpen(page)).ok, await page.evaluate(() => document.getElementById("home-recent").checkVisibility())];
      await page.click("#setup-model-download");
      await wait(page);
      let landed = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
      out.push(...expect(cloud[0].includes(" · ") && cloud[1] === "warn" && asks[0] && !asks[1] && asks[2] && asks[3] && landed[0] === "groq-key" && landed[1], "the cloud engine without its key: Home shows the steps with the recent dictations under them, and the second step leads to the key field", JSON.stringify([cloud, asks, landed])));
      // With the key the daily view is back, the microphone is closed, and the Speech model line leads to the key field.
      await page.fill("#groq-key", "gsk_check");
      await page.evaluate(() => document.getElementById("groq-key").dispatchEvent(new Event("change", { bubbles: true })));
      await wait(page, 200);
      await section(page, "home");
      const keyed = [await shown("home-daily"), await shown("home-setup"), await page.evaluate(() => document.getElementById("home-loaded-speech").dataset.tone || ""), (await micClosed(page)).ok];
      await page.click('#home-loaded [data-reveal="model-select"]');
      await wait(page);
      landed = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
      out.push(...expect(keyed[0] && !keyed[1] && keyed[2] === "" && keyed[3] && landed[0] === "groq-key" && landed[1], "with the cloud engine the Speech model line leads to the key field", JSON.stringify([keyed, landed])));
      // The other two lines lead to a control that shows and has the focus.
      for (const id of ["ai-model-select", "mic-select"]) {
        await section(page, "home");
        await page.click(`#home-loaded [data-reveal="${id}"]`);
        await wait(page);
        const at = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
        out.push(...expect(at[0] === id && at[1], `the loaded card's line leads to #${id}`, JSON.stringify(at)));
      }
      // The layout's steps with the scrollbar drawn.
      out.push(...(await layoutHolds(run)));
      // A new start, and back from Settings (the window remembers the place): the screenshot is Home's.
      await again(page);
      return out;
    },
  },
  {
    id: "home-all",
    scenarios: ["populated"],
    fresh: true,
    open: async (page) => {
      await section(page, "home");
      await page.evaluate(() => {
        window.__MOCK__.addHistory(112);
        window.__MOCK__.emit("history-updated");
      });
      await wait(page);
      await page.click("#history-more");
      await wait(page);
    },
    probe: async (page) => {
      const out = [];
      const rows = () => page.locator("#history-list .history-item").count();
      out.push(...expect((await rows()) === 50, "Show all shows the first 50", String(await rows())));
      await page.click("#history-more");
      await wait(page, 150);
      out.push(...expect((await rows()) === 100, "Show more adds 50", String(await rows())));
      await page.click("#history-more");
      await wait(page, 150);
      const end = await page.evaluate(() => [document.querySelectorAll("#history-list .history-item").length, document.getElementById("history-more").classList.contains("hidden")]);
      out.push(...expect(end[0] === 120 && end[1], "the last page ends the list", JSON.stringify(end)));
      // The button that was pressed is gone: the focus is on the one that remains.
      const focus = () => page.evaluate(() => document.activeElement.id);
      out.push(...expect((await focus()) === "history-less", "after the last page the focus is on Show fewer", await focus()));
      await page.click("#history-less");
      await wait(page, 150);
      out.push(...expect((await rows()) === 8, "Show fewer goes back to the newest few", String(await rows())));
      out.push(...expect((await focus()) === "history-more", "after Show fewer the focus is on Show all", await focus()));
      await page.click("#history-more");
      await wait(page);
      return out;
    },
  },
  {
    id: "files",
    // Also at the step itself (1250 px beside the sidebar: the first width with room for two columns) and at the common large size.
    alsoSizes: ["1450x820", "1920x1080"],
    open: (page) => section(page, "files"),
    probe: async (page, run) => filesLayout(await filesNow(page), run.lang),
  },
  {
    id: "meetings",
    alsoSizes: ["1450x820", "1920x1080"],
    open: (page) => section(page, "meetings"),
    // The library has the page's width: the start row (the title's field and Start meeting) and the head span it,
    // and the meetings are rows of that width, or two columns of rows from 1250 px beside the sidebar.
    probe: async (page) => {
      const see = await page.evaluate(() => {
        const content = document.getElementById("content");
        const section = document.getElementById("section-meetings");
        const left = Math.round(section.getBoundingClientRect().left + parseFloat(getComputedStyle(section).paddingLeft));
        const right = Math.round(section.getBoundingClientRect().right - parseFloat(getComputedStyle(section).paddingRight));
        const edges = (el) => [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().right)];
        const items = [...document.querySelectorAll("#mt-list .mt-item")].map(edges);
        return { room: content.offsetWidth, page: [left, right], start: edges(document.getElementById("mt-start")), button: edges(document.getElementById("mt-start-btn")), head: edges(document.querySelector(".mt-library-head")), items };
      });
      const roomy = see.room >= ROOMY;
      const columns = new Set(see.items.map((i) => i[0])).size;
      const detail = JSON.stringify(see);
      return [
        ...expect(see.start.join() === see.page.join() && see.head.join() === see.page.join() && see.button[1] === see.page[1], "the Meetings library has the page's width: the start row and the head span it, Start meeting ends at the right edge", detail),
        ...expect(see.items.length < 2 || columns === (roomy ? 2 : 1), `the meetings are two columns from ${ROOMY} px beside the sidebar, else one`, detail),
        ...expect(see.items.length === 0 || (see.items.every((i) => i[0] >= see.page[0]) && Math.min(...see.items.map((i) => i[0])) === see.page[0] && Math.max(...see.items.map((i) => i[1])) === see.page[1] && (columns < 2 || [...new Set(see.items.map((i) => i[0]))].sort((a, b) => a - b)[1] - see.items[0][1] === 16)), "the meetings' rows run from the page's left edge to its right one, two columns one gutter apart", detail),
      ];
    },
  },
  {
    id: "soundboard",
    // Also where the panel is a column at its narrowest, and at the common large size.
    alsoSizes: ["1200x800", "1920x1080"],
    open: (page) => section(page, "soundboard"),
    // The sounds first: the panel is the left column with room, closed without; the switch always shows.
    probe: async (page, run) => {
      const out = [];
      const see = await boardNow(page);
      out.push(...expect(see.panel === see.wide && see.expanded === String(see.wide), "the settings panel is open only where it has its own column", JSON.stringify(see)));
      out.push(...expect(see.switchShown, "the virtual microphone's switch is always visible", JSON.stringify(see)));
      out.push(...expect(see.firstSound >= 0 && see.firstSound < see.height, "the first sound is on the first screen", JSON.stringify(see)));
      out.push(...(await tiles(page)));
      // The panel beside the sounds: one gutter between the two columns, as on every page (16 px; it was 24 here).
      const gutter = await page.evaluate(() => {
        const panel = document.getElementById("sb-panel")?.getBoundingClientRect();
        const library = document.querySelector("#sb-root .sb-col-library").getBoundingClientRect();
        return panel ? Math.round(library.left - panel.right) : null;
      });
      out.push(...expect(!(see.panel && see.wide) || gutter === 16, "the Soundboard's panel and its sounds stand one gutter (16 px) apart, like the two columns of every page", String(gutter)));
      // The bar: the three buttons stand beside the switch only where its text keeps a line's width, else under
      // it (English at 900x600 left the text a column of 220 px, with every line of it broken in two).
      const bar = await page.evaluate(() => {
        const mic = document.querySelector("#sb-root .sb-bar-mic").getBoundingClientRect();
        const actions = document.querySelector("#sb-root .sb-bar-actions").getBoundingClientRect();
        return { beside: actions.top < mic.bottom - 1, room: Math.round(mic.width) };
      });
      out.push(...expect(!bar.beside || bar.room >= 419, "the bar's buttons stand beside the switch only where the switch and its text keep 420 px, else under it", JSON.stringify(bar)));
      // Once per run, in windows of their own: the step with the scrollbar drawn, and the two windows that share the store.
      if (run.scenario === "populated" && run.lang === "en" && run.size === BEHAVIOUR) {
        out.push(...(await boardHolds(run)));
        out.push(...(await twoWindows(page)));
      }
      return out;
    },
  },
  {
    id: "soundboard-settings",
    fresh: true,
    alsoSizes: ["1200x800", "1920x1080"],
    // The other state of the panel: opened in a narrow window, closed in a wide one.
    open: async (page) => {
      await section(page, "soundboard");
      await page.click('#sb-root [data-key="settings"]');
      await wait(page);
    },
    probe: async (page, run) => {
      const out = [];
      let see = await boardNow(page);
      out.push(...expect(see.panel === !see.wide && see.expanded === String(!see.wide), "Soundboard settings opens and closes the panel and says which", JSON.stringify(see)));
      out.push(...expect(see.switchShown, "the virtual microphone's switch shows whether the panel is open or not", JSON.stringify(see)));
      const roles = await page.evaluate(() => [...document.querySelectorAll("#sb-root .switch input")].map((input) => input.getAttribute("role")));
      out.push(...expect(roles.length >= 1 && roles.every((role) => role === "switch"), "every switch of the Soundboard is a switch to a screen reader, not a checkbox", JSON.stringify(roles)));
      out.push(...(await tiles(page)));
      // What the keyboard does with the button and what a new start remembers depend neither on the data nor on
      // the language or the window's size: once (the pop-out's page tries the keyboard where the panel is no column).
      if (!(run.scenario === "populated" && run.lang === "en" && run.size === BEHAVIOUR)) return out;
      out.push(...(await panelByKeyboard(page)));
      // The choice is remembered for this layout.
      await page.reload({ waitUntil: "networkidle" });
      await wait(page, 500);
      await section(page, "soundboard");
      see = await boardNow(page);
      out.push(...expect(see.panel === !see.wide, "the panel's state is remembered", JSON.stringify(see)));
      return out;
    },
    // The picture shows the other state; the pages that follow get the panel as a window without a choice has it.
    after: panelAtRest,
  },
  ...TABS.map((tab) => ({ id: `settings-${tab}`, open: (page) => settings(page, tab), probe: tab === "dictionary" ? dictionaryProbe : undefined })),
  // The same tabs with Advanced open (General has no fold).
  ...TABS.filter((tab) => tab !== "general").map((tab) => ({
    id: `settings-${tab}-advanced`,
    open: async (page) => {
      // The fold first, in its panel that may not show yet, then the tab: one wait is for both.
      await page.evaluate((t) => (document.querySelector(`details.fold[data-fold="${t}"]`).open = true), tab);
      await settings(page, tab);
    },
    probe:
      tab !== "models"
        ? undefined
        : async (page, run) => {
            const out = [];
            // "More" opens the long hint in place.
            const more = page.locator("#panel-models .hint-more").first();
            await more.click();
            const opened = await page.evaluate(() => {
              const b = document.querySelector("#panel-models .hint-more");
              return [b.getAttribute("aria-expanded"), !document.getElementById(b.getAttribute("aria-controls")).hidden];
            });
            out.push(...expect(opened[0] === "true" && opened[1], "More opens the long hint", JSON.stringify(opened)));
            await more.click();
            // In place: in every row of every tab, neither "More" nor the row's control moves when the long text opens.
            const moved = await page.evaluate(async () => {
              const out = [];
              const top = (el) => Math.round(el.getBoundingClientRect().top * 10) / 10;
              // From the page's top. The keyboard walk before this leaves a page that scrolls at its end, and a
              // row above the window's top (of another tab, shown here for the measuring) then moves up by what
              // opens in it: the browser keeps the place of what is on screen. Nobody can press "More" up there.
              document.getElementById("content").scrollTop = 0;
              for (const panel of document.querySelectorAll(".tab-panel")) {
                const hidden = panel.hidden;
                panel.hidden = false;
                for (const fold of panel.querySelectorAll("details.fold")) fold.dataset.was = String(fold.open);
                for (const fold of panel.querySelectorAll("details.fold")) fold.open = true;
                for (const b of panel.querySelectorAll(".setting-row .hint-more")) {
                  const control = b.closest(".setting-row").querySelector(".setting-control > *");
                  const before = [top(b), top(control)];
                  b.click();
                  const after = [top(b), top(control)];
                  const shows = !document.getElementById(b.getAttribute("aria-controls")).hidden;
                  b.click();
                  if (!shows || before[0] !== after[0] || before[1] !== after[1]) out.push(`${b.getAttribute("aria-controls")}: ${before} -> ${after}`);
                }
                for (const fold of panel.querySelectorAll("details.fold")) fold.open = fold.dataset.was === "true";
                for (const fold of panel.querySelectorAll("details.fold")) delete fold.dataset.was;
                panel.hidden = hidden;
              }
              return out;
            });
            out.push(...expect(moved.length === 0, "More opens the long text without moving its row's control", moved.join("; ")));
            // What is remembered over a new start is the same in a window of any size: once.
            if (run.size !== BEHAVIOUR) return out;
            // The fold stays open over a new start.
            await page.reload({ waitUntil: "networkidle" });
            await wait(page, 500);
            const kept = await page.evaluate(() => [document.querySelector('details.fold[data-fold="models"]').open, document.querySelector('details.fold[data-fold="general"]') === null]);
            out.push(...expect(kept[0] === true, "an open Advanced fold is remembered", JSON.stringify(kept)));
            // A window that still needs its setup starts on Home: back to the tab, for the screenshot.
            await settings(page, "models");
            return out;
          },
  })),
  // Every tab in one column and in two (from 1250 px beside the sidebar), fold closed and open.
  // This page and the next two follow the plain tabs and leave the window usable: no new start.
  {
    id: "settings-columns",
    // Also at the step itself (1250 px beside the sidebar: the narrowest two columns) and at the common large size.
    alsoSizes: ["1450x820", "1920x1080"],
    open: (page) => settings(page, "dictation"),
    probe: columns,
  },
  // The key boxes' right edges, and the names of the buttons that read "Download" and "More".
  {
    id: "settings-keys",
    scenarios: ["populated"],
    open: async (page) => {
      await settings(page, "dictation");
      await page.evaluate(() => (document.querySelector('details.fold[data-fold="dictation"]').open = true));
      await wait(page);
    },
    // Where the key boxes end depends on the window; what the buttons are called does not.
    probe: async (page, run) => [...(await keyEdges(page)), ...(run.size === BEHAVIOUR ? await controlNames(page) : [])],
  },
  // The cloud engine without its key: the notice in the main card leads to the key field in the closed fold.
  {
    id: "settings-models-cloud",
    scenarios: ["populated"],
    open: async (page) => {
      await settings(page, "models");
      await page.evaluate(() => {
        document.querySelector('details.fold[data-fold="models"]').open = false;
        document.getElementById("engine-cloud").click();
      });
      await wait(page, 250);
    },
    probe: cloudKey,
  },
  // A model's download on its own row: while it runs, after it failed, and the next one (the mock ends or fails it).
  {
    id: "settings-models-download",
    fresh: true,
    open: async (page) => {
      await settings(page, "models");
      const firstrun = await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun");
      await page.evaluate(() => (document.querySelector('details.fold[data-fold="models"]').open = false));
      // Without a model, Download is pressed; with one, another is chosen in the dropdown.
      if (firstrun) await page.click("#download-btn");
      else await page.selectOption("#model-select", "tiny");
      await asked(page, "download_model");
      await report(page, "download-progress", firstrun ? 466e6 : 75e6);
      await wait(page, 150);
    },
    probe: speechDownload,
  },
  {
    id: "settings-ai-download",
    scenarios: ["populated"],
    fresh: true,
    open: async (page) => {
      await settings(page, "ai");
      await page.evaluate(() => (document.querySelector('details.fold[data-fold="ai"]').open = true));
      await wait(page, 150);
      await page.selectOption("#ai-model-select", "gemma-4-12b");
      await asked(page, "ai_download_model");
      await report(page, "ai-download-progress", 7121861440);
      await wait(page, 150);
    },
    probe: aiDownload,
  },
  // A download that failed, as it stays on its row until the next try. The two pages above end on a download that
  // runs or on one that worked, and a page is measured before its probe: without these the failure (a note in the
  // colour of an error with the backend's reason, Retry in the note or on the button) was never measured or in a picture.
  {
    id: "settings-models-failed",
    fresh: true,
    open: async (page) => {
      await settings(page, "models");
      const firstrun = await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun");
      await page.evaluate(() => (document.querySelector('details.fold[data-fold="models"]').open = false));
      // Without a model, Download is pressed (the button then reads Retry); with one, another is chosen (Retry stands in the note).
      if (firstrun) await page.click("#download-btn");
      else await page.selectOption("#model-select", "tiny");
      await asked(page, "download_model");
      await failNow(page, "speech", NO_LINE);
    },
  },
  // No new start: the page above had one and leaves the AI's side as it found it.
  {
    id: "settings-ai-failed",
    scenarios: ["populated"],
    open: async (page) => {
      await settings(page, "ai");
      await page.evaluate(() => (document.querySelector('details.fold[data-fold="ai"]').open = true));
      await wait(page, 150);
      await page.selectOption("#ai-model-select", "gemma-4-12b");
      await asked(page, "ai_download_model");
      // The long reason: the state line beside the switch and the model's note both carry it.
      await failNow(page, "ai", DISK_FULL);
    },
  },
  // The one way to delete. First every list with a button armed: "Delete?" is measured like any other state
  // and is in the pictures, in both languages. Then every delete of the window against the rule, which changes
  // the lists and ends in a new start.
  ...ARMED.map(([id, open, button], i) => ({
    id: `${id}-armed`,
    scenarios: ["populated"],
    sizes: ["1600x900", "900x600"],
    // The page before leaves a failed download on its row.
    fresh: i === 0,
    open: async (page) => {
      await open(page);
      await armFirst(page, button);
    },
    // The keyboard walk took the focus from the button, which disarms it: armed again for the picture.
    probe: async (page) => {
      await armFirst(page, button);
      const armed = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((b) => b.classList.contains("armed")).length, button);
      return expect(armed === 1, "one button is armed", String(armed));
    },
  })),
  {
    id: "deletes",
    scenarios: ["populated"],
    sizes: [BEHAVIOUR],
    fresh: true,
    checks: false,
    open: (page) => again(page),
    probe: deletesProbe,
  },
  {
    id: "reduced-motion",
    scenarios: ["populated"],
    sizes: [BEHAVIOUR],
    fresh: true,
    checks: false,
    open: (page) => again(page),
    probe: reducedMotion,
  },
  {
    id: "popout-deletes",
    url: "/soundboard.html",
    scope: "body",
    scenarios: ["populated"],
    sizes: ["460x680"],
    checks: false,
    open: (page) => wait(page),
    probe: popoutDeletes,
  },
  {
    id: "files-loaded",
    scenarios: ["populated"],
    alsoSizes: ["1450x820", "1920x1080"],
    fresh: true,
    open: async (page) => {
      await section(page, "files");
      await page.click("#file-choose");
      await wait(page, 500);
    },
    // With a file loaded the transcript starts on the first screen.
    probe: async (page, run) => {
      const at = await page.evaluate(() => [Math.round(document.getElementById("file-text").getBoundingClientRect().top), window.innerHeight]);
      // The end of the run is read out once: the status line itself changes with every step and is no live region.
      const said = await page.evaluate(() => {
        const bar = document.getElementById("file-progress-bar");
        const live = document.getElementById("file-live");
        return { live: live.textContent, role: live.getAttribute("role"), status: document.getElementById("file-status").textContent, statusRole: document.getElementById("file-status").getAttribute("role"), bar: [bar.getAttribute("role"), bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuetext"), document.getElementById(bar.getAttribute("aria-labelledby"))?.textContent ?? ""] };
      });
      return [
        ...expect(at[0] < at[1], "the transcript starts on the first screen", `y ${at[0]} of ${at[1]}`),
        ...expect(said.live.length > 10 && said.live === said.status && said.role === "status" && said.statusRole === null, "the end of a transcription is read out, once, by a line of its own", JSON.stringify(said)),
        ...expect(said.bar[0] === "progressbar" && said.bar[1] === "100" && said.bar[2] === said.status && said.bar[3].length > 3, "the file's bar is a progress bar named after the file, with its percent and what the status line says", JSON.stringify(said.bar)),
        ...filesLayout(await filesNow(page), run.lang),
        ...(await resultLayout(page)),
        ...(await optionsMore(page)),
      ];
    },
  },
  {
    id: "files-result",
    scenarios: ["populated"],
    // Also at the step and at the common large size: the summary in the side column, beside the transcript.
    // And at a common laptop size that is one column and high enough for the summary's five lines.
    alsoSizes: ["1280x720", "1450x820", "1920x1080"],
    fresh: true,
    open: async (page) => {
      await section(page, "files");
      await page.click("#file-choose");
      await wait(page, 500);
      await page.click("#file-summarize");
      await wait(page, 400);
    },
    // The summary stands before the transcript: it starts on the first screen. In one column it shows its first
    // lines only (five; two in a window lower than 700 px), with a More that opens the rest in place, so the
    // transcript's first line is on the first screen too: at 900×600 it began below the window.
    probe: async (page) => {
      const out = [];
      const look = () =>
        page.evaluate(() => {
          const text = document.getElementById("file-text");
          const cs = getComputedStyle(text);
          const summary = document.getElementById("file-summary");
          const more = document.getElementById("file-summary-more");
          const lineHeight = parseFloat(getComputedStyle(summary).lineHeight);
          return {
            summaryTop: Math.round(document.getElementById("file-summary-box").getBoundingClientRect().top),
            // Where the transcript's first line ends.
            firstLine: Math.round(text.getBoundingClientRect().top + parseFloat(cs.paddingTop) + parseFloat(cs.lineHeight)),
            window: window.innerHeight,
            roomy: document.getElementById("section-files").classList.contains("roomy"),
            lines: Math.round(summary.clientHeight / lineHeight),
            cut: summary.scrollHeight > summary.clientHeight + 1,
            more: more.checkVisibility() ? [more.getAttribute("aria-expanded"), more.textContent, more.getAttribute("aria-label") ?? "", more.getAttribute("aria-controls")] : null,
            whole: summary.textContent.length,
          };
        });
      const at = await look();
      const detail = JSON.stringify(at);
      out.push(...expect(at.summaryTop < at.window, "the summary starts on the first screen", detail));
      if (at.roomy) {
        out.push(...expect(!at.cut && at.more === null, "beside the transcript (two columns) the summary is shown whole, without a More", detail));
      } else {
        out.push(...expect(at.firstLine <= at.window, "in one column the transcript's first line is on the first screen with a summary open", detail));
        out.push(...expect(at.cut && at.lines === (at.window < 700 ? 2 : 5) && at.more?.[0] === "false" && /^(More|Mehr)$/.test(at.more[1]) && at.more[2].length > at.more[1].length && at.more[3] === "file-summary", "in one column the summary shows its first five lines (two in a low window) and a More that is named after it", detail));
        if (!at.more) return [...out, ...(await resultLayout(page))];
        // More opens the rest in place, Less closes it again; Copy copies the whole summary either way.
        await page.click("#file-summary-more");
        await wait(page, 100);
        const open = await look();
        await page.click("#file-summary-copy");
        await wait(page, 80);
        const copied = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === "copy_text").at(-1)?.args.text.length);
        await page.click("#file-summary-more");
        await wait(page, 100);
        const shut = await look();
        await page.click("#file-summary-copy");
        await wait(page, 80);
        const copiedCut = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === "copy_text").at(-1)?.args.text.length);
        out.push(
          ...expect(
            !open.cut && open.lines > at.lines && open.more?.[0] === "true" && /^(Less|Weniger)$/.test(open.more[1]) && shut.cut && shut.lines === at.lines && shut.more?.[0] === "false" && shut.firstLine === at.firstLine,
            "More opens the whole summary in place and Less closes it again; the transcript is back where it was",
            JSON.stringify({ open, shut }),
          ),
        );
        out.push(...expect(copied === at.whole && copiedCut === at.whole && at.whole > 100, "Copy copies the whole summary, opened or not", JSON.stringify([copied, copiedCut, at.whole])));
        await wait(page, 1300); // "Copied" is "Copy" again for the picture
      }
      return [...out, ...(await resultLayout(page))];
    },
  },
  {
    id: "meetings-open",
    scenarios: ["populated"],
    fresh: true,
    open: async (page) => {
      await section(page, "meetings");
      await page.click(".mt-item");
      await wait(page, 500);
    },
  },
  {
    id: "meetings-recording",
    scenarios: ["populated"],
    // Also at the two most common large sizes: the transcript has the window's width there, not a column of it.
    alsoSizes: ["1536x864", "1920x1080"],
    fresh: true,
    open: async (page) => {
      await section(page, "meetings");
      await page.evaluate(() => window.__MOCK__.emit("meeting-status", window.__MOCK__.meetingRecording()));
      await wait(page, 700);
    },
    // A meeting that records has no notes yet and, while nothing is the matter, no hint row: its transcript is
    // the page's only content and has the page's width at every size. From 1250 px beside the sidebar one quiet
    // line over it says when the notes come (as a side column that line alone took 489 of 1288 px at 1536×864).
    // Once a hint row is there the page is the two columns of every open meeting.
    probe: async (page) => {
      const look = () =>
        page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const section = document.getElementById("section-meetings");
          const cs = getComputedStyle(section);
          const text = box(document.getElementById("mt-transcript"));
          const line = document.querySelector(".mt-notes-none");
          return {
            state: document.getElementById("mt-view").dataset.state,
            room: document.getElementById("content").offsetWidth,
            page: [Math.round(box(section).left + parseFloat(cs.paddingLeft)), Math.round(box(section).right - parseFloat(cs.paddingRight))],
            transcript: [Math.round(text.left), Math.round(text.right), Math.round(text.top)],
            line: line.checkVisibility() ? [Math.round(box(line).left), Math.round(box(line).bottom), line.textContent.trim().length] : null,
            grid: getComputedStyle(document.querySelector("#section-meetings .mt-body")).display === "grid",
            hint: document.getElementById("mt-hint").checkVisibility(),
          };
        });
      const see = await look();
      const roomy = see.room >= ROOMY;
      const out = [
        ...expect(see.state === "recording" && !see.hint && !see.grid && see.transcript[0] === see.page[0] && see.transcript[1] === see.page[1], "a meeting that records is one column at every size: its transcript runs from the page's left edge to its right one", JSON.stringify(see)),
        ...expect(roomy ? !!see.line && see.line[0] === see.page[0] && see.line[1] <= see.transcript[2] && see.line[2] > 20 : see.line === null, `from ${ROOMY} px beside the sidebar one line over the transcript says when the notes come`, JSON.stringify(see)),
      ];
      // A hint row comes (something is the matter): the two columns of every open meeting, and back.
      await page.evaluate(() => {
        const hint = document.getElementById("mt-hint");
        const row = document.createElement("div");
        row.className = "mt-hint-row";
        row.dataset.probe = "1";
        row.innerHTML = '<span class="mt-hint-text">Probe</span>';
        hint.append(row);
        hint.classList.remove("hidden");
      });
      await wait(page, 60);
      const two = await look();
      await page.evaluate(() => {
        document.querySelector('#mt-hint [data-probe="1"]').remove();
        document.getElementById("mt-hint").classList.add("hidden");
      });
      await wait(page, 60);
      const back = await look();
      out.push(...expect(two.grid === roomy && two.line === null && (roomy ? two.transcript[0] > two.page[0] + 360 && two.transcript[1] === two.page[1] : two.transcript[0] === two.page[0]) && !back.grid && back.transcript[0] === back.page[0], `with a hint row a meeting that records has the two columns of every open meeting from ${ROOMY} px, and one again without`, JSON.stringify({ two, back })));
      return out;
    },
  },
  {
    id: "soundboard-devices",
    scenarios: ["populated"],
    fresh: true,
    open: async (page) => {
      await section(page, "soundboard");
      if (!(await page.evaluate(() => !!document.getElementById("sb-panel")))) await page.click('#sb-root [data-key="settings"]');
      await page.click(".sb-devices > summary");
      await wait(page, 400);
    },
    probe: panelMore,
    after: panelAtRest,
  },
  // ── The states (see "The states the pages above never open") ──
  // Soundboard. First the hard states that can stand side by side: a key another program has, long
  // combinations, a missing file, a sound that plays and loops, and the notice line (one file added, one not).
  state(
    "soundboard-states",
    async (page) => {
      await boardWith(page, true);
      await boardSays(page, hardBoard);
      await emit(page, "tauri://drag-drop", { paths: ["C:\\Sounds\\Ba dum tss.wav", "C:\\Sounds\\long intro of the stream.mp3"], position: { x: 400, y: 300 } });
      await wait(page, 300);
    },
    {
      shows: onScreen("taken keys on a tile and in the panel, a missing file, a sound that plays", () => {
        const now = { notes: document.querySelectorAll("#sb-root .sb-note").length, playing: document.querySelectorAll("#sb-root .sb-row.playing").length, panel: !!document.getElementById("sb-panel") };
        return (now.notes === 4 && now.playing === 1 && now.panel) || now;
      }),
      probe: async (page) => {
        const see = await page.evaluate(() => ({
          notes: [...document.querySelectorAll("#sb-root .sb-note")].length,
          notice: document.querySelector("#sb-root .sb-notice")?.textContent.split("\n").length ?? 0,
          playing: document.querySelectorAll("#sb-root .sb-row.playing").length,
          bar: parseFloat(document.querySelector("#sb-root .sb-row.playing .sb-progress-fill")?.style.width ?? "0"),
          stacked: [...document.querySelectorAll("#sb-panel .setting-row:has(.sb-hotkey)")].map((row) => getComputedStyle(row).flexDirection).join(),
          // The tile whose key another program has: its three controls are one line, and the note has the line
          // under them, starting under the key box it is about, inside the tile. The tile beside it has its
          // controls on the same level.
          taken: (() => {
            const note = document.querySelector("#sb-root .sb-row > .sb-note");
            const row = note?.closest(".sb-row");
            if (!row) return null;
            const box = (el) => el.getBoundingClientRect();
            const middle = (el) => Math.round(box(el).top + box(el).height / 2);
            const controls = [".sb-category", ".sb-hotkey", ".sb-controls .sb-slider"].map((s) => middle(row.querySelector(s)));
            const words = document.createRange();
            words.selectNodeContents(note);
            const mate = [...document.querySelectorAll("#sb-root .sb-row")].find((r) => r !== row && Math.round(box(r).top) === Math.round(box(row).top));
            return {
              oneLine: Math.max(...controls) - Math.min(...controls) <= 2,
              under: box(note).top >= box(row.querySelector(".sb-controls")).bottom,
              atKey: Math.round(words.getBoundingClientRect().left - box(row.querySelector(".sb-hotkey")).left),
              inside: box(note).bottom <= box(row).bottom && words.getBoundingClientRect().right <= box(row).right,
              level: mate ? middle(mate.querySelector(".sb-category")) - controls[0] : 0,
            };
          })(),
        }));
        return [
          // On a tile and on the panel's two keys "Taken by another program", and on the tile of the missing file "File missing".
          ...expect(see.notes === 4 && see.notice === 2 && see.playing === 1 && see.bar > 30, "the board shows its hard states: taken keys, a missing file, a sound that plays, the notice of what was added", JSON.stringify(see)),
          ...expect(see.stacked === "column,column", "the panel's two key rows have the key box under the label, in every window", see.stacked),
          ...expect(!!see.taken && see.taken.oneLine && see.taken.under && see.taken.atKey === 0 && see.taken.inside && see.taken.level === 0, "a tile whose key another program has keeps category, key and volume on one line, with the note under its key box and the next tile's controls on the same level", JSON.stringify(see.taken)),
          ...(await tilesHold(page)),
        ];
      },
    },
  ),
  // A tile's key box asks for its key. The keyboard is the box's own then (Esc ends it), so no walk; every
  // tile's box, and the panel's two, are brought into both states by the probe.
  state(
    "soundboard-tile-capture",
    async (page) => {
      await boardWith(page, false);
      await listen(page, TILE_KEYS);
    },
    {
      shows: keyBoxShows("a sound's key box asks for its key", TILE_KEYS),
      walk: false,
      probe: async (page) => {
        const out = [...(await tilesHold(page)), ...(await keyBoxes(page, TILE_KEYS))];
        await boardSays(page, hardBoard);
        out.push(...(await keyBoxes(page, TILE_KEYS)));
        await listen(page, TILE_KEYS);
        return [...out, ...(await tilesHold(page))];
      },
    },
  ),
  state(
    "soundboard-tile-refused",
    async (page) => {
      await boardWith(page, false);
      // The key of the next sound: "Already used by …" with the sound's name.
      await refused(page, TILE_KEYS, "Numpad2");
    },
    { shows: keyBoxShows("a sound's key box says that another sound has the key", TILE_KEYS, true), probe: tilesHold, after: endRefusal },
  ),
  state(
    "soundboard-panel-capture",
    async (page) => {
      await boardWith(page, true);
      await listen(page, PANEL_KEYS);
    },
    {
      shows: keyBoxShows("a key box of the panel asks for its key", PANEL_KEYS),
      walk: false,
      probe: async (page) => {
        const out = await keyBoxes(page, PANEL_KEYS);
        // With "Taken by another program" beside the box.
        await boardSays(page, hardBoard);
        out.push(...(await keyBoxes(page, PANEL_KEYS)));
        await listen(page, PANEL_KEYS);
        return out;
      },
    },
  ),
  state(
    "soundboard-panel-refused",
    async (page) => {
      await boardWith(page, true);
      await refused(page, PANEL_KEYS);
    },
    { shows: keyBoxShows("a key box of the panel says why Ctrl+C was refused", PANEL_KEYS, true), after: endRefusal },
  ),
  // The virtual microphone failed while it was on.
  state(
    "soundboard-error",
    async (page) => {
      await boardWith(page, false);
      await page.evaluate(() => {
        const m = window.__MOCK__;
        m.sb.status = { state: "error", problem: { reason: "lost", device: "cable", name: "CABLE Input (VB-Audio Virtual Cable)", detail: "the device was removed" } };
        m.emit("soundboard-status", m.sb.status);
      });
      await wait(page, 200);
    },
    {
      shows: onScreen("the switch's line says in red that the cable is gone", () => {
        const line = document.querySelector("#sb-root .sb-status");
        return (line?.dataset.tone === "error" && line.checkVisibility() && line.textContent.includes("CABLE Input")) || { tone: line?.dataset.tone, text: line?.textContent };
      }),
    },
  ),
  // No virtual cable is installed (and "Got it" was pressed on an earlier day): the instructions, the link, and
  // how to choose the cable in Discord, whether the panel is open or not.
  {
    id: "soundboard-no-cable",
    state: true,
    shows: onScreen("the box that says how to get a cable, and the switch's line in red", () => {
      const now = { link: !!document.querySelector('#sb-root > .sb-hint [data-key="cable-link"]'), tone: document.querySelector("#sb-root .sb-status")?.dataset.tone };
      return (now.link && now.tone === "error") || now;
    }),
    scenarios: ["populated"],
    sizes: STATE_SIZES,
    open: async (page) => {
      await page.evaluate((devices) => {
        window.__MOCK__.keep({ sb: { devices, status: { state: "error", problem: { reason: "no_cable", device: "cable", name: "", detail: "" } } } });
        localStorage.setItem("rudariflow-soundboard-hint-seen", "1");
      }, NO_CABLE);
      await restart(page);
      await boardWith(page, false);
    },
    probe: async (page) => {
      const see = await page.evaluate(() => {
        const box = document.querySelector("#sb-root > .sb-hint");
        return { paragraphs: box?.querySelectorAll("p").length ?? 0, link: !!box?.querySelector('[data-key="cable-link"]'), status: document.querySelector("#sb-root .sb-status").dataset.tone };
      });
      return expect(see.paragraphs === 2 && see.link && see.status === "error", "without a cable the board says how to get one and how to choose it in Discord, with the link, and the switch says why it is off", JSON.stringify(see));
    },
    after: (page) =>
      page.evaluate(() => {
        window.__MOCK__.keep({ sb: null });
        localStorage.removeItem("rudariflow-soundboard-hint-seen");
      }),
  },
  state(
    "soundboard-popped",
    async (page) => {
      await boardWith(page, false);
      await boardSays(page, () => (window.__MOCK__.board.window.poppedOut = true));
    },
    {
      shows: onScreen("the board is in its own window: the line that says so and the button that brings it back, no sound", () => {
        const now = { back: !!document.querySelector('#sb-root [data-key="dock"]')?.checkVisibility(), sounds: document.querySelectorAll("#sb-root .sb-row").length };
        return (now.back && now.sounds === 0) || now;
      }),
    },
  ),
  state(
    "soundboard-rename",
    async (page) => {
      await boardWith(page, false);
      await page.click("#sb-root .sb-row .sb-name");
      await wait(page, 100);
    },
    {
      shows: onScreen("a sound's name is a field that has the focus", () => document.activeElement?.matches("#sb-root .sb-main input") || { focus: document.activeElement?.className ?? "" }),
      walk: false,
      // The fields that rename in place have the size of what they replace: a tile and the chips' bar keep their height.
      probe: async (page) => {
        const out = await ring(page, "the field that renames a sound");
        const tiles = await page.evaluate(() => [...document.querySelectorAll("#sb-root .sb-row")].map((row) => Math.round(row.getBoundingClientRect().height)));
        out.push(...expect(new Set(tiles).size === 1, "a sound's tile keeps its height while its name is renamed", JSON.stringify(tiles)));
        await page.keyboard.press("Escape");
        await wait(page, 100);
        await page.click('#sb-root [data-key="chip-new"]');
        await wait(page, 100);
        const chips = await page.evaluate(() => {
          const field = document.querySelector("#sb-root .sb-chips input").getBoundingClientRect();
          const chip = document.querySelector("#sb-root .sb-chip").getBoundingClientRect();
          return [Math.round(field.height), Math.round(chip.height), Math.round(field.top), Math.round(chip.top), Math.round(field.width)];
        });
        out.push(...expect(chips[0] === chips[1] && chips[2] === chips[3] && chips[4] <= 160, "the field for a new category is a chip's size, on the chips' line", JSON.stringify(chips)));
        out.push(...(await ring(page, "the field for a new category")));
        const found = await page.evaluate((o) => window.__uic.collect(o), { scope: "#content", userText: USER_TEXT });
        out.push(...found.filter((f) => LAYOUT.includes(f.check) || f.check === "name" || f.check === "target").map((f) => ({ ...f, what: `${f.what}, while a new category is named` })));
        await page.keyboard.press("Escape");
        await wait(page, 100);
        await page.click("#sb-root .sb-row .sb-name");
        await wait(page, 100);
        return out;
      },
    },
  ),
  state(
    "soundboard-no-match",
    async (page) => {
      await boardWith(page, false);
      await page.fill("#sb-root .sb-search", "qqq");
      await wait(page, 150);
    },
    {
      shows: onScreen("the search finds no sound, and the list says so", () => {
        const now = { sounds: document.querySelectorAll("#sb-root .sb-row").length, says: document.querySelector("#sb-root .sb-list .empty-state")?.checkVisibility() ?? false };
        return (now.sounds === 0 && now.says) || now;
      }),
    },
  ),
  state(
    "soundboard-drag",
    async (page) => {
      await boardWith(page, false);
      await emit(page, "tauri://drag-enter", { paths: ["C:\\Sounds\\Ba dum tss.wav"], position: { x: 400, y: 300 } });
      await wait(page, 100);
    },
    {
      shows: onScreen("files are dragged over the board", () => document.getElementById("sb-root").classList.contains("dragging")),
      probe: async (page) => {
        const outline = await page.evaluate(() => [document.getElementById("sb-root").classList.contains("dragging"), getComputedStyle(document.getElementById("sb-root")).outlineColor]);
        return expect(outline[0] && !/, 0\)$|transparent/.test(outline[1]), "files dragged over the window outline the board", JSON.stringify(outline));
      },
      after: (page) => emit(page, "tauri://drag-leave", {}),
    },
  ),
  state(
    "soundboard-keys-off",
    async (page) => {
      await boardWith(page, true);
      await boardSays(page, () => (window.__MOCK__.board.soundHotkeys = false));
    },
    {
      shows: onScreen("the sound hotkeys are off: every sound's key is dimmed", () => {
        const now = { sounds: document.querySelectorAll("#sb-root .sb-row").length, dimmed: document.querySelectorAll("#sb-root .sb-row .sb-hotkey.off").length };
        return (now.sounds > 0 && now.dimmed === now.sounds) || now;
      }),
    },
  ),
  state(
    "soundboard-many",
    async (page) => {
      await boardWith(page, false);
      await boardSays(page, () => window.__MOCK__.manySounds());
    },
    {
      shows: onScreen("24 sounds in 5 categories", () => {
        const now = { sounds: document.querySelectorAll("#sb-root .sb-row").length, chips: document.querySelectorAll("#sb-root .sb-chips .sb-chip").length };
        return (now.sounds === 24 && now.chips >= 6) || now;
      }),
      probe: async (page) => [...(await tiles(page)), ...(await tilesHold(page))],
    },
  ),

  // Meetings.
  // The tray's Quit while a meeting records: the question, over the page.
  state(
    "meetings-quit",
    async (page) => {
      await recording(page);
      await emit(page, "meeting-quit-asked");
      await wait(page, 200);
    },
    {
      shows: onScreen("the question whether to quit is open over the page", () => {
        const dialog = document.getElementById("mt-quit");
        return (dialog.open && dialog.matches(":modal") && dialog.checkVisibility()) || { open: dialog.open };
      }),
      scope: "#mt-quit",
      after: (page) => page.evaluate(() => document.getElementById("mt-quit").close()),
    },
  ),
  // The library while a meeting records: the bar with every warning and the paused line, the reminder, and
  // another meeting whose end steps run.
  state(
    "meetings-warnings",
    async (page) => {
      const trouble = { warnings: ["micLost", "pcLost", "noPcSound", "writeFailed"], paused: true };
      await recording(page, trouble);
      await page.evaluate(([trouble, id]) => window.__MOCK__.emit("meeting-status", { ...window.__MOCK__.meetingRecording(trouble), finishing: [{ id, step: "notes" }] }), [trouble, M1]);
      await page.click("#mt-back");
      await wait(page, 400);
    },
    {
      shows: onScreen("the library while a meeting records, with the bar's warnings", () => {
        const now = { warnings: document.querySelectorAll("#mt-warnings .mt-warning").length, library: document.getElementById("mt-library").checkVisibility() };
        return (now.warnings === 5 && now.library) || now;
      }),
      probe: async (page) => {
        const see = await page.evaluate(() => ({ lines: document.querySelectorAll("#mt-warnings .mt-warning").length, finishing: document.querySelectorAll("#mt-finishing .mt-finishing-line").length, reminder: document.getElementById("mt-reminder").checkVisibility(), badge: document.querySelector("#mt-list .mt-badge")?.dataset.state, library: document.getElementById("mt-library").checkVisibility() }));
        return expect(see.lines === 5 && see.finishing === 1 && see.reminder && see.badge === "recording" && see.library, "the library while a meeting records: its four warnings and the paused line, the reminder, the finishing line, the meeting in the list", JSON.stringify(see));
      },
    },
  ),
  state("meetings-interrupted", (page) => meeting(page, M2), {
    shows: onScreen("an open meeting that was cut off: the warning with Finish", () => {
      const now = { open: document.getElementById("section-meetings").classList.contains("mt-open"), warn: !!document.querySelector('#mt-hint .mt-hint-row[data-tone="warn"] button')?.checkVisibility() };
      return (now.open && now.warn) || now;
    }),
  }),
  // Finished without notes and without speakers: each reason with its way out (Download, Write notes), and the audio that is gone.
  state(
    "meetings-no-notes",
    async (page) => {
      await page.evaluate(() => (window.__MOCK__.speakerModel.downloaded = false));
      await meeting(page, M3);
    },
    {
      // Also at the common large size: the hint rows in the side column, the transcript beside them.
      sizes: [...STATE_SIZES, "1920x1080"],
      shows: onScreen("an open meeting without notes: three hint rows and the transcript", () => {
        const now = { open: document.getElementById("section-meetings").classList.contains("mt-open"), notes: document.getElementById("section-meetings").classList.contains("mt-has-notes"), rows: document.querySelectorAll("#mt-hint .mt-hint-row").length, said: document.querySelectorAll("#mt-transcript .mt-para").length };
        return (now.open && !now.notes && now.rows === 3 && now.said === 7) || now;
      }),
      probe: async (page) => {
        const rows = await page.evaluate(() => [...document.querySelectorAll("#mt-hint .mt-hint-row")].map((row) => row.querySelector("button")?.dataset.action ?? ""));
        // The page has the shape of a meeting with notes. One column: the hint rows, then the transcript, both
        // of the page's width. Two columns (1250 px beside the sidebar): the hint rows are the side column, where
        // the notes would stand, and the transcript runs from one gutter beside it to the page's right edge.
        // The head's buttons end at the page's right edge in both.
        const frame = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const section = document.getElementById("section-meetings");
          const cs = getComputedStyle(section);
          const lines = (el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
          };
          const hint = box(document.getElementById("mt-hint"));
          const text = box(document.getElementById("mt-transcript"));
          return {
            room: document.getElementById("content").offsetWidth,
            page: [Math.round(box(section).left + parseFloat(cs.paddingLeft)), Math.round(box(section).right - parseFloat(cs.paddingRight))],
            hint: [Math.round(hint.left), Math.round(hint.right), Math.round(hint.top)],
            transcript: [Math.round(text.left), Math.round(text.right), Math.round(text.top)],
            actions: Math.round(box(document.querySelector(".mt-view-actions")).right),
            none: document.querySelector(".mt-notes-none").checkVisibility(),
            // A hint that wraps although its row has 40 px or more left beside it.
            early: [...document.querySelectorAll("#mt-hint .mt-hint-row")].filter((row) => {
              const text = row.querySelector(".mt-hint-text");
              const end = row.querySelector("button") ? box(row.querySelector("button")).left : box(row).right - 12;
              return lines(text) > 1 && end - box(text).right > 40;
            }).length,
          };
        });
        const roomy = frame.room >= ROOMY;
        const side = frame.hint[1] - frame.hint[0];
        return [
          ...expect(rows.length === 3 && rows[0] === "speaker-model" && rows[1].startsWith("notes:") && rows[2] === "", "a meeting without speakers and notes says why, with Download and Write notes, and that its audio is deleted", JSON.stringify(rows)),
          ...expect(frame.transcript[1] === frame.page[1] && frame.actions === frame.page[1] && frame.hint[0] === frame.page[0] && !frame.none, "without notes the transcript and the head's buttons end at the page's right edge, and the hint rows start at its left one", JSON.stringify(frame)),
          ...expect(
            roomy ? side >= 360 && side <= 622 && frame.transcript[0] - frame.hint[1] === 16 && Math.abs(frame.transcript[2] - frame.hint[2]) <= 40 : frame.hint[1] === frame.page[1] && frame.transcript[0] === frame.page[0] && frame.transcript[2] > frame.hint[2],
            `without notes the hint rows are the side column from ${ROOMY} px beside the sidebar (the transcript one gutter beside them), else they stand over it`,
            JSON.stringify(frame),
          ),
          ...expect(frame.early === 0, "a hint row's sentence has the row's line: none wraps while its row has room", JSON.stringify(frame)),
        ];
      },
    },
  ),
  // A long live transcript, scrolled up: "Jump to live".
  state(
    "meetings-live-long",
    async (page) => {
      await recording(page);
      await page.evaluate(() => window.__MOCK__.emit("meeting-lines", window.__MOCK__.meetingLines(36)));
      await wait(page, 200);
      await scrolledUp(page);
    },
    {
      // No walk: Tab goes through the transcript's play buttons to its end, which is "live" again, and the
      // button goes before Tab comes to it (or just after: that was a finding in one run of two). The same
      // controls are walked on `meetings-recording`; the button's focus ring is asked for here.
      walk: false,
      shows: onScreen("a long live transcript, scrolled up: Jump to live", () => {
        const now = { live: document.getElementById("mt-live").checkVisibility(), said: document.querySelectorAll("#mt-transcript .mt-para").length, at: document.getElementById("mt-transcript").scrollTop };
        return (now.live && now.said === 40 && now.at === 0) || now;
      }),
      probe: async (page) => {
        // A key was pressed in the window: from then on a focus shows as the keyboard's.
        await page.keyboard.press("Shift");
        await page.focus("#mt-live");
        const out = await ring(page, "Jump to live");
        await page.evaluate(() => document.activeElement?.blur?.());
        const see = await page.evaluate(() => {
          const live = document.getElementById("mt-live").getBoundingClientRect();
          const box = document.getElementById("mt-transcript").getBoundingClientRect();
          return { shown: live.width > 0, inside: live.left >= box.left && live.right <= box.right && live.bottom <= box.bottom && live.top >= box.top, rows: document.querySelectorAll("#mt-transcript .mt-para").length };
        });
        return [...out, ...expect(see.shown && see.inside && see.rows === 40, "scrolled up in a live transcript, Jump to live shows inside the transcript's frame", JSON.stringify(see))];
      },
    },
  ),
  state(
    "meetings-title-edit",
    async (page) => {
      await meeting(page, M1);
      await page.click("#mt-view-title");
      await wait(page, 100);
    },
    {
      shows: onScreen("the meeting's title is a field that has the focus", () => document.activeElement?.matches("#section-meetings .mt-title-edit") || { focus: document.activeElement?.className ?? "" }),
      walk: false,
      probe: (page) => ring(page, "the field that renames a meeting"),
    },
  ),
  state(
    "meetings-speaker-edit",
    async (page) => {
      await meeting(page, M1);
      await page.click("#mt-speaker-chips .speaker-chip");
      await wait(page, 100);
    },
    {
      shows: onScreen("a speaker's chip is a field that has the focus", () => document.activeElement?.matches("#mt-speaker-chips .speaker-chip-input") || { focus: document.activeElement?.className ?? "" }),
      walk: false,
      probe: (page) => ring(page, "the field that renames a speaker"),
    },
  ),
  state(
    "meetings-export",
    async (page) => {
      await meeting(page, M1);
      await page.click("#mt-export");
      await wait(page, 100);
    },
    {
      shows: onScreen("a meeting's Export menu is open", () => {
        const now = { list: document.getElementById("mt-export-list").checkVisibility(), expanded: document.getElementById("mt-export").getAttribute("aria-expanded") };
        return (now.list && now.expanded === "true") || now;
      }),
      walk: false,
      probe: (page) => menuItems(page, "#mt-export", "#mt-export-list"),
    },
  ),
  state(
    "meetings-start-error",
    async (page) => {
      await section(page, "meetings");
      await page.evaluate(() => window.__MOCK__.refuseNext("meeting_start", "no_model"));
      await page.click("#mt-start-btn");
      await wait(page, 200);
    },
    {
      shows: onScreen("under the start row, why the meeting did not start", () => {
        const line = document.getElementById("mt-start-error");
        return (line.checkVisibility() && line.textContent.trim().length > 10) || { shown: line.checkVisibility(), text: line.textContent };
      }),
    },
  ),
  state(
    "meetings-no-match",
    async (page) => {
      await section(page, "meetings");
      await page.fill("#mt-search", "qqq");
      await wait(page, 450);
    },
    {
      shows: onScreen("the search finds no meeting, and the list says so", () => {
        const now = { meetings: document.querySelectorAll("#mt-list .mt-item").length, says: document.getElementById("mt-empty").checkVisibility() };
        return (now.meetings === 0 && now.says) || now;
      }),
    },
  ),
  // Twelve meetings: two columns of rows from 1250 px beside the sidebar, the newer half at the left.
  state(
    "meetings-many",
    async (page) => {
      await section(page, "meetings");
      await page.evaluate(() => {
        window.__MOCK__.addMeetings(9);
        window.__MOCK__.emit("meetings-changed", null);
      });
      await wait(page, 300);
    },
    {
      sizes: [...STATE_SIZES, "1920x1080"],
      shows: onScreen("twelve meetings in the library", () => document.querySelectorAll("#mt-list .mt-item").length === 12 || { meetings: document.querySelectorAll("#mt-list .mt-item").length }),
      probe: async (page) => {
        const see = await page.evaluate(() => {
          const items = [...document.querySelectorAll("#mt-list .mt-item")].map((el) => el.getBoundingClientRect());
          // Newest first, column by column: the right column goes on where the left one ends.
          const lefts = [...new Set(items.map((r) => Math.round(r.left)))].sort((a, b) => a - b);
          const order = items.map((r) => `${lefts.indexOf(Math.round(r.left))}:${Math.round(r.top)}`);
          const sorted = [...order].sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0]) || Number(a.split(":")[1]) - Number(b.split(":")[1]));
          const perColumn = lefts.map((x) => items.filter((r) => Math.round(r.left) === x).length);
          return { items: items.length, columns: lefts.length, perColumn, down: order.join() === sorted.join(), heights: new Set(items.map((r) => Math.round(r.height))).size, roomy: document.getElementById("content").offsetWidth >= 1250 };
        });
        return expect(
          see.items === 12 && see.columns === (see.roomy ? 2 : 1) && see.heights === 1 && see.down && (!see.roomy || see.perColumn.join() === "6,6"),
          "twelve meetings: rows of one height; from 1250 px beside the sidebar two columns of six, filled one after the other (the list's order reads downwards)",
          JSON.stringify(see),
        );
      },
    },
  ),

  // Files.
  // A run in progress: what Whisper has so far, then the speakers with their percent, and Cancel.
  state(
    "files-running",
    async (page) => {
      await fileRuns(page);
      await emit(page, "file-progress", { phase: "speakers", done: 43, total: 100, text: "" });
      await wait(page, 150);
    },
    {
      shows: onScreen("a file runs: Cancel, and the speakers' percent in the status line", () => {
        const now = { cancel: document.getElementById("file-cancel").checkVisibility(), status: document.getElementById("file-status").textContent };
        return (now.cancel && /43 %$/.test(now.status)) || now;
      }),
      probe: async (page) => {
        const see = await page.evaluate(() => ({ status: document.getElementById("file-status").textContent, cancel: document.getElementById("file-cancel").checkVisibility(), clear: document.getElementById("file-clear").disabled, text: document.getElementById("file-text").value.length, bar: document.getElementById("file-progress-fill").style.width, live: document.getElementById("file-live").textContent, now: document.getElementById("file-progress-bar").getAttribute("aria-valuenow") }));
        // While it runs nothing is read out by itself: the bar has the percent for a screen reader that asks.
        if (see.live !== "" || see.now !== "89") return expect(false, "while a file runs nothing is read out step by step, and its bar has the percent", JSON.stringify(see));
        return expect(/43 %$/.test(see.status) && see.cancel && see.clear && see.text > 100 && see.bar === "89%", "a file that runs shows its percent, the text so far and Cancel", JSON.stringify(see));
      },
      after: (page) => page.evaluate(() => window.__MOCK__.release("transcribe_file")),
    },
  ),
  // The speaker model is not there yet: it is fetched first, and the row of the setting says how far it is.
  state(
    "files-model-download",
    async (page) => {
      await section(page, "files");
      await page.evaluate(() => (window.__MOCK__.speakerModel.downloaded = false));
      await page.click("#file-choose");
      await asked(page, "speaker_model_download");
      await report(page, "speaker-model-progress", 45e6);
      await wait(page, 150);
    },
    {
      shows: onScreen("the speaker model downloads: its percent on the Speakers row", () => /43 %$/.test(document.getElementById("file-speakers-hint").textContent) || { hint: document.getElementById("file-speakers-hint").textContent }),
      probe: async (page) => {
        const see = await page.evaluate(() => [document.getElementById("file-speakers-hint").textContent, document.getElementById("file-cancel").checkVisibility(), document.getElementById("status-indicator").dataset.kind]);
        return expect(/43 %$/.test(see[0]) && see[1] && see[2] === "downloading", "the speaker model's download shows its percent on the Speakers row and in the status, with Cancel", JSON.stringify(see));
      },
    },
  ),
  // The file could not be read: the backend's own words after "Did not work".
  state(
    "files-failed",
    async (page) => {
      await section(page, "files");
      await page.evaluate(() => window.__MOCK__.refuseNext("transcribe_file", "ffmpeg could not read the file: Invalid data found when processing input (moov atom not found)"));
      await page.click("#file-choose");
      await wait(page, 300);
    },
    {
      shows: onScreen("the status line says in red, in the backend's words, why the file could not be read", () => {
        const line = document.getElementById("file-status");
        return (line.checkVisibility() && line.dataset.tone === "error" && line.textContent.includes("moov atom")) || { tone: line.dataset.tone, text: line.textContent };
      }),
    },
  ),
  // A second file is dropped while the first one runs.
  state(
    "files-busy",
    async (page) => {
      await fileRuns(page);
      await emit(page, "tauri://drag-drop", { paths: ["C:\\Users\\Oggi\\Downloads\\Interview.mp3"], position: { x: 400, y: 300 } });
      await wait(page, 150);
    },
    {
      shows: onScreen("a second file while one runs: the status line in red, and Cancel still there", () => {
        const now = { tone: document.getElementById("file-status").dataset.tone, cancel: document.getElementById("file-cancel").checkVisibility() };
        return (now.tone === "error" && now.cancel) || now;
      }),
      probe: async (page) => {
        const see = await page.evaluate(() => [document.getElementById("file-status").dataset.tone, document.getElementById("file-cancel").checkVisibility(), document.getElementById("file-name").textContent]);
        return expect(see[0] === "error" && see[1] && /Keller/.test(see[2]), "a second file while one runs: the status says so, and the first one goes on", JSON.stringify(see));
      },
      after: (page) => page.evaluate(() => window.__MOCK__.release("transcribe_file")),
    },
  ),
  state(
    "files-cancelled",
    async (page) => {
      await fileRuns(page);
      await page.click("#file-cancel");
      await page.evaluate(() => window.__MOCK__.reject("transcribe_file", "cancelled"));
      await wait(page, 200);
    },
    {
      shows: onScreen("a cancelled file: no Cancel any more, the text so far, nothing to export", () => {
        const now = { cancel: document.getElementById("file-cancel").checkVisibility(), text: document.getElementById("file-text").value.length, export: document.getElementById("file-export").disabled, status: document.getElementById("file-status").textContent.length };
        return (!now.cancel && now.text > 100 && now.export && now.status > 5) || now;
      }),
      probe: async (page) => {
        const see = await page.evaluate(() => ({ text: document.getElementById("file-text").value.length, copy: !document.getElementById("file-copy").disabled, export: document.getElementById("file-export").disabled, cancel: document.getElementById("file-cancel").checkVisibility(), tone: document.getElementById("file-status").dataset.tone }));
        return expect(see.text > 100 && see.copy && see.export && !see.cancel && see.tone === "", "a cancelled file keeps the text so far, to copy, and says so without the colour of an error", JSON.stringify(see));
      },
    },
  ),
  state(
    "files-summary-running",
    async (page) => {
      await fileLoaded(page);
      await page.evaluate(() => window.__MOCK__.holdNext("summarize_text"));
      await page.click("#file-summarize");
      await asked(page, "summarize_text");
      await emit(page, "summary-progress", [1, 4]);
      await wait(page, 150);
    },
    {
      shows: onScreen("a summary is being written: the box says which part of how many, and the button rests", () => {
        const now = { box: document.getElementById("file-summary-box").checkVisibility(), says: document.getElementById("file-summary").textContent, button: document.getElementById("file-summarize").disabled };
        return (now.box && /2\D+4$/.test(now.says) && now.button) || now;
      }),
      after: (page) => page.evaluate(() => window.__MOCK__.release("summarize_text")),
    },
  ),
  state(
    "files-summary-failed",
    async (page) => {
      await fileLoaded(page);
      await page.evaluate(() => window.__MOCK__.refuseNext("summarize_text", "no_ai_model"));
      await page.click("#file-summarize");
      await wait(page, 300);
    },
    {
      shows: onScreen("the summary's box says in red why there is no summary", () => {
        const text = document.getElementById("file-summary");
        return (text.checkVisibility() && text.dataset.tone === "error" && text.textContent.trim().length > 10) || { shown: text.checkVisibility(), tone: text.dataset.tone, text: text.textContent };
      }),
    },
  ),
  state(
    "files-summary-hidden",
    async (page) => {
      await fileLoaded(page);
      await page.click("#file-summarize");
      await wait(page, 300);
      await page.click("#file-summary-toggle");
      await wait(page, 100);
    },
    {
      shows: onScreen("the summary is hidden: its head stays, its text is gone, the button says Show", () => {
        const now = { head: document.getElementById("file-summary-toggle").checkVisibility(), text: document.getElementById("file-summary").checkVisibility(), expanded: document.getElementById("file-summary-toggle").getAttribute("aria-expanded") };
        return (now.head && !now.text && now.expanded === "false") || now;
      }),
    },
  ),
  // An export that was saved (the status line names the file), and the menu open again.
  state(
    "files-export",
    async (page) => {
      await fileLoaded(page);
      await page.evaluate(() => (window.__MOCK__.savePath = "C:\\Users\\Oggi\\Documents\\Kundengespräch Keller 2026-10-05.docx"));
      await page.click("#file-export");
      await page.click('#file-export-list [data-kind="docx"]');
      await asked(page, "export_file");
      await wait(page, 150);
      await page.click("#file-export");
      await wait(page, 100);
    },
    {
      shows: onScreen("an export was saved, and the Export menu is open again", () => {
        const now = { list: document.getElementById("file-export-list").checkVisibility(), tone: document.getElementById("file-status").dataset.tone };
        return (now.list && now.tone === "ok") || now;
      }),
      walk: false,
      probe: async (page) => {
        const status = await page.evaluate(() => [document.getElementById("file-status").textContent, document.getElementById("file-status").dataset.tone]);
        return [...expect(/Keller 2026-10-05\.docx$/.test(status[0]) && status[1] === "ok", "an export that was saved names its file in the status line", JSON.stringify(status)), ...(await menuItems(page, "#file-export", "#file-export-list"))];
      },
    },
  ),
  // Timestamps on, and a speaker being renamed.
  state(
    "files-times-rename",
    async (page) => {
      await fileLoaded(page);
      await page.click("#file-times");
      await wait(page, 150);
      await page.click("#file-speaker-chips .speaker-chip");
      await wait(page, 100);
    },
    {
      shows: onScreen("Timestamps is on, and a speaker's chip is a field that has the focus", () => {
        const now = { times: document.getElementById("file-times").checked, field: !!document.activeElement?.matches("#file-speaker-chips .speaker-chip-input") };
        return (now.times && now.field) || now;
      }),
      walk: false,
      probe: async (page) => [...expect(await page.evaluate(() => /^\[0:04\] /.test(document.getElementById("file-text").value)), "with Timestamps on every paragraph starts with its time"), ...(await ring(page, "the field that renames a file's speaker"))],
    },
  ),
  state(
    "files-drag",
    async (page) => {
      await section(page, "files");
      await emit(page, "tauri://drag-enter", { paths: ["C:\\Users\\Oggi\\Downloads\\Interview.mp3"], position: { x: 400, y: 300 } });
      await wait(page, 100);
    },
    {
      shows: onScreen("a file is dragged over the window: the drop zone is lit", () => document.getElementById("file-drop").classList.contains("dragging")),
      after: (page) => emit(page, "tauri://drag-leave", {}),
    },
  ),

  // Settings and Home.
  // The PC check while it runs (its button counts), and its report with "Copy report"; with it the line that says
  // that the GPU is freed for a game right now.
  state(
    "settings-pc-check-running",
    async (page) => {
      await advanced(page, "models");
      await page.evaluate(() => window.__MOCK__.holdNext("pc_check"));
      await page.click("#pc-check-btn");
      await asked(page, "pc_check");
      await emit(page, "pc-check-progress", [1, 4, "CUDA NVIDIA GeForce RTX 5080, flash attention"]);
      await wait(page, 100);
    },
    {
      shows: onScreen("the PC check runs: its button rests and counts", () => {
        const button = document.getElementById("pc-check-btn");
        return (button.checkVisibility() && button.disabled && /2\/4/.test(button.textContent)) || { shown: button.checkVisibility(), rests: button.disabled, text: button.textContent };
      }),
      after: (page) => page.evaluate(() => window.__MOCK__.release("pc_check")),
    },
  ),
  state(
    "settings-pc-check-report",
    async (page) => {
      await advanced(page, "models");
      await page.click("#pc-check-btn");
      await emit(page, "game-free", true);
      await wait(page, 250);
    },
    {
      shows: onScreen("the PC check's report, and the line that the GPU is freed for a game", () => {
        const now = { report: document.getElementById("pc-check-report").checkVisibility() && document.getElementById("pc-check-report").textContent.length > 200, freed: document.getElementById("game-free-status").checkVisibility() };
        return (now.report && now.freed) || now;
      }),
      probe: async (page) => {
        const see = await page.evaluate(() => [document.getElementById("pc-check-report").textContent.split("\n").length, document.getElementById("pc-check-copy").checkVisibility(), document.getElementById("game-free-status").checkVisibility()]);
        return expect(see[0] === 10 && see[1] && see[2], "the PC check's report shows with Copy report, and Free GPU for games says that it is freed now", JSON.stringify(see));
      },
    },
  ),
  // "Try it": the cleaned-up sample; the sample as it was typed with the reason; the backend's refusal.
  state("settings-ai-test", tryIt, { shows: triedIt("the cleaned-up sample with the AI's time", "", /412/, true), probe: tryItFields }),
  state(
    "settings-ai-test-plain",
    async (page) => {
      await page.evaluate(() => (window.__MOCK__.aiFallback = "The AI model is not downloaded"));
      await tryIt(page);
    },
    { shows: triedIt("the sample as it was typed, with the reason in yellow", "warn", /not downloaded/, false) },
  ),
  state(
    "settings-ai-test-error",
    async (page) => {
      await page.evaluate(() => window.__MOCK__.refuseNext("ai_test", "error sending request for url (http://127.0.0.1:8173/v1/chat/completions): connection refused"));
      await tryIt(page);
    },
    { shows: triedIt("the backend's refusal in red", "error", /connection refused/, false) },
  ),
  // The key boxes of Settings > Dictation: the Dictate row's (it shares its row with Hold / Toggle) asks for
  // its key; the probe brings each of the five into both states.
  state(
    "settings-keys-capture",
    async (page) => {
      await advanced(page, "dictation");
      await listen(page, "#hotkey-btn");
    },
    {
      shows: keyBoxShows("Dictate's key box asks for its key", "#hotkey-btn"),
      walk: false,
      probe: async (page) => {
        const out = await keyBoxes(page, SETTINGS_KEYS);
        await listen(page, "#hotkey-btn");
        return out;
      },
    },
  ),
  state(
    "settings-keys-refused",
    async (page) => {
      await advanced(page, "dictation");
      await refused(page, "#rewrite-last-btn");
    },
    { shows: keyBoxShows("the key box of Rewrite last says why Ctrl+C was refused", "#rewrite-last-btn", true), after: endRefusal },
  ),
  // Home's card of hotkeys.
  state(
    "home-keys-capture",
    async (page) => {
      await section(page, "home");
      await listen(page, "#home-rewrite-last-btn");
    },
    {
      // Also where the card is narrowest: two columns of cards beside the list, from 1600 px beside the sidebar.
      sizes: [...STATE_SIZES, "1800x1000"],
      shows: keyBoxShows("the key box of Rewrite last on Home asks for its key", "#home-rewrite-last-btn"),
      walk: false,
      probe: async (page) => {
        const out = await keyBoxes(page, HOME_KEYS);
        await listen(page, "#home-rewrite-last-btn");
        return out;
      },
    },
  ),
  state(
    "home-keys-refused",
    async (page) => {
      await section(page, "home");
      await refused(page, "#home-free-gpu-btn");
    },
    { sizes: [...STATE_SIZES, "1800x1000"], shows: keyBoxShows("the key box of Free GPU on Home says why Ctrl+C was refused", "#home-free-gpu-btn", true), after: endRefusal },
  ),
  // The first run's third step (a new PC's data: the steps show only there). `again` is the new start.
  {
    id: "home-setup-key-capture",
    state: true,
    shows: keyBoxShows("the key box of the setup's third step asks for its key", "#setup-hotkey-btn"),
    scenarios: ["firstrun"],
    sizes: STATE_SIZES,
    walk: false,
    open: async (page) => {
      await again(page);
      await listen(page, "#setup-hotkey-btn");
    },
    probe: async (page) => {
      const out = await keyBoxes(page, "#setup-hotkey-btn");
      await listen(page, "#setup-hotkey-btn");
      return out;
    },
    after: (page) => page.keyboard.press("Escape"),
  },
  {
    id: "home-setup-key-refused",
    state: true,
    shows: keyBoxShows("the key box of the setup's third step says why Ctrl+C was refused", "#setup-hotkey-btn", true),
    scenarios: ["firstrun"],
    sizes: STATE_SIZES,
    open: async (page) => {
      await again(page);
      await refused(page, "#setup-hotkey-btn");
    },
    after: endRefusal,
  },
  // A long dictionary: the notice that Whisper reads only the last entries.
  state(
    "settings-dictionary-long",
    async (page) => {
      await settings(page, "dictionary");
      await page.fill("#dict-input", Array.from({ length: 60 }, (_, i) => `Fachbegriff${i + 1}`).join(", "));
      await page.press("#dict-input", "Enter");
      await wait(page, 300);
    },
    {
      shows: onScreen("a dictionary of 72 words, with the notice that it is long", () => {
        const now = { words: document.querySelectorAll("#dict-list .dict-row").length, notice: document.getElementById("dict-long").checkVisibility() };
        return (now.words === 72 && now.notice) || now;
      }),
      probe: async (page) => expect(await page.evaluate(() => document.getElementById("dict-long").checkVisibility()), "a long dictionary shows the notice that only the last entries are read"),
    },
  ),
  // Write in, with a spoken language set and an app that gets no AI: both of its warnings, in Settings and on Home.
  state(
    "settings-ai-warnings",
    async (page) => {
      await settings(page, "ai");
      await choose(page, "language-select", "de");
      await choose(page, "ai-output-select", "en");
      await wait(page, 300);
    },
    {
      shows: onScreen("Write in is English while German is spoken: both of its warnings", () => {
        const now = { tab: document.getElementById("panel-ai").checkVisibility(), warnings: ["ai-output-skip", "ai-output-warn"].map((id) => document.getElementById(id).checkVisibility()) };
        return (now.tab && now.warnings.every(Boolean)) || now;
      }),
      probe: async (page) => {
        const see = await page.evaluate(() => ["ai-output-skip", "ai-output-warn"].map((id) => document.getElementById(id).checkVisibility() && document.getElementById(id).textContent.length > 20));
        return expect(see[0] && see[1], "Write in shows both of its warnings: the apps without AI, and the spoken language that is not Auto-detect", JSON.stringify(see));
      },
    },
  ),
  state(
    "home-output-warn",
    async (page) => {
      await settings(page, "ai");
      await choose(page, "language-select", "de");
      await choose(page, "ai-output-select", "en");
      await section(page, "home");
    },
    {
      shows: onScreen("Home, with the warning under Write in", () => {
        const now = { home: document.getElementById("section-home").classList.contains("active"), warning: document.getElementById("home-output-hint").checkVisibility() };
        return (now.home && now.warning) || now;
      }),
      probe: async (page) => expect(await page.evaluate(() => document.getElementById("home-output-hint").checkVisibility() && document.getElementById("home-output-hint").textContent.length > 20), "Home says under Write in what Settings warns of") },
  ),
  // ── After the whole-branch review, wave 1 ──
  // Someone who has dictated before and has no microphone today (a USB headset that is off, a laptop away
  // from its dock): the steps, and under them the recent dictations, which are nowhere else in the window.
  {
    id: "home-no-microphone",
    state: true,
    shows: stepsAndList("a PC in daily use without a microphone: the setup steps, with the recent dictations under them"),
    scenarios: ["populated"],
    // Also in a large window, where the list stands beside the steps (Home's grid).
    sizes: [...STATE_SIZES, "1920x1080"],
    open: async (page) => {
      await page.evaluate(() => window.__MOCK__.keep({ mics: [] }));
      await restart(page);
      await section(page, "home");
    },
    probe: (page, run) => historyStays(page, run, "home_reason_microphone"),
    after: async (page) => {
      await page.evaluate(() => window.__MOCK__.keep({ mics: null }));
      await restart(page);
    },
  },
  // The same PC with the cloud engine and no key (it was cleared): step 2 asks for the key.
  {
    id: "home-cloud-no-key",
    state: true,
    shows: stepsAndList("a PC in daily use with the cloud engine and no key: the setup steps, with the recent dictations under them"),
    scenarios: ["populated"],
    sizes: STATE_SIZES,
    open: async (page) => {
      await page.evaluate(() => window.__MOCK__.keep({ settings: { engine: "cloud", groqApiKey: "" } }));
      await restart(page);
      await section(page, "home");
    },
    probe: async (page, run) => {
      const out = await historyStays(page, run, "home_reason_key");
      const step = await page.evaluate(() => [document.getElementById("setup-model").dataset.state, document.getElementById("setup-model-text").textContent, document.getElementById("setup-model-download").checkVisibility()]);
      out.push(...expect(step[0] === "todo" && step[1] === I18N[run.lang].setup_model_cloud_key && step[2], "step 2 asks for the cloud engine's key", JSON.stringify(step)));
      return out;
    },
    after: async (page) => {
      await page.evaluate(() => window.__MOCK__.keep({ settings: null }));
      await restart(page);
    },
  },
  // A click while the settings are still on their way (see `loadWindow`).
  {
    id: "settings-load-window",
    scenarios: ["populated"],
    sizes: [BEHAVIOUR],
    fresh: true,
    checks: false,
    open: (page) => settings(page, "dictation"),
    probe: (page, run) => (run.lang === "en" ? loadWindow(page) : []),
  },
  // The start with a slow backend, frame by frame (see `startSequence`).
  {
    id: "home-start",
    sizes: [BEHAVIOUR],
    fresh: true,
    checks: false,
    open: (page) => section(page, "home"),
    probe: startSequence,
  },
  // A save the backend refuses: the page's notice (at the bottom of the content area: `noticePlace`), and the control back on the saved value.
  state(
    "save-failed",
    async (page) => {
      await settings(page, "dictation");
      await awaitError(page, /saving the settings failed|Failed to toggle autostart/);
      await refuseSave(page);
      await page.click("#mode-toggle");
      await wait(page, 200);
    },
    {
      shows: onScreen("the notice of a save the backend refused, with its reason", () => {
        const notice = document.getElementById("save-notice");
        const now = { shown: notice.checkVisibility(), text: notice.textContent.trim(), inView: notice.getBoundingClientRect().top >= 0 };
        return (now.shown && now.inView && /Access is denied/.test(now.text)) || now;
      }),
      probe: async (page, run) => [...(await noticePlace(page)), ...(run.lang === "en" && run.size === BEHAVIOUR ? await saveFails(page) : [])],
      after: logged,
    },
  ),
  // A change of the Display Language (see `languageChange`).
  {
    id: "language-change",
    scenarios: ["populated"],
    sizes: [BEHAVIOUR],
    fresh: true,
    checks: false,
    open: (page) => section(page, "home"),
    probe: (page, run) => (run.lang === "en" ? languageChange(page) : []),
    after: restart,
  },
  // The speech model's row with "More" open: every model with its one line. On a new PC the row also says
  // which model is recommended for its graphics card.
  {
    id: "settings-models-list",
    state: true,
    shows: onScreen("the speech model's row with every model listed behind More", () => {
      const list = document.getElementById("model-more");
      const now = { tab: document.getElementById("panel-models").checkVisibility(), list: list.checkVisibility(), items: list.querySelectorAll(".model-list-item").length };
      return (now.tab && now.list && now.items === 8) || now;
    }),
    sizes: STATE_SIZES,
    open: async (page) => {
      await restart(page);
      await settings(page, "models");
      await page.click("#local-settings .hint-more");
      await wait(page, 150);
    },
    probe: modelList,
    after: restart,
  },
  // What has no page of its own: the pages' outlines, the links to "Keep history", the focus over the
  // 900 px step, user text with "$&", older answers that arrive last, a download after a reload.
  {
    id: "wave1",
    scenarios: ["populated"],
    sizes: [BEHAVIOUR],
    fresh: true,
    checks: false,
    open: (page) => section(page, "home"),
    probe: (page, run) => (run.lang === "en" ? wave1(page) : []),
    after: restart,
  },
  // A question of the start that never answers (see `startHangs`): five seconds, then the window goes on.
  {
    id: "start-hangs",
    scenarios: ["populated"],
    sizes: [BEHAVIOUR],
    fresh: true,
    checks: false,
    open: (page) => section(page, "home"),
    probe: (page, run) => (run.lang === "en" ? startHangs(page) : []),
    after: async (page) => {
      await page.evaluate(() => window.__MOCK__.keep({ hold: null }));
      await restart(page);
    },
  },
  // A Windows contrast theme: every control has an edge, every selected state shows (see `forcedColors`).
  {
    id: "forced-colors",
    scenarios: ["populated"],
    sizes: STATE_SIZES,
    fresh: true,
    checks: false,
    open: async (page) => {
      await page.emulateMedia({ forcedColors: "active" });
      await section(page, "home");
    },
    probe: forcedColors,
    after: (page) => page.emulateMedia({ forcedColors: null }),
  },
  // One left edge and one right edge on every page and in each of its forms, at the two most common large
  // sizes (`sameEdges`); and, once per run, the sweep of the steps that Home's and Settings' own sweeps do not
  // cover (`pagesHold`).
  {
    id: "edges",
    scenarios: ["populated"],
    sizes: ["1536x864", "1920x1080"],
    fresh: true,
    checks: false,
    open: (page) => section(page, "home"),
    probe: async (page, run) => [...(await sameEdges(page)), ...(run.lang === "en" && run.size === "1536x864" ? await pagesHold(run) : [])],
    after: async (page) => {
      await section(page, "soundboard");
      await panelAtRest(page);
    },
  },
  // Running text keeps its measure where the window is wide (see `measureProbe`). The last page of the main
  // window: it leaves the Soundboard without a cable and puts that back.
  {
    id: "measure",
    scenarios: ["populated"],
    sizes: ["1920x1080"],
    fresh: true,
    checks: false,
    open: (page) => section(page, "home"),
    probe: measureProbe,
    after: (page) => page.evaluate(() => window.__MOCK__.keep({ sb: null })),
  },
  {
    id: "popout",
    url: "/soundboard.html",
    scope: "body",
    sizes: ["460x680"],
    open: (page) => wait(page),
    probe: async (page) => {
      const see = await boardNow(page);
      return [
        ...expect(!see.panel && see.expanded === "false", "the pop-out opens on the sounds, its settings closed", JSON.stringify(see)),
        ...expect(see.switchShown, "the pop-out shows the virtual microphone's switch", JSON.stringify(see)),
        ...expect(see.firstSound >= 0 && see.firstSound < see.height, "the pop-out's first sound is on its first screen", JSON.stringify(see)),
        ...(await tiles(page)),
      ];
    },
  },
  {
    id: "popout-settings",
    url: "/soundboard.html",
    scope: "body",
    sizes: ["460x680"],
    fresh: true,
    open: async (page) => {
      await page.click('[data-key="settings"]');
      await page.click(".sb-devices > summary");
      await wait(page, 400);
    },
    probe: async (page) => {
      const see = await boardNow(page);
      return [
        ...expect(see.panel && see.controls && see.expanded === "true", "Soundboard settings opens the pop-out's panel", JSON.stringify(see)),
        ...expect(see.switchShown, "the pop-out's switch shows with the panel open", JSON.stringify(see)),
        ...(await panelMore(page)),
        ...(await panelByKeyboard(page)),
      ];
    },
    after: panelAtRest,
  },
  // The pop-out's hard states: the tiles are at their narrowest here (the volume has a line of its own), the
  // panel's rows are stacked. Taken keys, long combinations, a missing file, a sound that plays; then a tile's
  // key box that asks for its key, and every key box of the window in both states.
  {
    id: "popout-states",
    state: true,
    shows: onScreen("the pop-out with its panel open, taken keys, a missing file and a sound that plays", () => {
      const now = { notes: document.querySelectorAll(".sb-note").length, playing: document.querySelectorAll(".sb-row.playing").length, panel: !!document.getElementById("sb-panel") };
      return (now.notes === 4 && now.playing === 1 && now.panel) || now;
    }),
    url: "/soundboard.html",
    scope: "body",
    scenarios: ["populated"],
    sizes: ["460x680"],
    fresh: true,
    open: async (page) => {
      await page.click('[data-key="settings"]');
      await boardSays(page, hardBoard);
    },
    probe: tilesHold,
    after: panelAtRest,
  },
  {
    id: "popout-capture",
    state: true,
    shows: keyBoxShows("a sound's key box in the pop-out asks for its key", TILE_KEYS),
    url: "/soundboard.html",
    scope: "body",
    scenarios: ["populated"],
    sizes: ["460x680"],
    fresh: true,
    walk: false,
    open: (page) => listen(page, TILE_KEYS),
    probe: async (page) => {
      const out = [...(await tilesHold(page)), ...(await keyBoxes(page, TILE_KEYS, "body"))];
      await page.click('[data-key="settings"]');
      await boardSays(page, hardBoard);
      out.push(...(await keyBoxes(page, `${TILE_KEYS}, ${PANEL_KEYS}`, "body")));
      await page.click('[data-key="settings"]');
      await wait(page, 150);
      await listen(page, TILE_KEYS);
      return [...out, ...(await tilesHold(page))];
    },
    after: (page) => page.keyboard.press("Escape"),
  },
  pill("recording", `window.__overlayUpdate("recording"); for (let i = 0; i < 32; i++) window.__MOCK__.emit("audio-level", 0.15 + 0.7 * Math.abs(Math.sin(i * 0.7)));`, pillShows("records", "recording", null), async (page) => {
    // The resting pill has no font file to fetch for a first chip or label: its face is Windows' own.
    const see = await page.evaluate(() => [getComputedStyle(document.body).fontFamily, document.fonts.size]);
    return expect(see[0] === SYSTEM_FONT && see[1] === 0, "the pill writes in Windows' own Segoe UI and loads no font file", JSON.stringify(see));
  }),
  pill("transcribing", `window.__overlayUpdate("recording"); window.__overlayUpdate("transcribing"); window.__MOCK__.emit("partial-transcript", { text: "Could you send me the quote for the move by tomorrow", is_final: false });`, pillShows("transcribes and shows what was said", "transcribing", "transcript-text"), async (page) => [...(await pillOneLine(page)), ...(await pillOutline(page, "transcript"))]),
  // A dictation of three sentences, segment by segment: the pill shows the end of what was said.
  pill("segments", `window.__overlayUpdate("recording"); window.__overlayUpdate("transcribing");`, pillShows("transcribes", "transcribing", null), async (page) => [...(await pillSegments(page)), ...(await pillOneLine(page))]),
  pill("notice", `window.__MOCK__.emit("gpu-notice", "freed");`, pillShows("shows a notice", "notice", "notice"), async (page) => {
    // The pill speaks the Display Language, not Windows' language.
    const out = await pillOutline(page, "notice");
    const lang = await page.evaluate(() => window.__MOCK_CFG__.lang);
    const text = () => page.evaluate(() => document.getElementById("notice").textContent);
    out.push(...expect((await text()) === (lang === "de" ? "GPU freigegeben" : "GPU freed"), "the pill's notice is in the Display Language", await text()));
    await page.evaluate(() => {
      window.__MOCK__.emit("ui-language", "de");
      window.__MOCK__.emit("gpu-notice", "loaded");
    });
    await wait(page, 150);
    out.push(...expect((await text()) === "Modelle geladen", "the pill follows a change of the Display Language", await text()));
    out.push(...expect((await page.evaluate(() => document.documentElement.lang)) === "de", "the pill's document says which language it is in", await page.evaluate(() => document.documentElement.lang)));
    return out;
  }),
  pill("no-model", `window.__MOCK__.emit("speech-notice", "no_model");`, pillShows("says that there is no speech model", "notice", "notice"), async (page) => {
    const fits = await page.evaluate(() => {
      const n = document.getElementById("notice");
      return [n.textContent.length > 20, n.scrollWidth <= n.clientWidth, n.scrollHeight <= n.clientHeight];
    });
    return expect(fits.every(Boolean), "the no-model notice shows and fits the pill", JSON.stringify(fits));
  }),
  pill(
    "meeting-dot",
    `window.__meetingDot(true);`,
    onScreen("the pill shows the red dot of a meeting that records", () => (document.body.dataset.meeting === "1" && document.getElementById("meeting-dot").checkVisibility()) || { meeting: document.body.dataset.meeting ?? "" }),
  ),
  // Edit mode: the chip that says how many selected words the dictation changes (three digits: the widest it gets).
  pill("edit", `window.__overlayUpdate("recording"); window.__MOCK__.emit("edit-target", 128); for (let i = 0; i < 32; i++) window.__MOCK__.emit("audio-level", 0.15 + 0.7 * Math.abs(Math.sin(i * 0.7)));`, pillShows("records in Edit mode, with the chip of the selected words", "recording", "edit-chip", true), async (page) => {
    const see = await page.evaluate(() => {
      const pill = document.getElementById("pill").getBoundingClientRect();
      const inside = (id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return r.width > 0 && r.left >= pill.left && r.right <= pill.right;
      };
      return { chip: document.getElementById("edit-chip").textContent, chipIn: inside("edit-chip"), cancelIn: inside("cancel"), bars: Math.round(document.getElementById("waveform").getBoundingClientRect().width) };
    });
    return [...expect(/128/.test(see.chip) && see.chipIn && see.cancelIn && see.bars >= 60, "the pill's edit chip, its bars and its cancel button all stand inside the pill", JSON.stringify(see)), ...(await wholeBars(page))];
  }),
  // AI cleanup works on the text: the label of what it does, and the text; in Edit mode the label says so.
  pill("polishing", `window.__overlayUpdate("recording"); window.__overlayUpdate("transcribing"); window.__MOCK__.emit("partial-transcript", { text: "Could you send me the quote for the move by tomorrow noon", is_final: true }); window.__overlayUpdate("polishing");`, pillPolishes("polishes: the label and the text", false), async (page) => {
    // The text is done: the label, and the text from its start, ending in an ellipsis where the line ends.
    const see = await page.evaluate(() => {
      const line = document.querySelector("#transcript .transcript-line");
      const text = document.getElementById("transcript-text").getBoundingClientRect();
      return { startsIn: text.left >= line.getBoundingClientRect().left - 0.5, longer: line.scrollWidth > line.clientWidth, ellipsis: getComputedStyle(line).textOverflow, label: getComputedStyle(document.getElementById("transcript"), "::before").content };
    });
    return [...expect(see.startsIn && see.longer && see.ellipsis === "ellipsis" && see.label.length > 4, "while it polishes the pill shows its label and the text from its start, ending in an ellipsis", JSON.stringify(see)), ...(await pillOneLine(page))];
  }),
  pill("editing", `window.__overlayUpdate("recording"); window.__MOCK__.emit("edit-target", 128); window.__overlayUpdate("transcribing"); window.__MOCK__.emit("partial-transcript", { text: "shorter and more formal please", is_final: true }); window.__overlayUpdate("polishing");`, pillPolishes("polishes an edit: the label and what was asked for", true), async (page) => {
    const phase = await page.evaluate(() => document.getElementById("transcript").dataset.phase);
    const lang = await page.evaluate(() => window.__MOCK_CFG__.lang);
    return [...expect(phase === (lang === "de" ? "Bearbeiten" : "Editing"), "while an edit is polished the pill's label says Editing", phase), ...(await pillOneLine(page))];
  }),
  // Every notice the pill can show, in the Display Language: each fits the pill in at most two lines.
  pill("notices", `window.__MOCK__.emit("gpu-notice", "failed");`, pillShows("shows a notice", "notice", "notice"), async (page) => {
    const notices = [
      ["audio-empty", null],
      ["speech-notice", "no_model"],
      ["edit-game", null],
      ["edit-failed", null],
      ["mic-error", { missing: false, name: "" }],
      ["mic-error", { missing: true, name: "" }],
      ["mic-error", { missing: true, name: "Headset Microphone (Logitech PRO X)" }],
      ...["missing", "needs-ai", "game"].map((why) => ["rewrite-failed", why]),
      ...["freed", "loading", "loaded", "failed"].map((what) => ["gpu-notice", what]),
      ...["hotkeys-off", "hotkeys-on"].map((what) => ["soundboard-notice", what]),
      ...["limit", "no_model", "disk_full", "pc_check", "other"].map((why) => ["meeting-notice", why]),
    ];
    const out = [];
    const bad = [];
    for (const [event, payload] of notices) {
      await page.evaluate(([event, payload]) => window.__MOCK__.emit(event, payload), [event, payload]);
      await wait(page, 30);
      const see = await page.evaluate(() => {
        const n = document.getElementById("notice");
        const box = n.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(n);
        const lines = [...new Set([...range.getClientRects()].map((r) => Math.round(r.top)))];
        const rects = [...range.getClientRects()];
        return { text: n.textContent, shown: document.body.dataset.state === "notice", lines: lines.length, inside: rects.every((r) => r.left >= box.left + 12 && r.right <= box.right - 12 && r.top >= box.top && r.bottom <= box.bottom) };
      });
      if (!(see.shown && see.text.length > 5 && see.lines <= 2 && see.inside)) bad.push(`${event} ${JSON.stringify(payload)}: ${JSON.stringify(see)}`);
    }
    out.push(...expect(bad.length === 0, `each of the pill's ${notices.length} notices shows and fits it in at most two lines`, bad.join("; ")));
    return out;
  }),
];

/** Text that is the user's own and may be cut with an ellipsis. */
export const USER_TEXT = [".file-name", ".mt-item-title", ".mt-item-meta", ".mt-bar-title", ".mt-view-title", ".sb-name", ".history-text", ".history-parts", ".unused-model-name", "body > .transcript"];
