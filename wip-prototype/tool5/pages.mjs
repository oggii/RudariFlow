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
  pill("notice", `window.__MOCK__.emit("gpu-notice", "freed");`),
  pill("meeting-dot", `window.__meetingDot(true);`),
];

/** Text that is the user's own and may be cut with an ellipsis. */
export const USER_TEXT = [".file-name", ".mt-item-title", ".mt-item-meta", ".mt-bar-title", ".mt-view-title", ".sb-name", ".history-text", ".unused-model-name"];
