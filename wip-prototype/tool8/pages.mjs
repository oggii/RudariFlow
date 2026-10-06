// The pages and states the ui-check opens, and how it gets there.
//
//   id         name in the report and in the screenshot files
//   url        "/" the main window (default), "/soundboard.html" the pop-out,
//              "/src/overlay.html" the pill
//   scope      the part of the page the checks look at (default "#content")
//   scenarios  data sets it is opened with (default: "populated" and "firstrun")
//   sizes      window sizes (default: every size of run.mjs)
//   fresh      load the window again first (for a state that would stay)
//   open       brings the loaded window to the page or state
//   checks     false: screenshots only
//   skip       check ids that do not apply to this page
//   probe      extra findings: async (page) => [{ check, what, detail }]
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

/** The Dictionary tab: the searches, and the one way to delete. */
async function dictionaryProbe(page) {
  const out = [];
  if (await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun")) return out;
  const words = () => page.locator("#dict-list .dict-row").count();
  const saved = () => page.evaluate(() => window.__MOCK__.settings());
  const first = page.locator("#dict-list .dict-row [data-delete-id]").first();
  // Nothing deletes on a single click; Esc disarms; the second click deletes.
  await first.click();
  out.push(...expect((await words()) === 12 && (await first.getAttribute("class")).includes("armed"), "the first click on Delete only arms it"));
  // The suggestions are in the Display Language too.
  const add = await page.evaluate(() => [document.documentElement.lang, document.querySelector("#dict-suggest-list button").textContent]);
  out.push(...expect(add[1] === (add[0] === "de" ? "Hinzufügen" : "Add"), "the suggestions follow the Display Language", JSON.stringify(add)));
  await page.keyboard.press("Escape");
  out.push(...expect(!(await first.getAttribute("class")).includes("armed"), "Esc disarms Delete"));
  await first.click();
  await page.click("#dict-input");
  out.push(...expect(!(await first.getAttribute("class")).includes("armed") && (await words()) === 12, "a click elsewhere disarms Delete"));
  await first.click();
  await first.click();
  await wait(page, 150);
  out.push(...expect((await words()) === 11, "the second click deletes the word", String(await words())));
  // The word search ignores case and accents.
  await page.fill("#dict-search", "zurich");
  await wait(page, 100);
  out.push(...expect((await words()) === 1, "the word search finds Zürich for zurich", String(await words())));
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
  await del.click();
  await wait(page, 150);
  out.push(...expect((await saved()).replacements.length === 2, "the second click deletes the replacement"));
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
    probe: async (page) => {
      const out = [];
      const read = () => page.evaluate(() => ({ text: document.getElementById("status-text").textContent, tone: document.getElementById("status-indicator").dataset.tone, kind: document.getElementById("status-indicator").dataset.kind, marker: !document.getElementById("status-marker").classList.contains("hidden") }));
      const firstrun = await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun");
      const start = await read();
      out.push(...expect(start.kind === (firstrun ? "setup" : "ready"), "the status at the start", JSON.stringify(start)));
      if (firstrun) return out;
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
      await section(page, "home");
      return out;
    },
  },
  {
    id: "home",
    open: (page) => section(page, "home"),
    probe: async (page) => {
      const out = [];
      const firstrun = await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun");
      const shown = (id) => page.evaluate((id) => !document.getElementById(id).classList.contains("hidden"), id);
      if (firstrun) {
        // The first run: the steps instead of the daily view, the microphone's level, the suggested model.
        out.push(...expect((await shown("home-setup")) && !(await shown("home-daily")), "the first run shows the setup steps"));
        out.push(...expect(await page.evaluate(() => window.__MOCK__.calls.some((c) => c.cmd === "mic_meter_start")), "the setup listens to the microphone"));
        await page.evaluate(() => window.__MOCK__.emit("mic-level", 0.5));
        await wait(page, 150);
        out.push(...expect((await page.evaluate(() => document.getElementById("setup-level-fill").style.width)) === "50%", "the level bar follows the microphone"));
        await page.click("#setup-model-download");
        await wait(page, 200);
        const asked = await page.evaluate(() => window.__MOCK__.calls.find((c) => c.cmd === "download_model")?.args.modelSize);
        out.push(...expect(asked === "large-v3-turbo-q8_0", "Download fetches the model suggested for the graphics card", String(asked)));
        await page.evaluate(() => window.__MOCK__.emit("download-progress", { downloaded: 374e6, total: 870e6, percent: 43 }));
        await wait(page, 150);
        const numbers = await page.evaluate(() => document.getElementById("setup-model-numbers").textContent);
        out.push(...expect(/^43 % · 374 MB (of|von) 870 MB$/.test(numbers), "a download shows percent and size", numbers));
        // Leaving Home closes the microphone.
        await section(page, "files");
        out.push(...expect(await page.evaluate(() => window.__MOCK__.calls.some((c) => c.cmd === "mic_meter_stop")), "leaving Home stops the microphone meter"));
        await page.reload({ waitUntil: "networkidle" });
        await wait(page, 500);
        return out;
      }
      out.push(...expect((await shown("home-daily")) && !(await shown("home-setup")), "the daily view shows once the setup is done"));
      // One column: the recent dictations follow the quick switches; two columns: they are the right column.
      const wide = await page.evaluate(() => document.getElementById("content").clientWidth >= 900);
      const before = await page.evaluate(() => document.getElementById("home-recent").previousElementSibling?.id);
      out.push(...expect(before === (wide ? "home-controls" : "home-switches"), "the recent dictations are where the layout wants them", `${wide ? "wide" : "narrow"}: after #${before}`));
      // A quick switch and its setting are one value.
      await page.click("#home-ai-toggle", { force: true });
      await wait(page, 150);
      let both = await page.evaluate(() => [document.getElementById("ai-toggle").checked, window.__MOCK__.settings().aiCleanup]);
      out.push(...expect(both[0] === false && both[1] === false, "Home's AI cleanup switch changes the setting", JSON.stringify(both)));
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
      await page.fill("#history-search", "");
      await page.reload({ waitUntil: "networkidle" });
      await wait(page, 500);
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
      await page.click("#history-less");
      await wait(page, 150);
      out.push(...expect((await rows()) === 8, "Show fewer goes back to the newest few", String(await rows())));
      await page.click("#history-more");
      await wait(page);
      return out;
    },
  },
  { id: "files", open: (page) => section(page, "files") },
  { id: "meetings", open: (page) => section(page, "meetings") },
  {
    id: "soundboard",
    open: (page) => section(page, "soundboard"),
    // The sounds first: the panel is the left column with room, closed without; the switch always shows.
    probe: async (page) => {
      const out = [];
      const see = await page.evaluate(() => ({
        wide: document.getElementById("content").clientWidth >= 900,
        panel: !!document.getElementById("sb-panel"),
        expanded: document.querySelector('[data-key="settings"]').getAttribute("aria-expanded"),
        switchShown: !!document.querySelector('.sb-bar [data-key="enabled"]'),
        firstSound: Math.round(document.querySelector(".sb-row, .sb-list .empty-state").getBoundingClientRect().top),
        height: window.innerHeight,
      }));
      out.push(...expect(see.panel === see.wide && see.expanded === String(see.wide), "the settings panel is open only where it has its own column", JSON.stringify(see)));
      out.push(...expect(see.switchShown, "the virtual microphone's switch is always visible"));
      out.push(...expect(see.firstSound < see.height, "the first sound is on the first screen", JSON.stringify(see)));
      return out;
    },
  },
  {
    id: "soundboard-settings",
    fresh: true,
    // The other state of the panel: opened in a narrow window, closed in a wide one.
    open: async (page) => {
      await section(page, "soundboard");
      await page.click('[data-key="settings"]');
      await wait(page);
    },
    probe: async (page) => {
      const out = [];
      const wide = await page.evaluate(() => document.getElementById("content").clientWidth >= 900);
      out.push(...expect((await page.evaluate(() => !!document.getElementById("sb-panel"))) === !wide, "Soundboard settings opens and closes the panel"));
      // The choice is remembered for this layout; put it back for the pages that follow.
      await page.reload({ waitUntil: "networkidle" });
      await wait(page, 500);
      await section(page, "soundboard");
      out.push(...expect((await page.evaluate(() => !!document.getElementById("sb-panel"))) === !wide, "the panel's state is remembered"));
      await page.click('[data-key="settings"]');
      await wait(page);
      await page.click('[data-key="settings"]');
      await wait(page);
      return out;
    },
  },
  ...TABS.map((tab) => ({ id: `settings-${tab}`, open: (page) => settings(page, tab), probe: tab === "dictionary" ? dictionaryProbe : undefined })),
  // The same tabs with Advanced open (General has no fold).
  ...TABS.filter((tab) => tab !== "general").map((tab) => ({
    id: `settings-${tab}-advanced`,
    open: async (page) => {
      await settings(page, tab);
      await page.evaluate((t) => (document.querySelector(`details.fold[data-fold="${t}"]`).open = true), tab);
      await wait(page);
    },
    probe:
      tab !== "models"
        ? undefined
        : async (page) => {
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
            // The fold stays open over a new start.
            await page.reload({ waitUntil: "networkidle" });
            await wait(page, 500);
            const kept = await page.evaluate(() => [document.querySelector('details.fold[data-fold="models"]').open, document.querySelector('details.fold[data-fold="general"]') === null]);
            out.push(...expect(kept[0] === true, "an open Advanced fold is remembered", JSON.stringify(kept)));
            return out;
          },
  })),
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
    // With a file loaded the transcript starts on the first screen.
    probe: async (page) => {
      const at = await page.evaluate(() => [Math.round(document.getElementById("file-text").getBoundingClientRect().top), window.innerHeight]);
      return expect(at[0] < at[1], "the transcript starts on the first screen", `y ${at[0]} of ${at[1]}`);
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
      if (!(await page.evaluate(() => !!document.getElementById("sb-panel")))) await page.click('[data-key="settings"]');
      await page.click(".sb-devices > summary");
      await wait(page, 400);
    },
  },
  {
    id: "popout",
    url: "/soundboard.html",
    scope: "body",
    sizes: ["460x680"],
    open: (page) => wait(page),
    probe: async (page) => expect(!(await page.evaluate(() => !!document.getElementById("sb-panel"))), "the pop-out opens on the sounds, its settings closed"),
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
  },
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
