import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPEECH_MODELS, modelLabel, modelSize, modelToSave, speechModel } from "../../src/models.ts";

test("names and sizes of the speech models", () => {
  assert.equal(speechModel("large-v3-turbo-q8_0").name, "Large v3 Turbo q8");
  assert.equal(modelLabel("small"), "Small · 466 MB");
  assert.equal(modelLabel("large-v3"), "Large v3 · 2.9 GB");
  assert.equal(modelSize(1500), "1.5 GB");
  assert.deepEqual(speechModel("something-new"), { id: "something-new", name: "something-new", mb: 0, note: "" });
  assert.equal(modelLabel("something-new"), "something-new");
});

test("the table lists the models the dropdown offers, in its order", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const select = html.slice(html.indexOf('<select id="model-select"'), html.indexOf("</select>", html.indexOf('<select id="model-select"')));
  const offered = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(SPEECH_MODELS.map((m) => m.id), offered);
});

test("a save while a model downloads keeps the model that was saved last", () => {
  // Nothing downloads: what the dropdown is on is saved.
  assert.equal(modelToSave("tiny", "small", false), "tiny");
  // The dropdown is on a model that is on its way: not saved yet, or a failed download would leave the settings on a missing model.
  assert.equal(modelToSave("tiny", "small", true), "small");
  // The saved model itself downloads (the first run): the same either way.
  assert.equal(modelToSave("small", "small", true), "small");
  // Nothing was saved yet (the settings did not load): the dropdown's.
  assert.equal(modelToSave("tiny", "", true), "tiny");
});
