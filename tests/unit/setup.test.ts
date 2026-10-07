import { test } from "node:test";
import assert from "node:assert/strict";
import { recommend, setup, sizeText, type SetupInput } from "../../src/setup.ts";
import type { SpeechStatus } from "../../src/status.ts";

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

const input = (over: Partial<SetupInput> = {}): SetupInput => ({ speech: speech(), microphones: 1, aiDownloaded: false, aiDismissed: false, ...over });

test("a new PC needs the setup: no speech model yet", () => {
  assert.deepEqual(setup(input()), { needed: true, microphone: true, model: false, aiCard: true });
});

test("the setup is done with a microphone and a model", () => {
  const done = setup(input({ speech: speech({ downloaded: true }) }));
  assert.deepEqual(done, { needed: false, microphone: true, model: true, aiCard: true });
  assert.equal(setup(input({ speech: speech({ downloaded: true }), microphones: 0 })).needed, true, "no microphone");
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
  assert.deepEqual(setup(input({ speech: null })), { needed: false, microphone: true, model: true, aiCard: false });
  assert.equal(setup(input({ microphones: null })).needed, false);
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

test("sizes in words", () => {
  assert.equal(sizeText(870_000_000), "870 MB");
  assert.equal(sizeText(4_977_171_584), "5.0 GB");
  assert.equal(sizeText(10), "1 MB");
});
