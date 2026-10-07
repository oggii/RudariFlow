import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homeTitle, missing, status, statusSaid, statusText, type Missing, type SpeechStatus, type Status, type StatusInput, type StatusKind } from "../../src/status.ts";

const speech = (over: Partial<SpeechStatus> = {}): SpeechStatus => ({
  engine: "local",
  model: "small",
  downloaded: true,
  load: "loaded",
  freed: false,
  cloudKey: false,
  device: "NVIDIA GeForce RTX 5080 (CUDA)",
  ...over,
});

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  speech: speech(),
  microphones: 1,
  download: null,
  speechDownload: null,
  dictation: "Ready",
  meetingRecording: false,
  fileRunning: false,
  aiLoading: false,
  aiFreed: false,
  gameFreed: false,
  ...over,
});

test("ready needs a loaded model and a microphone", () => {
  assert.deepEqual(status(input()), { kind: "ready", tone: "ok", missing: [], percent: 0, marker: null });
  assert.equal(status(input({ speech: speech({ downloaded: false, load: "unloaded" }) })).kind, "setup");
  assert.equal(status(input({ microphones: 0 })).kind, "setup");
  assert.equal(status(input({ speech: speech({ load: "loading" }) })).kind, "loading");
});

test("the cloud engine is ready with a key and needs no model", () => {
  const cloud = speech({ engine: "cloud", downloaded: false, load: "unloaded", cloudKey: true });
  assert.equal(status(input({ speech: cloud })).kind, "ready");
  const noKey = status(input({ speech: { ...cloud, cloudKey: false } }));
  assert.deepEqual([noKey.kind, noKey.missing], ["setup", ["key"]]);
});

test("setup says what is missing, the microphone first", () => {
  const nothing = input({ microphones: 0, speech: speech({ downloaded: false, load: "unloaded" }) });
  assert.deepEqual(missing(nothing), ["microphone", "model"]);
  assert.deepEqual(statusText(status(nothing)), { key: "status_setup_microphone", n: "" });
  const failed = status(input({ speech: speech({ load: "failed" }) }));
  assert.deepEqual([failed.kind, failed.missing, failed.tone], ["setup", ["load"], "warn"]);
  assert.equal(statusText(failed).key, "status_setup_load");
});

test("the priority is the spec's", () => {
  const all = input({
    microphones: 0,
    download: 40,
    dictation: "Recording",
    meetingRecording: true,
    fileRunning: true,
    aiLoading: true,
    aiFreed: true,
    gameFreed: true,
    speech: speech({ load: "unloaded", freed: true }),
  });
  // Each step takes away the state that wins.
  const steps: [Partial<StatusInput>, string][] = [
    [{}, "setup"],
    [{ microphones: 1 }, "downloading"],
    [{ download: null }, "recording"],
    [{ dictation: "Transcribing" }, "transcribing"],
    [{ dictation: "Ready" }, "meeting"],
    [{ meetingRecording: false }, "file"],
    [{ fileRunning: false }, "loading"],
    [{ aiLoading: false }, "game"],
    [{ gameFreed: false }, "freed"],
    [{ aiFreed: false }, "freed"],
    [{ speech: speech() }, "ready"],
  ];
  let now = all;
  for (const [change, kind] of steps) {
    now = { ...now, ...change };
    assert.equal(status(now).kind, kind, JSON.stringify(change));
  }
});

test("nothing is known right after the start: loading, not setup", () => {
  assert.equal(status(input({ speech: null, microphones: null })).kind, "loading");
  assert.equal(status(input({ microphones: null })).kind, "loading");
  // A model that is there and not loaded yet is about to load.
  assert.equal(status(input({ speech: speech({ load: "unloaded" }) })).kind, "loading");
});

test("a download shows its percent", () => {
  const s = status(input({ download: 43.6 }));
  assert.deepEqual([s.kind, s.percent, s.tone], ["downloading", 44, "busy"]);
  assert.deepEqual(statusText(s), { key: "status_downloading", n: "44" });
  assert.equal(status(input({ download: 250 })).percent, 100);
});

test("a meeting or a file keeps a marker while something else shows", () => {
  assert.equal(status(input({ meetingRecording: true })).marker, null, "the meeting is the status");
  assert.equal(status(input({ meetingRecording: true, dictation: "Recording" })).marker, "meeting");
  assert.equal(status(input({ fileRunning: true, dictation: "Transcribing" })).marker, "file");
  assert.equal(status(input({ meetingRecording: true, fileRunning: true })).marker, "file", "the meeting shows, the file is the marker");
  assert.equal(status(input({ meetingRecording: true, fileRunning: true, dictation: "Recording" })).marker, "meeting");
});

test("freed for a game shows also while a dictation has Whisper loaded", () => {
  assert.equal(status(input({ gameFreed: true })).kind, "game");
  assert.equal(status(input({ gameFreed: true, speech: speech({ load: "unloaded", freed: true }) })).kind, "game");
  assert.equal(status(input({ aiFreed: true })).kind, "freed");
  assert.equal(status(input({ gameFreed: true })).tone, "idle");
});

test("the heading of Home", () => {
  assert.equal(homeTitle(status(input())), "home_title_ready");
  assert.equal(homeTitle(status(input({ meetingRecording: true }))), "home_title_ready");
  assert.equal(homeTitle(status(input({ gameFreed: true }))), "home_title_ready");
  assert.equal(homeTitle(status(input({ microphones: 0 }))), "home_title_setup");
  assert.equal(homeTitle(status(input({ speech: null }))), "home_title_loading");
  // A download beside a loaded speech model (an AI model's 5 GB): a dictation works.
  assert.equal(homeTitle(status(input({ download: 5 }))), "home_title_ready");
  // The speech model itself is what downloads: not ready yet.
  const first = status(input({ speech: speech({ downloaded: false, load: "unloaded" }), download: 5, speechDownload: 5 }));
  assert.deepEqual([first.kind, homeTitle(first)], ["downloading", "home_title_setup"]);
});

const noModel = speech({ downloaded: false, load: "unloaded" });

test("the first model's download shows its percent instead of the setup", () => {
  const first = status(input({ speech: noModel, download: 43.6, speechDownload: 43.6 }));
  assert.deepEqual(first, { kind: "downloading", tone: "busy", missing: ["model"], percent: 44, marker: null });
  assert.deepEqual(statusText(first), { key: "status_downloading", n: "44" });
  // An AI model started first: the percent is still the speech model's.
  assert.equal(status(input({ speech: noModel, download: 10, speechDownload: 43 })).percent, 43);
  // Another model downloads, not the one that is missing: still the setup.
  const other = status(input({ speech: noModel, download: 40 }));
  assert.deepEqual([other.kind, other.missing, other.percent], ["setup", ["model"], 0]);
  // More is missing than the model: its download does not end the setup.
  const noMic = status(input({ speech: noModel, microphones: 0, download: 40, speechDownload: 40 }));
  assert.deepEqual([noMic.kind, statusText(noMic).key], ["setup", "status_setup_microphone"]);
  // The cloud engine without its key: a local model's download does not help it.
  const noKey = status(input({ speech: speech({ engine: "cloud", downloaded: false, load: "unloaded" }), download: 40, speechDownload: 40 }));
  assert.deepEqual([noKey.kind, noKey.missing], ["setup", ["key"]]);
  // Once the model is there, a speech model's download (a second model) is a download like any other.
  const second = status(input({ download: 7, speechDownload: 7 }));
  assert.deepEqual([second.kind, second.missing, second.percent], ["downloading", [], 7]);
});

test("the marker shows under the setup and under a download too", () => {
  assert.equal(status(input({ microphones: 0, meetingRecording: true })).marker, "meeting");
  assert.equal(status(input({ microphones: 0, fileRunning: true })).marker, "file");
  assert.equal(status(input({ download: 5, meetingRecording: true })).marker, "meeting");
  assert.equal(status(input({ download: 5, fileRunning: true })).marker, "file");
  const first = status(input({ speech: noModel, download: 5, speechDownload: 5, meetingRecording: true, fileRunning: true }));
  assert.deepEqual([first.kind, first.marker], ["downloading", "meeting"], "the meeting comes first, as everywhere");
});

test("a speech model that loads or failed to load, whatever else is flagged", () => {
  // "freed" counts only while nothing is in memory and nothing loads.
  assert.equal(status(input({ speech: speech({ load: "loading", freed: true }) })).kind, "loading");
  const failed = status(input({ speech: speech({ load: "failed", freed: true }) }));
  assert.deepEqual([failed.kind, failed.missing], ["setup", ["load"]]);
  // What the user does shows before "Loading models…".
  const loading = speech({ load: "loading" });
  assert.equal(status(input({ speech: loading, dictation: "Recording" })).kind, "recording");
  assert.equal(status(input({ speech: loading, dictation: "Transcribing" })).kind, "transcribing");
  assert.equal(status(input({ speech: loading, meetingRecording: true })).kind, "meeting");
  assert.equal(status(input({ speech: loading, fileRunning: true })).kind, "file");
  assert.equal(status(input({ speech: loading, gameFreed: true })).kind, "loading");
});

test("the cloud engine follows the AI model and a game, not the local speech model", () => {
  const cloud = speech({ engine: "cloud", downloaded: false, load: "unloaded", cloudKey: true });
  assert.equal(status(input({ speech: cloud, aiLoading: true })).kind, "loading");
  assert.equal(status(input({ speech: cloud, gameFreed: true })).kind, "game");
  assert.equal(status(input({ speech: cloud, aiFreed: true })).kind, "freed");
  // The backend never reports these for the cloud engine; if it did, they would not show.
  assert.equal(status(input({ speech: { ...cloud, load: "failed", freed: true } })).kind, "ready");
});

test("a screen reader hears of a download once, not of every percent", () => {
  const said = new Set<string>();
  for (let percent = 0; percent <= 100; percent += 0.5) said.add(JSON.stringify(statusSaid(status(input({ download: percent })))));
  assert.deepEqual([...said], [JSON.stringify({ key: "status_downloading_said", marker: null })]);
  // Everything else is said as it is shown; the marker is said with it.
  assert.deepEqual(statusSaid(status(input())), { key: "status_ready", marker: null });
  assert.deepEqual(statusSaid(status(input({ microphones: 0 }))), { key: "status_setup_microphone", marker: null });
  assert.deepEqual(statusSaid(status(input({ dictation: "Recording", meetingRecording: true }))), { key: "status_recording", marker: "status_marker_meeting" });
  assert.deepEqual(statusSaid(status(input({ download: 5, fileRunning: true }))), { key: "status_downloading_said", marker: "status_marker_file" });
});

test("every text of the status exists in English and in German", () => {
  // src/i18n.ts is read as text: its tables are not exported, and its German needs a document.
  const source = readFileSync(new URL("../../src/i18n.ts", import.meta.url), "utf8");
  const table = (name: string) => {
    const start = source.indexOf(`const ${name}: Translations = {`);
    assert.ok(start >= 0, `the table "${name}"`);
    const end = source.indexOf("};", start);
    return new Set([...source.slice(start, end).matchAll(/^  (\w+):/gm)].map((m) => m[1]));
  };
  const tables = { en: table("en"), de: table("de") };
  assert.ok(tables.en.size > 100 && tables.de.size > 100, "the tables were read");

  const kinds: StatusKind[] = ["setup", "downloading", "recording", "transcribing", "meeting", "file", "loading", "game", "freed", "ready"];
  const reasons: Missing[] = ["microphone", "model", "key", "load"];
  const keys = new Set<string>();
  for (const kind of kinds) {
    for (const reason of kind === "setup" ? reasons : [null]) {
      for (const marker of [null, "meeting", "file"] as const) {
        const s: Status = { kind, tone: "ok", missing: reason ? [reason] : [], percent: 5, marker };
        const said = statusSaid(s);
        for (const key of [statusText(s).key, said.key, said.marker, homeTitle(s)]) if (key) keys.add(key);
      }
    }
  }
  // 9 kinds and the setup's 4 reasons, the spoken download, 2 markers, 3 headings.
  assert.equal(keys.size, 9 + 4 + 1 + 2 + 3, [...keys].join(" "));
  for (const key of keys) {
    for (const [lang, known] of Object.entries(tables)) assert.ok(known.has(key), `${key} is missing in "${lang}"`);
  }
});
