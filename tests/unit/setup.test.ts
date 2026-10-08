import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  header,
  idleFor,
  meterMay,
  meterStep,
  modelStep,
  failureWords,
  progressWords,
  recommend,
  setup,
  METER_REVIVE_MS,
  METER_SILENT_MS,
  METER_USE_MS,
  type MeterInput,
  type MeterNow,
  type ModelStepInput,
  type SetupInput,
} from "../../src/setup.ts";
import { status, type Missing, type SpeechStatus, type Status, type StatusInput, type StatusKind } from "../../src/status.ts";

const speech = (over: Partial<SpeechStatus> = {}): SpeechStatus => ({
  engine: "local",
  model: "small",
  downloaded: false,
  load: "unloaded",
  freed: false,
  cloudKey: false,
  device: "",
  ...over,
});

const input = (over: Partial<SetupInput> = {}): SetupInput => ({ speech: speech(), microphones: 1, history: 0, aiDownloaded: false, aiDismissed: false, ...over });

test("a new PC needs the setup: no speech model yet", () => {
  assert.deepEqual(setup(input()), { known: true, needed: true, firstRun: true, microphone: true, model: false, aiCard: true });
});

test("the setup is done with a microphone and a model", () => {
  const done = setup(input({ speech: speech({ downloaded: true }) }));
  assert.deepEqual(done, { known: true, needed: false, firstRun: false, microphone: true, model: true, aiCard: true });
  assert.equal(setup(input({ speech: speech({ downloaded: true }), microphones: 0 })).needed, true, "no microphone");
});

test("a first run is a PC without a speech model and without a history", () => {
  // Only this is welcomed, and only this opens on Home whatever page the window was left on.
  assert.equal(setup(input()).firstRun, true);
  assert.equal(setup(input({ microphones: 0 })).firstRun, true, "no microphone either: still a new PC");
  // Someone who has dictated before is no newcomer, whatever is missing today.
  const there = speech({ downloaded: true, load: "loaded" });
  for (const [what, now] of [
    ["the only microphone is unplugged", input({ speech: there, microphones: 0, history: 40 })],
    ["the model file is gone", input({ history: 40 })],
    ["the cloud key was cleared", input({ speech: speech({ engine: "cloud" }), history: 40 })],
  ] as const) {
    assert.equal(setup(now).needed, true, what);
    assert.equal(setup(now).firstRun, false, what);
  }
  // Nor is someone who keeps no history: a model on the PC, or the cloud engine chosen, says they were here before.
  assert.equal(setup(input({ speech: there, microphones: 0 })).firstRun, false, "a model is there");
  assert.equal(setup(input({ speech: speech({ engine: "cloud" }) })).firstRun, false, "the cloud engine was chosen");
  // Done: no first run.
  assert.equal(setup(input({ speech: there })).firstRun, false);
});

test("the cloud engine counts with its key", () => {
  assert.equal(setup(input({ speech: speech({ engine: "cloud", cloudKey: true }) })).needed, false);
  assert.equal(setup(input({ speech: speech({ engine: "cloud", downloaded: true }) })).model, false, "a downloaded model does not help the cloud engine");
});

test("the AI cleanup card stays until its model is there or it is closed", () => {
  const ready = speech({ downloaded: true });
  assert.equal(setup(input({ speech: ready })).aiCard, true);
  assert.equal(setup(input({ speech: ready, aiDownloaded: true })).aiCard, false);
  assert.equal(setup(input({ speech: ready, aiDismissed: true })).aiCard, false);
});

test("nothing is asked for before the backend answered", () => {
  const unknown = { known: false, needed: false, firstRun: false, microphone: true, model: true, aiCard: false };
  assert.deepEqual(setup(input({ speech: null })), unknown);
  assert.deepEqual(setup(input({ microphones: null })), unknown);
  // The history too: with it missing, Home would show the daily view and then flip to the steps, or the other way.
  assert.deepEqual(setup(input({ history: null })), unknown);
  assert.equal(setup(input({ speech: speech({ downloaded: true }), history: null })).known, false);
});

test("the models suggested for a PC", () => {
  const card = (name: string, gb: number, integrated = false) => ({ name, integrated, memory_mib: gb * 1024 });
  assert.deepEqual(recommend([]), { model: "small", ai: "gemma-4-e2b", gpu: "" });
  assert.deepEqual(recommend([card("Intel UHD", 16, true)]), { model: "small", ai: "gemma-4-e2b", gpu: "" }, "shared memory is no video memory");
  assert.deepEqual(recommend([card("RTX 4060", 8)]), { model: "large-v3-turbo-q8_0", ai: "gemma-4-e2b", gpu: "RTX 4060" });
  assert.deepEqual(recommend([card("Intel UHD", 16, true), card("RTX 3050", 6), card("RTX 5080", 16)]), {
    model: "large-v3-turbo-q8_0",
    ai: "gemma-4-e4b",
    gpu: "RTX 5080",
  });
});

test("the bigger AI model from more than 8.5 GB of video memory", () => {
  const ai = (memory_mib: number) => recommend([{ name: "card", integrated: false, memory_mib }]).ai;
  assert.equal(ai(8.5 * 1024), "gemma-4-e2b", "8.5 GB itself is still the small one");
  assert.equal(ai(8.5 * 1024 + 1), "gemma-4-e4b");
  assert.equal(ai(8188), "gemma-4-e2b", "an 8 GB card reports a little less than 8192 MiB");
  assert.equal(ai(12 * 1024), "gemma-4-e4b");
  // The best dedicated card decides, not the first one listed.
  const two = [
    { name: "old", integrated: false, memory_mib: 4096 },
    { name: "new", integrated: false, memory_mib: 9000 },
  ];
  assert.deepEqual([recommend(two).ai, recommend(two).gpu], ["gemma-4-e4b", "new"]);
});

// ── Home's heading and the pill beside it ──

const now = (over: Partial<StatusInput> = {}): Status =>
  status({
    speech: speech(),
    microphones: 1,
    download: null,
    speechDownload: null,
    dictation: "Ready",
    meetingRecording: false,
    fileRunning: false,
    aiLoading: false,
    aiFreed: false,
    aiKnown: true,
    gameFreed: false,
    ...over,
  });
/** The heading for a status; `history`: how many dictations there are (null: not read yet). */
const headerOf = (over: Partial<StatusInput> = {}, history: number | null = 0) => {
  const seen = { speech: speech(), microphones: 1, ...over };
  return header(now(over), setup({ speech: seen.speech, microphones: seen.microphones, history, aiDownloaded: false, aiDismissed: false }));
};

test("the welcome is for a first run only: with a history the heading is the plain one, with the reason", () => {
  // The model file is gone on a PC that has dictated before: no welcome.
  assert.deepEqual(headerOf({}, 12), { title: "home_title_setup", pill: "home_reason_model", n: "" });
  // Its download: the plain heading stays, the pill has the percent.
  assert.deepEqual(headerOf({ download: 43, speechDownload: 43 }, 12), { title: "home_title_setup", pill: "status_downloading", n: "43" });
  // The only microphone is unplugged.
  assert.deepEqual(headerOf({ speech: speech({ downloaded: true, load: "loaded" }), microphones: 0 }, 12), { title: "home_title_setup", pill: "home_reason_microphone", n: "" });
});

test("before Home knows what it shows, the heading is neutral and never says Ready or what is missing", () => {
  const there = speech({ downloaded: true, load: "loaded" });
  // The history is not read yet: neither "Ready to dictate" nor the welcome.
  assert.deepEqual(headerOf({ speech: there }, null), { title: "home_title_loading", pill: "status_loading", n: "" });
  assert.deepEqual(headerOf({}, null), { title: "home_title_loading", pill: "status_loading", n: "" });
  assert.deepEqual(headerOf({ speech: there, microphones: 0 }, null), { title: "home_title_loading", pill: "status_loading", n: "" });
  // What really runs is said.
  assert.deepEqual(headerOf({ speech: there, dictation: "Recording" }, null), { title: "home_title_loading", pill: "status_recording", n: "" });
});

test("beside the welcome the pill is the short state, never the reason", () => {
  assert.deepEqual(headerOf(), { title: "setup_title", pill: "home_title_setup", n: "" });
  // No microphone either: still the welcome, and still only "Setup needed".
  assert.deepEqual(headerOf({ microphones: 0 }), { title: "setup_title", pill: "home_title_setup", n: "" });
  // The first model downloads: its percent, and "Setup needed" again when it fails.
  assert.deepEqual(headerOf({ download: 43, speechDownload: 43 }), { title: "setup_title", pill: "status_downloading", n: "43" });
  assert.deepEqual(headerOf({ download: 100, speechDownload: 100 }), { title: "setup_title", pill: "status_downloading", n: "100" });
});

test("under the plain heading Setup needed the pill is only the reason", () => {
  const there = speech({ downloaded: true, load: "loaded" });
  assert.deepEqual(headerOf({ speech: there, microphones: 0 }), { title: "home_title_setup", pill: "home_reason_microphone", n: "" });
  assert.deepEqual(headerOf({ speech: speech({ engine: "cloud" }) }), { title: "home_title_setup", pill: "home_reason_key", n: "" });
  assert.deepEqual(headerOf({ speech: speech({ engine: "cloud" }), microphones: 0 }), { title: "home_title_setup", pill: "home_reason_microphone", n: "" }, "first things first");
  // A model that did not load is no step of the setup, but the heading says "Setup needed" too.
  assert.deepEqual(headerOf({ speech: speech({ downloaded: true, load: "failed" }) }), { title: "home_title_setup", pill: "home_reason_load", n: "" });
});

test("once the setup is done the pill is the status as the sidebar has it", () => {
  const there = speech({ downloaded: true, load: "loaded" });
  assert.deepEqual(headerOf({ speech: there }), { title: "home_title_ready", pill: "status_ready", n: "" });
  assert.deepEqual(headerOf({ speech: speech({ downloaded: true, load: "loading" }) }), { title: "home_title_loading", pill: "status_loading", n: "" });
  // The AI model's download beside a loaded speech model.
  assert.deepEqual(headerOf({ speech: there, download: 24 }), { title: "home_title_ready", pill: "status_downloading", n: "24" });
  assert.deepEqual(headerOf({ speech: there, dictation: "Recording" }), { title: "home_title_ready", pill: "status_recording", n: "" });
  // Nothing is known yet.
  assert.deepEqual(headerOf({ speech: null }), { title: "home_title_loading", pill: "status_loading", n: "" });
});

test("every text of the heading and its pill exists in English and in German", () => {
  // The pill's keys are put together here, so the tool's check of the keys in use does not see them.
  const source = readFileSync(new URL("../../src/i18n.ts", import.meta.url), "utf8");
  const table = (name: string) => {
    const start = source.indexOf(`const ${name}: Translations = {`);
    assert.ok(start >= 0, `the table "${name}"`);
    return new Set([...source.slice(start, source.indexOf("};", start)).matchAll(/^  (\w+):/gm)].map((m) => m[1]));
  };
  const tables = { en: table("en"), de: table("de") };
  assert.ok(tables.en.size > 100 && tables.de.size > 100, "the tables were read");
  const kinds: StatusKind[] = ["setup", "downloading", "recording", "transcribing", "meeting", "file", "loading", "game", "freed", "ready"];
  const reasons: Missing[] = ["microphone", "model", "key", "load"];
  const keys = new Set<string>();
  for (const kind of kinds) {
    for (const reason of kind === "setup" ? reasons : [null]) {
      const s: Status = { kind, tone: "ok", missing: reason ? [reason] : [], percent: 5, marker: null, loading: kind === "loading" };
      for (const needed of [true, false]) {
        for (const firstRun of [true, false]) {
          for (const known of [true, false]) {
            const said = header(s, { known, needed, firstRun: needed && firstRun, microphone: true, model: !needed, aiCard: false });
            keys.add(said.title).add(said.pill);
          }
        }
      }
    }
  }
  for (const key of ["setup_title", "home_title_setup", "home_reason_microphone", "home_reason_model", "home_reason_key", "home_reason_load", "status_downloading"]) {
    assert.ok(keys.has(key), `the heading or the pill can say "${key}"`);
  }
  for (const key of keys) for (const lang of ["en", "de"] as const) assert.ok(tables[lang].has(key), `"${key}" in ${lang}`);
});

// ── Step 2 ──

const model = (over: Partial<ModelStepInput> = {}): ModelStepInput => ({ speech: speech(), fetching: false, wasFetching: false, wasFailed: false, starting: false, suggested: true, ...over });

test("step 2 from to do over starting and downloading to done", () => {
  assert.deepEqual(modelStep(model({ suggested: false })), { state: "checking", failed: false });
  assert.deepEqual(modelStep(model()), { state: "todo", failed: false });
  assert.deepEqual(modelStep(model({ starting: true })), { state: "starting", failed: false });
  assert.deepEqual(modelStep(model({ starting: true, fetching: true })), { state: "downloading", failed: false });
  // A download started in Settings, before the graphics cards are known.
  assert.deepEqual(modelStep(model({ fetching: true, suggested: false })), { state: "downloading", failed: false });
  assert.deepEqual(modelStep(model({ speech: speech({ downloaded: true, load: "loading" }), wasFetching: true })), { state: "loading", failed: false });
  for (const load of ["loaded", "unloaded", "failed"] as const) {
    assert.deepEqual(modelStep(model({ speech: speech({ downloaded: true, load }) })), { state: "done", failed: false }, load);
  }
  // Nothing is known yet: nothing has failed.
  assert.deepEqual(modelStep(model({ speech: null, suggested: false })), { state: "checking", failed: false });
});

test("a download that ends without the model has failed, until a new try or the model", () => {
  // It ran when the step was last drawn, it does not run now, and the model is not there.
  assert.deepEqual(modelStep(model({ wasFetching: true })), { state: "failed", failed: true });
  // That stays so while nothing happens, also before the graphics cards are known.
  assert.deepEqual(modelStep(model({ wasFailed: true })), { state: "failed", failed: true });
  assert.deepEqual(modelStep(model({ wasFailed: true, suggested: false })), { state: "failed", failed: true });
  // Retry: the click itself ends the failure, then the download does.
  assert.deepEqual(modelStep(model({ wasFailed: true, starting: true })), { state: "starting", failed: false });
  assert.deepEqual(modelStep(model({ wasFailed: true, fetching: true })), { state: "downloading", failed: false });
  // While it runs nothing has failed, whatever was before.
  assert.deepEqual(modelStep(model({ fetching: true, wasFetching: true })), { state: "downloading", failed: false });
  // The model is there (it was chosen in Settings): no failure is left.
  assert.deepEqual(modelStep(model({ wasFailed: true, speech: speech({ downloaded: true, load: "loaded" }) })), { state: "done", failed: false });
  // Without a download before, nothing has failed.
  assert.deepEqual(modelStep(model()), { state: "todo", failed: false });
});

test("step 2 with the cloud engine asks for the key, not for a model", () => {
  assert.deepEqual(modelStep(model({ speech: speech({ engine: "cloud" }) })), { state: "key", failed: false });
  assert.deepEqual(modelStep(model({ speech: speech({ engine: "cloud", cloudKey: true }) })), { state: "cloud", failed: false });
  // A downloaded model does not help the cloud engine, and a download of the local model changes nothing here.
  assert.deepEqual(modelStep(model({ speech: speech({ engine: "cloud", downloaded: true }), fetching: true })), { state: "key", failed: false });
  // The key is there: a failed download of the local model is no longer in the way.
  assert.deepEqual(modelStep(model({ speech: speech({ engine: "cloud", cloudKey: true }), wasFailed: true })), { state: "cloud", failed: false });
});

// ── Step 1's level ──

const atWindow: MeterInput = { steps: true, shown: true, microphone: true, failed: false, idle: 0 };

test("the microphone opens only for someone who is at the window", () => {
  assert.equal(meterMay(atWindow), true);
  assert.equal(meterMay({ ...atWindow, idle: METER_USE_MS }), true, "the last moment of the minute");
  assert.equal(meterMay({ ...atWindow, idle: METER_USE_MS + 1 }), false, "nobody touched the window for over a minute");
  assert.equal(meterMay({ ...atWindow, idle: null }), false, "nobody ever touched it");
  assert.equal(meterMay({ ...atWindow, steps: false }), false, "another page, the setup done, or the document hidden");
  assert.equal(meterMay({ ...atWindow, shown: false }), false, "the window is in the tray or minimized, or has not answered");
  assert.equal(meterMay({ ...atWindow, microphone: false }), false);
  assert.equal(meterMay({ ...atWindow, failed: true }), false, "one that did not open is not tried again by itself");
});

test("the meter starts with a touch and stops with its place", () => {
  const off: MeterNow = { ...atWindow, on: false, opening: false, silent: 0, sinceStart: 0 };
  const on: MeterNow = { ...off, on: true };
  assert.equal(meterStep(off), "start");
  assert.equal(meterStep({ ...off, idle: null }), "keep", "it rests until the first touch");
  assert.equal(meterStep({ ...off, idle: METER_USE_MS + 1 }), "keep");
  assert.equal(meterStep({ ...off, shown: false }), "keep");
  assert.equal(meterStep(on), "keep");
  // One that runs is not stopped for being left alone: it runs to the backend's limit.
  assert.equal(meterStep({ ...on, idle: 10 * METER_USE_MS, silent: 30 }), "keep");
  for (const gone of [{ steps: false }, { shown: false }, { microphone: false }, { failed: true }]) {
    assert.equal(meterStep({ ...on, ...gone }), "stop", JSON.stringify(gone));
    assert.equal(meterStep({ ...on, ...gone, opening: true }), "stop", `${JSON.stringify(gone)} while it opens`);
    assert.equal(meterStep({ ...off, ...gone }), "keep", JSON.stringify(gone));
  }
});

test("a meter that fell silent comes back only for a user who is there", () => {
  const silent: MeterNow = { ...atWindow, on: true, opening: false, silent: METER_SILENT_MS + 1, sinceStart: 120_000, idle: 5000 };
  assert.equal(meterStep(silent), "restart");
  assert.equal(meterStep({ ...silent, silent: METER_SILENT_MS }), "keep", "not silent yet");
  assert.equal(meterStep({ ...silent, opening: true }), "keep", "a device can take seconds to open");
  assert.equal(meterStep({ ...silent, sinceStart: METER_REVIVE_MS }), "keep", "not started again more often than this");
  assert.equal(meterStep({ ...silent, sinceStart: METER_REVIVE_MS + 1 }), "restart");
  // Nobody is there any more: it is given up, and the next touch starts it.
  assert.equal(meterStep({ ...silent, idle: METER_USE_MS + 1 }), "stop");
  assert.equal(meterStep({ ...silent, idle: METER_USE_MS + 1, on: false }), "keep");
  assert.equal(meterStep({ ...silent, idle: 0, on: false }), "start");
  // The longest it is open with nobody there: started again at the end of the minute, then the backend's two minutes.
  assert.equal(meterStep({ ...silent, idle: METER_USE_MS }), "restart");
});

test("the minute since the last touch is measured on two clocks, and the longer answer counts", () => {
  assert.equal(idleFor(5000, 5000), 5000);
  // The PC slept for an hour: the page's own clock stood still, the wall clock did not.
  assert.equal(idleFor(5000, 3_605_000), 3_605_000);
  assert.equal(meterMay({ ...atWindow, idle: idleFor(5000, 3_605_000) }), false);
  // The wall clock was set back by an hour (or jumped back at a time change): the page's own clock counts.
  assert.equal(idleFor(METER_USE_MS + 1, METER_USE_MS + 1 - 3_600_000), METER_USE_MS + 1);
  assert.equal(meterMay({ ...atWindow, idle: idleFor(METER_USE_MS + 1, METER_USE_MS + 1 - 3_600_000) }), false);
  // Set forward: the level rests early, and the next touch brings it back.
  assert.equal(idleFor(1000, 3_601_000), 3_601_000);
  // Never less than nothing.
  assert.equal(idleFor(0, -3_600_000), 0);
  assert.equal(meterMay({ ...atWindow, idle: idleFor(0, -3_600_000) }), true);
});

test("a download's numbers: a whole percent, the sizes, and the words a progress bar says", () => {
  const shown = "{percent} % · {done} of {total}";
  const said = "{percent} %, {done} of {total}";
  assert.deepEqual(progressWords({ downloaded: 200.6e6, total: 466e6, percent: 43.04 }, shown, said), { percent: 43, shown: "43 % · 201 MB of 466 MB", said: "43 %, 201 MB of 466 MB" });
  assert.deepEqual(progressWords({ downloaded: 3.1e9, total: 7.1e9, percent: 43.6 }, shown, said), { percent: 44, shown: "44 % · 3.1 GB of 7.1 GB", said: "44 %, 3.1 GB of 7.1 GB" });
  // Before the first report there is no size to show: a second download starts at "0 %", not at the last one's numbers.
  assert.deepEqual(progressWords({ downloaded: 0, total: 0, percent: 0 }, shown, said), { percent: 0, shown: "0 %", said: "0 %" });
  // A server that does not say how much is to come: what has arrived.
  assert.deepEqual(progressWords({ downloaded: 12e6, total: 0, percent: 0 }, shown, said), { percent: 0, shown: "12 MB", said: "12 MB" });
  // Never outside 0 to 100, whatever is reported.
  assert.equal(progressWords({ downloaded: 470e6, total: 466e6, percent: 100.9 }, shown, said).percent, 100);
  assert.equal(progressWords({ downloaded: 0, total: 466e6, percent: -3 }, shown, said).percent, 0);
  assert.equal(progressWords({ downloaded: 0, total: 466e6, percent: Number.NaN }, shown, said).percent, 0);
});

test("a download that failed says the backend's reason, and the advice only where no reason is known", () => {
  const sentence = "The download of {model} did not finish.";
  const advice = "Check your internet connection and try again.";
  const because = "Reason: {reason}";
  // A full disk is not a bad connection: the reason stands alone, without the advice that would be wrong beside it.
  assert.equal(
    failureWords(sentence, advice, because, "Tiny · 75 MB", "There is not enough space on the disk. (os error 112)"),
    "The download of Tiny · 75 MB did not finish. Reason: There is not enough space on the disk. (os error 112)",
  );
  // The reason ends like a sentence, so what follows it (Retry) stands apart.
  assert.equal(failureWords(sentence, advice, because, "Tiny", " error sending request "), "The download of Tiny did not finish. Reason: error sending request.");
  // No reason: the best guess is the connection.
  assert.equal(failureWords(sentence, advice, because, "Tiny", ""), "The download of Tiny did not finish. Check your internet connection and try again.");
  assert.equal(failureWords(sentence, advice, because, "Tiny", "   "), "The download of Tiny did not finish. Check your internet connection and try again.");
  // A model's name or a reason with "$" in it is text, not a pattern.
  assert.equal(failureWords("{model} failed.", "Try again.", "Why: {reason}", "$& model", "$1 left"), "$& model failed. Why: $1 left.");
});

test("the failure's three texts exist in English and in German, and the sentence itself gives no advice", () => {
  const source = readFileSync(new URL("../../src/i18n.ts", import.meta.url), "utf8");
  for (const lang of ["en", "de"]) {
    const start = source.indexOf(`const ${lang}: Translations = {`);
    const table = source.slice(start, source.indexOf("};", start));
    const text = (key: string) => new RegExp(`^  ${key}: "(.*)",$`, "m").exec(table)?.[1] ?? "";
    for (const key of ["setup_download_failed", "download_advice", "download_reason"]) assert.ok(text(key).length > 5, `${key} in ${lang}`);
    // One sentence, about the download: what to do about it is the advice's or the reason's to say.
    assert.equal(text("setup_download_failed").split(". ").length, 1, lang);
    assert.ok(text("setup_download_failed").includes("{model}") && text("download_reason").includes("{reason}"), lang);
  }
});
