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
  { id: "home", open: (page) => section(page, "home") },
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
