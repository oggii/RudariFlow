import { test } from "node:test";
import assert from "node:assert/strict";
import { homeTitle, missing, status, statusText, type SpeechStatus, type StatusInput } from "../../src/status.ts";

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
  assert.equal(homeTitle(status(input({ download: 5 }))), "home_title_loading");
});
