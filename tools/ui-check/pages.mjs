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
//   skip       check ids that do not apply to this page
//   probe      extra findings: async (page, run) => [{ check, what, detail }];
//              run = { openWindow, scenario, lang, size }, openWindow as in
//              run.mjs (`scrollbars: true` draws them, as the app's window does)
//
// Pages with the same url share one window per data set, language and size,
// in this order; put a state that changes the window after the plain pages
// and mark it `fresh`.

const wait = (page, ms = 350) => page.waitForTimeout(ms);

/** Open a sidebar section. */
async function section(page, name) {
  await page.evaluate((s) => document.querySelector(`.nav-item[data-section="${s}"]`).click(), name);
  await wait(page);
}

/** Open a Settings tab. */
async function settings(page, tab) {
  await section(page, "settings");
  await page.evaluate((t) => document.getElementById(`tab-${t}`).click(), tab);
  await wait(page);
}

const TABS = ["dictation", "ai", "dictionary", "models", "general"];

/** What a probe reports when `ok` is false. */
const expect = (ok, what, detail = "") => (ok ? [] : [{ check: "behaviour", what, detail }]);

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

const pill = (id, script, probe) => ({
  id: `pill-${id}`,
  url: "/src/overlay.html",
  scope: "body",
  scenarios: ["populated"],
  sizes: ["320x64"],
  checks: false,
  fresh: true,
  open: async (page) => {
    // The real window is transparent over the desktop; mid-grey stands in for it.
    await page.addStyleTag({ content: "html{background:#5a5f66 !important}" });
    await page.evaluate(script);
    await wait(page);
  },
  probe,
});

export const PAGES = [
  {
    id: "shell",
    scope: "#sidebar",
    open: (page) => section(page, "home"),
    probe: async (page) => {
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
        await page.reload({ waitUntil: "networkidle" });
        await wait(page, 500);
        await section(page, "home");
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
      await page.reload({ waitUntil: "networkidle" });
      await wait(page, 500);
      const place = await page.evaluate(() => ({ nav: document.querySelector('.nav-item[aria-current="page"]')?.dataset.section, tab: document.querySelector('#settings-tabs [aria-selected="true"]')?.dataset.tab, shown: !document.getElementById("panel-general").hidden }));
      out.push(...expect(place.nav === "settings" && place.tab === "general" && place.shown, "the section and the tab are remembered", JSON.stringify(place)));
      // A window that opens on a remembered place tells the page that it is shown.
      // Settings > AI cleanup asks for the open apps (the rule suggestions), once.
      await settings(page, "ai");
      await page.reload({ waitUntil: "networkidle" });
      await wait(page, 500);
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
    // The two columns at their narrowest are measured too (German: "Schreiben in" beside its select).
    alsoSizes: ["1200x800"],
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
      if (firstrun) return out; // the first run: Task 5
      out.push(...expect(await shown("home-daily"), "Home shows the daily view"));
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
      // Every row is an item of the list, named after its text, and all rows have one shape.
      const rowsAre = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#history-list .history-item")];
        const beside = rows.map((row) => row.querySelector(".history-actions").getBoundingClientRect().top < row.querySelector(".history-meta").getBoundingClientRect().bottom - 1);
        return {
          list: document.getElementById("history-list").getAttribute("role"),
          named: rows.every((row) => row.getAttribute("role") === "listitem" && document.getElementById(row.getAttribute("aria-labelledby"))?.textContent === row.querySelector(".history-text").textContent),
          ids: new Set(rows.map((row) => row.getAttribute("aria-labelledby"))).size === rows.length,
          shapes: new Set(beside).size,
          // A part of the second line is never broken, and no line starts with the dot.
          parts: rows.every((row) => [...row.querySelectorAll(".history-part")].every((part) => part.getClientRects().length === 1)),
        };
      });
      out.push(...expect(rowsAre.list === "list" && rowsAre.named && rowsAre.ids, "every dictation is a list item named after its text", JSON.stringify(rowsAre)));
      out.push(...expect(rowsAre.shapes === 1, "the actions stand beside the text in every row or below it in every row", JSON.stringify(rowsAre)));
      out.push(...expect(rowsAre.parts, "no part of a row's second line is broken", JSON.stringify(rowsAre)));
      // A key that is not set: only "Set" is underlined, and while it listens it is the accent box of any key.
      const unset = await page.evaluate(() => {
        const key = document.getElementById("home-free-gpu-text");
        return [key.querySelector(".key-set")?.textContent ?? "", getComputedStyle(key).textDecorationLine, getComputedStyle(key.querySelector(".key-set")).textDecorationLine];
      });
      out.push(...expect(unset[0].length > 1 && unset[1] === "none" && unset[2] === "underline", "a key that is not set underlines only Set", JSON.stringify(unset)));
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
      await page.focus("#history-list .history-item:first-child .history-actions button:last-child");
      await page.keyboard.press("Enter");
      // From Task 7 on the first press only arms Delete.
      if (await page.evaluate(() => document.activeElement.classList.contains("armed"))) await page.keyboard.press("Enter");
      await wait(page, 200);
      const after = await page.evaluate(() => {
        const at = document.activeElement;
        return [document.querySelectorAll("#history-list .history-item").length, at.closest(".history-item")?.dataset.id ?? at.tagName, at === at.closest(".history-actions")?.firstElementChild];
      });
      out.push(...expect(after[0] === 7 && after[1] === second && after[2] === true, "after Delete from the keyboard the focus is on the next row's first action", JSON.stringify([...after, second])));
      // With the cloud engine the Speech model line says what is missing and leads to the key.
      await page.evaluate(() => document.getElementById("engine-cloud").click());
      await wait(page, 200);
      const cloud = await page.evaluate(() => [document.getElementById("home-loaded-speech").textContent, document.getElementById("home-loaded-speech").dataset.tone]);
      await page.click('#home-loaded [data-reveal="model-select"]');
      await wait(page);
      const landed = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
      out.push(...expect(cloud[0].includes(" · ") && cloud[1] === "warn" && landed[0] === "groq-key" && landed[1], "with the cloud engine the Speech model line leads to the key field", JSON.stringify([cloud, landed])));
      // The other two lines lead to a control that shows and has the focus.
      for (const id of ["ai-model-select", "mic-select"]) {
        await section(page, "home");
        await page.click(`#home-loaded [data-reveal="${id}"]`);
        await wait(page);
        const at = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
        out.push(...expect(at[0] === id && at[1], `the loaded card's line leads to #${id}`, JSON.stringify(at)));
      }
      // The layout's steps with the scrollbar drawn: once per run is enough.
      if (run.lang === "en" && run.size === "1600x900") out.push(...(await layoutHolds(run)));
      // A new start, and back from Settings (the window remembers the place): the screenshot is Home's.
      await page.reload({ waitUntil: "networkidle" });
      await wait(page, 500);
      await section(page, "home");
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
  { id: "files", open: (page) => section(page, "files") },
  { id: "meetings", open: (page) => section(page, "meetings") },
  { id: "soundboard", open: (page) => section(page, "soundboard") },
  ...TABS.map((tab) => ({ id: `settings-${tab}`, open: (page) => settings(page, tab) })),
  {
    id: "files-result",
    scenarios: ["populated"],
    fresh: true,
    open: async (page) => {
      await section(page, "files");
      await page.click("#file-choose");
      await wait(page, 500);
      await page.click("#file-summarize");
      await wait(page, 400);
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
    fresh: true,
    open: async (page) => {
      await section(page, "meetings");
      await page.evaluate(() => window.__MOCK__.emit("meeting-status", window.__MOCK__.meetingRecording()));
      await wait(page, 700);
    },
  },
  {
    id: "soundboard-devices",
    scenarios: ["populated"],
    fresh: true,
    open: async (page) => {
      await section(page, "soundboard");
      await page.click(".sb-devices > summary");
      await wait(page, 400);
    },
  },
  { id: "popout", url: "/soundboard.html", scope: "body", sizes: ["460x680"], open: (page) => wait(page) },
  pill("recording", `window.__overlayUpdate("recording"); for (let i = 0; i < 32; i++) window.__MOCK__.emit("audio-level", 0.15 + 0.7 * Math.abs(Math.sin(i * 0.7)));`),
  pill("transcribing", `window.__overlayUpdate("recording"); window.__overlayUpdate("transcribing"); window.__MOCK__.emit("partial-transcript", { text: "Could you send me the quote for the move by tomorrow", is_final: false });`),
  pill("notice", `window.__MOCK__.emit("gpu-notice", "freed");`, async (page) => {
    // The pill speaks the Display Language, not Windows' language.
    const out = [];
    const lang = await page.evaluate(() => window.__MOCK_CFG__.lang);
    const text = () => page.evaluate(() => document.getElementById("notice").textContent);
    out.push(...expect((await text()) === (lang === "de" ? "GPU freigegeben" : "GPU freed"), "the pill's notice is in the Display Language", await text()));
    await page.evaluate(() => {
      window.__MOCK__.emit("ui-language", "de");
      window.__MOCK__.emit("gpu-notice", "loaded");
    });
    await wait(page, 150);
    out.push(...expect((await text()) === "Modelle geladen", "the pill follows a change of the Display Language", await text()));
    return out;
  }),
  pill("no-model", `window.__MOCK__.emit("speech-notice", "no_model");`, async (page) => {
    const fits = await page.evaluate(() => {
      const n = document.getElementById("notice");
      return [n.textContent.length > 20, n.scrollWidth <= n.clientWidth, n.scrollHeight <= n.clientHeight];
    });
    return expect(fits.every(Boolean), "the no-model notice shows and fits the pill", JSON.stringify(fits));
  }),
  pill("meeting-dot", `window.__meetingDot(true);`),
];

/** Text that is the user's own and may be cut with an ellipsis. */
export const USER_TEXT = [".file-name", ".mt-item-title", ".mt-item-meta", ".mt-bar-title", ".mt-view-title", ".sb-name", ".history-text", ".unused-model-name"];
