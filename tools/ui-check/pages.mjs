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

/** A new start of the page on Home, as the first run finds it (the mock forgets what was downloaded). */
async function again(page) {
  await page.reload({ waitUntil: "networkidle" });
  await wait(page, 500);
  await section(page, "home");
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
  out.push(...expect(!(await shows(page, "home-notice")), "the notice goes when the model's state is good again"));
  return out;
}

/** The first run on Home, walked through as a new user would (and as the backend can interrupt it). */
async function firstRun(page, run) {
  const out = [];
  const de = run.lang === "de";
  const once = run.size === "1600x900"; // what does not depend on the window's size
  const slow = once && !de; // what takes seconds: once per run

  // ── The steps instead of the daily view; what is done looks done; one thing to do. ──
  out.push(...expect((await shows(page, "home-setup")) && !(await shows(page, "home-daily")), "the first run shows the setup steps"));
  let now = await stepsNow(page);
  out.push(...expect(now.states === "done,todo,done" && now.marks === "✓2✓", "the microphone and the key are done, the speech model is to do", JSON.stringify(now)));
  out.push(...expect(now.primary.join() === "setup-model-download" && !now.resting, "Download is the page's one primary button", JSON.stringify(now.primary)));
  out.push(...expect(/RTX 5080/.test(now.model) && /Large\sv3\sTurbo\sq8\s\(~870\sMB\)$/.test(now.model), "the speech model is the one for this PC's graphics card, named with its size", now.model));
  out.push(...expect(/Realtek/.test(now.mic) && now.meter && !now.retry, "the microphone is named and has its level", JSON.stringify(now)));
  const card = await page.evaluate(() => [document.getElementById("home-ai-card").checkVisibility(), document.getElementById("setup-ai-text").textContent]);
  out.push(...expect(card[0] && /Gemma\s4\sE4B, 5\.0\sGB/.test(card[1]), "the optional AI cleanup card names its model and size", JSON.stringify(card)));

  // ── The microphone is open while the steps are on screen in a window that shows, and only then. ──
  let mic = await micOpen(page);
  out.push(...expect(mic.ok, "the setup listens to the microphone", mic.log));
  const level = await page.evaluate(() => {
    window.__MOCK__.emit("mic-level", 0.5);
    return [document.getElementById("setup-level-fill").style.width, document.getElementById("setup-level").getAttribute("aria-valuenow")];
  });
  out.push(...expect(level[0] === "50%" && level[1] === "50", "the level bar follows the microphone", JSON.stringify(level)));
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
  const startsBefore = (await meterLog(page)).calls.filter((c) => c === "start").length;
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
  const startsAdded = (await meterLog(page)).calls.filter((c) => c === "start").length - startsBefore;
  out.push(...expect(mic.ok && startsAdded === 2, "after start, stop, start in quick succession the microphone is open, by the second start", `${mic.log}, ${startsAdded} starts`));
  await page.evaluate(() => {
    window.__MOCK__.meter.delay = 0;
    document.querySelector('.nav-item[data-section="files"]').click();
  });
  mic = await micClosed(page);
  out.push(...expect(mic.ok, "and it is closed again when Home is left: an overtaken start's late answer changes nothing", mic.log));
  await section(page, "home");

  if (slow) {
    // The backend's two-minute limit closes the microphone without a word: the page starts it again.
    await micOpen(page);
    let starts = (await meterLog(page)).calls.filter((c) => c === "start").length;
    await page.evaluate(() => window.__MOCK__.meter.timeOut());
    mic = await micOpen(page, 9000);
    out.push(...expect(mic.ok && (await meterLog(page)).calls.filter((c) => c === "start").length === starts + 1, "the level that fell silent (the backend's time limit) is started again, once", mic.log));
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
    // The microphone is unplugged and Windows has no other: said in words beside the step, with a way to try again.
    await awaitError(page, /the microphone meter did not start/);
    await page.evaluate(() => {
      window.__MOCK__.meter.fail = "No input device found";
      window.__MOCK__.meter.lose();
    });
    await until(page, () => document.getElementById("setup-mic").dataset.state === "problem", 9000);
    now = await stepsNow(page);
    starts = (await meterLog(page)).calls.filter((c) => c === "start").length;
    await wait(page, 3000);
    const later = (await meterLog(page)).calls.filter((c) => c === "start").length;
    const tries = await logged(page);
    out.push(...expect(now.states === "problem,todo,done" && now.retry && !now.meter && now.mic.length > 30 && later === starts && tries === 1, "a microphone that does not open is said beside its step, with Retry, and is not tried over and over", JSON.stringify({ ...now, starts, later, tries })));
    out.push(...expect(now.primary.join() === "setup-model-download", "Download stays the one primary button beside a microphone that failed", JSON.stringify(now.primary)));
    await page.evaluate(() => (window.__MOCK__.meter.fail = null));
    await page.click("#setup-mic-retry");
    mic = await micOpen(page);
    now = await stepsNow(page);
    out.push(...expect(mic.ok && now.states === "done,todo,done" && now.meter && !now.retry, "Retry opens the microphone again", JSON.stringify({ mic, now })));
  }

  if (once) {
    // Another microphone, chosen in place: saved first, then the meter opens it.
    await page.click("#setup-mic-change");
    const picking = await page.evaluate(() => [document.activeElement.id, document.getElementById("setup-mic-change").checkVisibility(), document.getElementById("setup-mic-select").options.length]);
    out.push(...expect(picking[0] === "setup-mic-select" && !picking[1] && picking[2] === 2, "Change shows the microphones in place and gives the list the focus", JSON.stringify(picking)));
    await page.selectOption("#setup-mic-select", { index: 1 });
    await wait(page, 200);
    const chosen = await page.evaluate(() => {
      const calls = window.__MOCK__.calls.map((c) => c.cmd);
      return [window.__MOCK__.settings().microphone, document.getElementById("mic-select").value, calls.lastIndexOf("save_settings") < calls.lastIndexOf("mic_meter_start"), window.__MOCK__.meter.open];
    });
    out.push(...expect(chosen[0] === "Microphone (Realtek(R) Audio)" && chosen[1] === chosen[0] && chosen[2] && chosen[3], "a microphone chosen in the step is saved, and the level is that microphone's", JSON.stringify(chosen)));
    // The dictation key, changed in place by the capture every key has; Settings shows the same key.
    await page.click("#setup-key-change");
    await wait(page, 80);
    const listening = await page.evaluate(() => document.getElementById("setup-hotkey-btn").classList.contains("capturing"));
    await page.keyboard.press("Control+Alt+KeyD");
    await wait(page, 200);
    const keys = await page.evaluate(() => [document.getElementById("setup-hotkey-text").textContent, document.getElementById("hotkey-text").textContent, document.getElementById("home-hotkey-text").textContent]);
    out.push(...expect(listening && keys.every((k) => k === "Ctrl+Alt+D"), "the dictation key is changed in the step and shows in Settings and on Home", JSON.stringify([listening, keys])));

    // No microphone: said beside step 1 with a way to look again; nothing is opened; Download stays the thing to do.
    await page.evaluate(() => window.__MOCK__.keep({ mics: [] }));
    await again(page);
    now = await stepsNow(page);
    let log = await meterLog(page);
    out.push(...expect(now.states === "problem,todo,done" && now.retry && !now.meter && now.mic.length > 30 && log.calls.length === 0 && !log.open, "without a microphone step 1 says so, offers to look again and opens nothing", JSON.stringify({ ...now, log })));
    out.push(...expect(now.primary.join() === "setup-model-download", "Download stays the one primary button without a microphone", JSON.stringify(now.primary)));
    if (slow) {
      // One that is plugged in shows up by itself.
      await page.evaluate(() => window.__MOCK__.keep({ mics: null }));
      const found = await until(page, () => document.getElementById("setup-mic").dataset.state === "done", 6000);
      out.push(...expect(found && (await micOpen(page)).ok, "a microphone that is plugged in shows up in the step by itself"));
      await page.evaluate(() => window.__MOCK__.keep({ mics: [] }));
      await again(page);
    }
    await page.evaluate(() => window.__MOCK__.keep({ mics: null }));
    await page.click("#setup-mic-retry");
    mic = await micOpen(page);
    now = await stepsNow(page);
    out.push(...expect(mic.ok && now.states === "done,todo,done" && now.meter && !now.retry, "Check again finds the microphone that was plugged in", JSON.stringify({ mic, now })));

    // The cloud engine: step 2 asks for its key and leads to the field; with the key the setup is done.
    await settings(page, "models");
    await page.evaluate(() => document.getElementById("engine-cloud").click());
    await wait(page, 200);
    await section(page, "home");
    now = await stepsNow(page);
    out.push(...expect(now.states === "done,todo,done" && /Groq/.test(now.model) && now.primary.join() === "setup-model-download" && !/Welcome|Willkommen/.test(now.title), "with the cloud engine step 2 asks for the API key", JSON.stringify(now)));
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
    await again(page);
    await settings(page, "models");
    await noteStatuses(page);
    await page.click("#download-btn");
    await until(page, () => document.getElementById("status-indicator").dataset.kind === "downloading");
    out.push(...(await downloadToReady(page, "Download in Settings")));
    await again(page);
  }

  // ── The speech model: Download, percent and size, a failure in words with Retry, then the daily view. ──
  await page.click("#setup-model-download");
  await until(page, () => window.__MOCK__.calls.some((c) => c.cmd === "download_model"));
  const asked = await page.evaluate(() => window.__MOCK__.calls.find((c) => c.cmd === "download_model")?.args.modelSize);
  out.push(...expect(asked === "large-v3-turbo-q8_0", "Download fetches the model suggested for the graphics card", String(asked)));
  await page.evaluate(() => window.__MOCK__.emit("download-progress", { downloaded: 374e6, total: 870e6, percent: 43 }));
  await wait(page, 150);
  now = await stepsNow(page);
  out.push(...expect(/^43 % · 374 MB (of|von) 870 MB$/.test(now.numbers) && now.bar, "a download shows percent and size", now.numbers));
  out.push(...expect(now.resting && now.focus === "setup-model-download" && now.primary.length === 0 && now.states === "done,todo,done", "while it downloads the button rests, keeps the focus, and nothing else asks to be pressed", JSON.stringify(now)));
  out.push(...expect(/^downloading: .* 43 %$/.test(await statusNow(page)), "the status shows the first model's download", await statusNow(page)));
  // The connection breaks.
  await awaitError(page, /Download failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("speech", "error sending request"));
  await until(page, () => document.getElementById("setup-model").dataset.state === "problem");
  out.push(...expect((await logged(page)) === 1, "the failed download is written to the log once"));
  now = await stepsNow(page);
  out.push(...expect(now.states === "done,problem,done" && now.model.length > 40 && !now.bar && !now.resting && now.primary.join() === "setup-model-download" && /^setup/.test(await statusNow(page)), "a download that fails is said beside its step, and the button is the way to try again", JSON.stringify(now)));
  out.push(...expect(now.button === (de ? "Wiederholen" : "Retry"), "the button reads Retry after a failed download", now.button));
  // Again, to the end: every status from the click to Ready.
  await noteStatuses(page);
  await page.click("#setup-model-download");
  await until(page, () => document.getElementById("status-indicator").dataset.kind === "downloading");
  out.push(...(await downloadToReady(page, "the first run's Download")));
  // Home is the daily view now, without a new start; the optional card stays; the microphone is closed.
  const done = await page.evaluate(() => ({
    daily: document.getElementById("home-daily").checkVisibility(),
    steps: document.getElementById("home-setup").checkVisibility(),
    card: document.getElementById("home-ai-card").checkVisibility(),
    focus: document.activeElement?.id ?? "",
    title: document.getElementById("home-title").textContent,
    how: document.getElementById("home-how").checkVisibility(),
    saved: window.__MOCK__.settings().whisperModel,
  }));
  out.push(...expect(done.daily && !done.steps && done.card && done.how && done.saved === "large-v3-turbo-q8_0", "once the model is there Home is the daily view, and the optional card stays", JSON.stringify(done)));
  out.push(...expect(done.focus === "home-title" && !/Welcome|Willkommen/.test(done.title), "the focus the steps had is on Home's heading, which is the daily one", JSON.stringify(done)));
  mic = await micClosed(page);
  out.push(...expect(mic.ok, "the setup is done: the microphone is closed", mic.log));
  await wait(page, 1300);
  const after = await meterLog(page);
  out.push(...expect(!after.open && after.calls.at(-1) === "stop", "and it stays closed", JSON.stringify(after.calls.slice(-4))));

  // ── The optional card: Download with percent and size, a failure with Retry, then AI cleanup is on. ──
  await page.click("#setup-ai-download");
  await until(page, () => window.__MOCK__.calls.some((c) => c.cmd === "ai_download_model"));
  const aiAsked = await page.evaluate(() => window.__MOCK__.calls.find((c) => c.cmd === "ai_download_model")?.args.id);
  out.push(...expect(aiAsked === "gemma-4-e4b", "the card downloads the AI model suggested for the graphics card", String(aiAsked)));
  await page.evaluate(() => window.__MOCK__.emit("ai-download-progress", { downloaded: 1.2e9, total: 4977171584, percent: 24.1 }));
  await wait(page, 150);
  let ai = await page.evaluate(() => [document.getElementById("setup-ai-numbers").textContent, document.getElementById("setup-ai-download").getAttribute("aria-disabled"), document.activeElement?.id]);
  out.push(...expect(/^24 % · 1\.2 GB (of|von) 5\.0 GB$/.test(ai[0]) && ai[1] === "true" && ai[2] === "setup-ai-download", "the AI model's download shows percent and size, and its button rests", JSON.stringify(ai)));
  await awaitError(page, /ai_download_model failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("ai", "error sending request"));
  await until(page, () => document.getElementById("setup-ai-text").dataset.tone === "warn");
  out.push(...expect((await logged(page)) === 1, "the failed AI download is written to the log once"));
  ai = await page.evaluate(() => [document.getElementById("setup-ai-text").dataset.tone, document.getElementById("setup-ai-download").textContent, document.getElementById("setup-ai-progress").checkVisibility(), document.getElementById("home-ai-card").checkVisibility()]);
  out.push(...expect(ai[0] === "warn" && ai[1] === (de ? "Wiederholen" : "Retry") && !ai[2] && ai[3], "an AI download that fails is said on the card, with Retry", JSON.stringify(ai)));
  await page.click("#setup-ai-download");
  await until(page, () => window.__MOCK__.calls.filter((c) => c.cmd === "ai_download_model").length === 2);
  await page.evaluate(() => window.__MOCK__.finishDownload("ai"));
  await until(page, () => !document.getElementById("home-ai-card").checkVisibility() && window.__MOCK__.settings().aiCleanup);
  const on = await page.evaluate(() => [document.getElementById("home-ai-card").checkVisibility(), window.__MOCK__.settings().aiCleanup, window.__MOCK__.settings().aiModel, document.getElementById("home-ai-toggle").checked, document.activeElement?.id]);
  out.push(...expect(!on[0] && on[1] === true && on[2] === "gemma-4-e4b" && on[3] && on[4] === "home-title", "with its model the card goes and AI cleanup is on", JSON.stringify(on)));

  // ── "Not now" closes the card, and it stays closed after a new start. ──
  await again(page);
  out.push(...expect(await shows(page, "home-ai-card"), "a new first run shows the optional card again"));
  await page.click("#setup-ai-dismiss");
  await wait(page, 100);
  const gone = [await shows(page, "home-ai-card"), await shows(page, "home-setup")];
  await again(page);
  out.push(...expect(!gone[0] && gone[1] && !(await shows(page, "home-ai-card")) && (await shows(page, "home-setup")), "Not now closes the card for good, and the steps stay", JSON.stringify(gone)));

  // A speech model that is there and does not load is no step: the notice, not the steps.
  out.push(...(await loadFailed(page)));

  // Every start of the microphone was matched: it is closed on another page, and the page's last word was "stop".
  await section(page, "files");
  mic = await micClosed(page);
  out.push(...expect(mic.ok, "at the end of the walk the microphone is closed", mic.log));

  // The picture is the first run as a new user finds it.
  await page.evaluate(() => localStorage.removeItem("rudariflow-ui"));
  await again(page);
  await until(page, () => window.__MOCK__.meter.open);
  return out;
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
      if (firstrun) return [...out, ...(await firstRun(page, run))];
      out.push(...expect((await shown("home-daily")) && !(await shown("home-setup")), "the daily view shows once the setup is done"));
      // No setup means no microphone held open, and no optional card when the AI model is there.
      const quiet = await page.evaluate(() => [window.__MOCK__.calls.some((c) => c.cmd === "mic_meter_start"), document.getElementById("home-ai-card").checkVisibility()]);
      out.push(...expect(!quiet[0] && !quiet[1], "the daily view opens no microphone and shows no setup card", JSON.stringify(quiet)));
      out.push(...(await loadFailed(page)));
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
      // The cloud engine without its key is a setup again: the Speech model line says what is missing, and
      // Home shows the steps, whose second one leads to the key (the daily view is hidden behind them).
      await page.evaluate(() => document.getElementById("engine-cloud").click());
      await wait(page, 200);
      const cloud = await page.evaluate(() => [document.getElementById("home-loaded-speech").textContent, document.getElementById("home-loaded-speech").dataset.tone]);
      const asks = [await shown("home-setup"), await shown("home-daily"), (await micOpen(page)).ok];
      await page.click("#setup-model-download");
      await wait(page);
      let landed = await page.evaluate(() => [document.activeElement.id, document.activeElement.checkVisibility()]);
      out.push(...expect(cloud[0].includes(" · ") && cloud[1] === "warn" && asks[0] && !asks[1] && asks[2] && landed[0] === "groq-key" && landed[1], "the cloud engine without its key: Home shows the steps, and the second one leads to the key field", JSON.stringify([cloud, asks, landed])));
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
