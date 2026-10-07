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
 * The page has started: the status is known and Home is wired (asking for the graphics cards is the last
 * thing it does, after the settings, the microphones and the first status), and its fonts are in.
 */
async function started(page) {
  await until(page, () => !!document.getElementById("status-indicator").dataset.kind && window.__MOCK__.calls.some((c) => c.cmd === "detect_gpus"), 10_000);
  await page.evaluate(async () => {
    document.body.getBoundingClientRect(); // laid out, so every font the page uses is asked for
    await document.fonts.ready;
  });
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
  const once = run.size === "1600x900"; // what does not depend on the window's size
  const slow = once && !de; // what takes seconds: once per run
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
  // The window stands open beside other work and is not the one in front: a pointer that crosses it is no use of it.
  await page.evaluate(() => (document.hasFocus = () => false));
  await page.mouse.move(400, 300);
  await page.mouse.move(410, 310);
  await wait(page, 300);
  const crossed = await levelNow(page);
  await page.evaluate(() => delete document.hasFocus);
  out.push(...expect(crossed.starts === 0 && !crossed.open && crossed.rests, "a pointer that moves over a window without the focus opens no microphone", JSON.stringify(crossed)));
  // The first touch brings the level, without a click.
  await page.mouse.move(420, 320);
  let mic = await micOpen(page);
  level = await levelNow(page);
  out.push(...expect(mic.ok && level.bar && !level.rests && level.height === atRest, "the first touch of the window starts the level, without a click, and the step keeps its height", JSON.stringify({ mic, level, atRest })));
  await place("the level runs");
  await present(page);
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

  if (once) {
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
  await page.click("#setup-mic-retry");
  mic = await micOpen(page);
  now = await stepsNow(page);
  out.push(...expect(mic.ok && now.states === "done,todo,done" && now.meter && !now.retry, "Check again finds the microphone that was plugged in", JSON.stringify({ mic, now })));
  out.push(...expect(now.focus === "setup-mic-change", "Check again goes when it has found one: the keyboard focus it had is on Change", now.focus));

  if (once) {
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
  await wait(page, 1300);
  const after = await meterLog(page);
  out.push(...expect(!after.open && after.calls.at(-1) === "stop", "and it stays closed", JSON.stringify(after.calls.slice(-4))));

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
  if (flat.width >= 1200) out.push(...expect(flat.height <= 60 && flat.right, "from 1200 px of window the optional card is flat: its text at the left, its buttons at the right", JSON.stringify(flat)));
  if (flat.width >= 1600) out.push(...expect(flat.oneLine && flat.height <= 52 && flat.over === 0, "in a large window the optional card is one line, and the daily view does not scroll because of it", JSON.stringify(flat)));
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
  out.push(...expect(/turns on|schaltet sich nach dem Download ein/.test(says[0]) && says[1] === (de ? "Ausblenden" : "Hide") && says[2] === "downloading" && / 24 %$/.test(says[3]), "while its download runs the card says that AI cleanup turns on at the end and offers to hide it, and the status shows the download", JSON.stringify(says)));
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
  await until(page, () => document.getElementById("setup-ai-text").dataset.tone === "warn");
  out.push(...expect((await logged(page)) === 1, "the failed AI download is written to the log once"));
  ai = await page.evaluate(() => [document.getElementById("setup-ai-text").dataset.tone, document.getElementById("setup-ai-download").textContent, document.getElementById("setup-ai-progress").checkVisibility(), document.getElementById("home-ai-card").checkVisibility(), document.getElementById("setup-ai-text").textContent, document.getElementById("setup-ai-dismiss").textContent, document.activeElement?.id]);
  out.push(...expect(ai[0] === "warn" && ai[1] === (de ? "Wiederholen" : "Retry") && !ai[2] && ai[3] && /Gemma\s4\sE4B\s\(5\.0\sGB\)/.test(ai[4]) && ai[5] === (de ? "Jetzt nicht" : "Not now") && ai[6] === "setup-ai-download", "an AI download that fails is said on the card, with the model, its size and Retry, which keeps the focus", JSON.stringify(ai)));
  stands.failed = await cardNow();
  out.push(...expect(stands.downloads === stands.rests && stands.failed === stands.rests, "the optional card has one height, one place for its text and its button, and the daily view under it stays where it is, while it rests, downloads and after a failure", JSON.stringify(stands)));
  await page.click("#setup-ai-download");
  await until(page, () => window.__MOCK__.calls.filter((c) => c.cmd === "ai_download_model").length === 2);
  await page.evaluate(() => window.__MOCK__.finishDownload("ai"));
  await until(page, () => !document.getElementById("home-ai-card").checkVisibility() && window.__MOCK__.settings().aiCleanup);
  const on = await page.evaluate(() => [document.getElementById("home-ai-card").checkVisibility(), window.__MOCK__.settings().aiCleanup, window.__MOCK__.settings().aiModel, document.getElementById("home-ai-toggle").checked, document.activeElement?.id]);
  out.push(...expect(!on[0] && on[1] === true && on[2] === "gemma-4-e4b" && on[3] && on[4] === "home-title", "with its model the card goes and AI cleanup is on", JSON.stringify(on)));

  // ── "Not now" closes the card, and it stays closed after a new start. ──
  await fresh();
  out.push(...expect(await shows(page, "home-ai-card"), "a new first run shows the optional card again"));
  await page.click("#setup-ai-dismiss");
  await wait(page, 100);
  const gone = [await shows(page, "home-ai-card"), await shows(page, "home-setup"), await page.evaluate(() => document.activeElement?.id ?? "")];
  await fresh();
  out.push(...expect(!gone[0] && gone[1] && !(await shows(page, "home-ai-card")) && (await shows(page, "home-setup")), "Not now closes the card for good, and the steps stay", JSON.stringify(gone)));
  out.push(...expect(gone[2] === "home-title", "the focus Not now had is on Home's heading", gone[2]));
  if (once) {
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
  }

  // A speech model that is there and does not load is no step: the notice, not the steps.
  out.push(...(await loadFailed(page)));

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
/** At most two texts per live region of Settings (the start and the end), and no number in what the sidebar says. */
const liveOk = (noted) => Object.values(noted.settings).every((texts) => texts.length <= 2) && noted.status.every((text) => !/\d/.test(text));

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
async function speechDownload(page) {
  const out = [];
  const firstrun = await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun");
  const saved = () => page.evaluate(() => window.__MOCK__.settings().whisperModel);
  const before = await saved();
  // Downloading: the bar and "43 % · 32 MB of 75 MB" on the row.
  let now = await downloadNow(page, SPEECH_ROW);
  out.push(...expect(barOk(now, firstrun ? /^43 % · 200 MB \S+ 466 MB$/ : /^43 % · 32 MB \S+ 75 MB$/, /^43 %, \d+ MB \S+ \d+ MB$/), "the speech model's row shows its download: the bar and percent with size, a progress bar named after the row, no live region", JSON.stringify(now)));
  out.push(...expect(now.resting && now.button[0].off, "the dropdown and the button rest while the model downloads", JSON.stringify(now)));
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
  if (firstrun) {
    // The dropdown is still on the model that failed: its button reads Retry, and Home's step says the same.
    const home = await page.evaluate(() => ({ text: document.getElementById("setup-model-text").textContent, tone: document.getElementById("setup-model-text").dataset.tone, button: document.getElementById("setup-model-download").textContent }));
    out.push(...expect(now.select === "small" && now.button[0].shown && now.button[0].key === "retry" && !now.button[0].off && now.button[0].name.length > now.button[0].text.length && now.noteRetry === null, "the Download button reads Retry after the failure and says what it retries", JSON.stringify(now.button)));
    out.push(...expect(failedModel.test(home.text) && home.tone === "warn" && home.button === now.button[0].text, "Home's step says the same failure and offers Retry", JSON.stringify(home)));
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
    out.push(...expect(liveOk(noted) && (noted.settings["download-live"] ?? []).length === 2, "a download is read out at its start and its end, not at every step", JSON.stringify(noted.all)));
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
  out.push(...expect(liveOk(noted) && (noted.settings["download-live"] ?? []).length === 2, "a download is read out at its start and its end, not at every step", JSON.stringify(noted.all)));
  now = await downloadNow(page, SPEECH_ROW);
  const focus = await page.evaluate(() => document.activeElement?.id ?? "");
  out.push(...expect((await saved()) === "tiny" && now.select === "tiny" && now.tone === "" && now.noteRetry === null && focus === "model-select", "the model that arrived is saved, the failure is gone, and the keyboard focus is on the dropdown", JSON.stringify({ now, focus })));
  // A failure survives a change of the Display Language, in the new language, and goes with the next choice.
  await page.selectOption("#model-select", "base");
  await asked(page, "download_model", 3);
  await awaitError(page, /Download failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("speech"));
  await until(page, () => document.getElementById("model-note").dataset.tone === "error");
  await logged(page);
  const lang = await page.evaluate(() => document.documentElement.lang);
  const one = await page.evaluate(() => document.getElementById("model-note").textContent);
  await choose(page, "ui-language-select", lang === "de" ? "en" : "de");
  await wait(page, 300);
  const other = await page.evaluate(() => [document.getElementById("model-note").textContent, document.getElementById("model-note").dataset.tone, document.getElementById("gpu-detected").textContent]);
  out.push(...expect(other[0] !== one && /Base/.test(other[0]) && other[1] === "error", "the failure stays through a change of the Display Language, in the new language", JSON.stringify([one, other])));
  out.push(...expect((lang === "de" ? /^Detected: / : /^Erkannt: /).test(other[2]), "the detected graphics cards follow the Display Language", other[2]));
  await choose(page, "ui-language-select", lang);
  await wait(page, 300);
  await page.selectOption("#model-select", "small");
  await wait(page, 200);
  now = await downloadNow(page, SPEECH_ROW);
  out.push(...expect(now.tone === "" && !/Base/.test(now.note) && (await saved()) === "small", "the next choice ends the failure's note", JSON.stringify(now)));
  // For the screenshot: a download that runs.
  await page.selectOption("#model-select", "large-v3");
  await asked(page, "download_model", 4);
  await report(page, "download-progress", 2.9e9);
  return out;
}

/**
 * The AI model's row in the Advanced fold of AI cleanup, the same way.
 * `open` has opened the fold, chosen a model that is not there and scrolled
 * its row to the middle of the window, as a click on it would have it.
 */
async function aiDownload(page) {
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

  // It fails: the model's row and the state line say which model, in the colour of an error; both buttons read Retry.
  await awaitError(page, /ai_download_model failed/);
  await page.evaluate(() => window.__MOCK__.failDownload("ai"));
  await until(page, () => !document.getElementById("ai-download-progress").checkVisibility());
  await wait(page, 200);
  const errors = await logged(page);
  now = await downloadNow(page, AI_ROW);
  line = await main();
  const model = /Gemma\s4\s12B\s·\s7\.1\sGB/;
  out.push(...expect(errors === 1 && !now.shown && now.tone === "error" && model.test(now.note) && model.test(line.text) && line.tone === "error" && line.percent === "", "a download that fails: the model's row and the state line beside the switch say which model did not finish, in the colour of an error", JSON.stringify({ errors, now, line })));
  out.push(...expect(now.button.every((b) => b.shown && b.key === "retry" && !b.off && b.name.length > b.text.length), "both Download buttons read Retry and say what they retry", JSON.stringify(now.button)));
  // The failure is still there after the backend reported its state again.
  await page.evaluate(() => window.__MOCK__.emit("ai-status", null));
  await wait(page, 150);
  out.push(...expect(model.test((await main()).text) && (await downloadNow(page, AI_ROW)).tone === "error", "the failure stays when the AI's state is read again", JSON.stringify(await main())));
  // Home says it under its switch, as Settings does.
  const home = await page.evaluate(() => [document.getElementById("home-ai-status").textContent, document.getElementById("home-ai-status").dataset.tone]);
  out.push(...expect(model.test(home[0]) && home[1] === "error", "Home says the same failure under its AI cleanup switch", JSON.stringify(home)));

  // Retry starts clean and is read out twice: at its start and at its end.
  await noteLive(page);
  await page.click("#ai-download-btn");
  await asked(page, "ai_download_model", 2);
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
  return out;
}

/** The cloud engine without its key: the main card of Models & GPU says so and leads to the key field in the fold. */
async function cloudKey(page) {
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
  // Home's hotkeys card.
  await section(page, "home");
  const home = await edges("#home-hotkeys");
  out.push(...expect(home.length === 4 && new Set(home.map((k) => k.right)).size === 1, "Home's key boxes end on one right edge", JSON.stringify(home)));
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
  ai: [[".card:has(#ai-toggle)", 0], [".card:has(#ai-rule-list)", 1], [".fold", 0]],
  dictionary: [["#dict-suggest", 0], [".card:has(#dict-list)", 0], [".card:has(#replacement-list)", 1], [".card:has(#swiss-toggle)", 1], [".fold", 1]],
  models: [[".card", 0], [".fold", 1]],
  general: [[".card:has(#ui-language-select)", 0], [".card:has(#history-mode-select)", 1]],
};

/**
 * A Settings tab as it is laid out, with its Advanced fold closed and open:
 * two columns from 1600 px beside the sidebar (one left edge, one top edge,
 * each at most 900 px, the parts of a column 16 px apart, every part in its
 * column), one column below that. The order in the page is the same in both.
 */
async function columns(page, run) {
  const out = [];
  const size = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
  for (const tab of TABS) {
    await page.evaluate((t) => document.getElementById(`tab-${t}`).click(), tab);
    for (const open of tab === "general" ? [false] : [false, true]) {
      await page.evaluate(([t, open]) => document.querySelector(`details.fold[data-fold="${t}"]`) && (document.querySelector(`details.fold[data-fold="${t}"]`).open = open), [tab, open]);
      await wait(page, 60);
      const seen = await page.evaluate(
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
            .filter((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) > 1)
            .map((el) => el.innerText.trim().slice(0, 40));
          return {
            wider: document.getElementById("section-settings").classList.contains("wider"),
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
      const what = `${tab}${open ? ", Advanced open" : ""} at ${size}`;
      const detail = JSON.stringify(seen);
      out.push(...expect(seen.order, `${what}: the parts are in the order of the page`, detail));
      out.push(...expect(seen.wider === seen.room >= 1600, `${what}: two columns from 1600 px beside the sidebar, one below`, detail));
      out.push(...expect(!seen.sideways, `${what}: nothing scrolls sideways`, detail));
      const col = (n) => seen.boxes.filter((b) => b.column === n);
      if (!seen.wider) {
        // One column: every part on the page's left edge, as wide as the next one, one under the other.
        const one = seen.boxes.every((b, i) => b.left === seen.page && b.right === seen.boxes[0].right && (i === 0 || b.top >= seen.boxes[i - 1].bottom));
        out.push(...expect(one && seen.boxes[0].right - seen.boxes[0].left <= 1080.5, `${what}: one column of at most 1080 px on the page's left edge`, detail));
        continue;
      }
      const [left, right] = [col(0), col(1)];
      const width = (b) => b.right - b.left;
      out.push(...expect(left.length > 0 && right.length > 0 && left.every((b) => b.left === seen.page) && right.every((b) => b.left === right[0].left && b.left >= left[0].right + 8), `${what}: two columns, the left one on the page's left edge`, detail));
      out.push(...expect(left[0].top === right[0].top, `${what}: both columns start on one top edge`, detail));
      out.push(...expect(seen.boxes.every((b) => width(b) === width(seen.boxes[0]) && width(b) <= 900.5 && width(b) >= 700), `${what}: every part is as wide as its column, at most 900 px`, detail));
      const apart = (list) => list.every((b, i) => i === 0 || Math.abs(b.top - list[i - 1].bottom - 16) <= 1);
      out.push(...expect(apart(left) && apart(right), `${what}: the parts of a column stand 16 px apart, none is pushed away`, detail));
      out.push(...expect(seen.tabs[0] === seen.page && Math.abs(seen.tabs[1] - seen.pageRight) <= 1, `${what}: the tab bar spans the whole width`, detail));
      if (seen.fold) out.push(...expect(seen.fold.shown && seen.fold.width === width(seen.boxes[0]) && seen.fold.height >= 40 && !/rgba\(0, 0, 0, 0\)|transparent/.test(seen.fold.ground), `${what}: the fold's heading is a bar as wide as its column`, detail));
      out.push(...expect(seen.hints.length === 0, `${what}: every hint is one line`, seen.hints.join(" | ")));
    }
  }
  // The folds as the window found them (the tool set them, the page remembers them as the user's).
  await page.evaluate(() => {
    for (const fold of document.querySelectorAll("details.fold[data-fold]")) fold.open = false;
  });
  await page.evaluate(() => document.getElementById("tab-dictation").click());
  await wait(page, 200);
  // The step with the scrollbar drawn: once per run.
  if (run.lang === "en" && run.size === "1600x900") out.push(...(await settingsHold(run)));
  return out;
}

/**
 * The step to two columns (1600 px beside the sidebar) in a window that
 * draws its scrollbar, as Home's steps are tried (`layoutHolds`): one pixel
 * below, at and above it, at the window heights where the tab just fits and
 * just does not, for every tab with its fold closed and open. Nothing may
 * change by itself: the two forms differ in height, and a step decided on a
 * width the scrollbar takes away would flip in every frame.
 */
async function settingsHold(run) {
  const win = await run.openWindow({ scenario: "populated", lang: run.lang, size: "1800x1000", url: "/", scrollbars: true });
  const { page } = win;
  const tried = [];
  const forms = new Set();
  try {
    await section(page, "settings");
    const side = await page.evaluate(() => window.innerWidth - document.getElementById("content").offsetWidth);
    const widths = [1599, 1600, 1601].map((w) => w + side);
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
              () =>
                new Promise((done) => {
                  const settings = document.getElementById("section-settings");
                  const content = document.getElementById("content");
                  const look = () => `${settings.classList.contains("wider") ? "two" : "one"} ${content.offsetWidth - content.clientWidth}`;
                  let was = look();
                  let n = 0;
                  const end = performance.now() + 100;
                  const frame = () => {
                    const now = look();
                    if (now !== was) n++;
                    was = now;
                    if (performance.now() < end) requestAnimationFrame(frame);
                    else done({ changes: n, form: now, right: settings.classList.contains("wider") === content.offsetWidth >= 1600 });
                  };
                  requestAnimationFrame(frame);
                }),
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
      await present(page);
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
  { id: "files", open: (page) => section(page, "files") },
  { id: "meetings", open: (page) => section(page, "meetings") },
  { id: "soundboard", open: (page) => section(page, "soundboard") },
  ...TABS.map((tab) => ({ id: `settings-${tab}`, open: (page) => settings(page, tab) })),
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
            // In place: in every row of every tab, neither "More" nor the row's control moves when the long text opens.
            const moved = await page.evaluate(async () => {
              const out = [];
              const top = (el) => Math.round(el.getBoundingClientRect().top * 10) / 10;
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
  // Every tab in one column and in two (from 1600 px beside the sidebar: the 1920 px window too), fold closed and open.
  // This page and the next two follow the plain tabs and leave the window usable: no new start.
  {
    id: "settings-columns",
    alsoSizes: ["1920x1080"],
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
    probe: async (page) => [...(await keyEdges(page)), ...(await controlNames(page))],
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
