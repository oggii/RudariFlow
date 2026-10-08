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

test("every speech model has its one line, in English and in German", () => {
  // The list behind the row's "More" shows one for each: before, Base and Medium had none.
  const source = readFileSync(new URL("../../src/i18n.ts", import.meta.url), "utf8");
  for (const lang of ["en", "de"]) {
    const start = source.indexOf(`const ${lang}: Translations = {`);
    assert.ok(start >= 0, `the table "${lang}"`);
    const table = source.slice(start, source.indexOf("};", start));
    for (const model of SPEECH_MODELS) {
      assert.match(model.note, /^model_note_\w+$/, model.id);
      const text = new RegExp(`^  ${model.note}: "(.*)",$`, "m").exec(table)?.[1] ?? "";
      assert.ok(text.length >= 15 && text.endsWith("."), `${model.note} in ${lang}: "${text}"`);
    }
    for (const key of ["model_recommended_here", "model_recommended_short"]) assert.ok(table.includes(`\n  ${key}: "`), `${key} in ${lang}`);
  }
  assert.equal(new Set(SPEECH_MODELS.map((m) => m.note)).size, SPEECH_MODELS.length, "each model has a line of its own");
});

test("the table lists the models the dropdown offers, in its order", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const select = html.slice(html.indexOf('<select id="model-select"'), html.indexOf("</select>", html.indexOf('<select id="model-select"')));
  const offered = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(SPEECH_MODELS.map((m) => m.id), offered);
});

test("a save stores the dropdown's model only once it is known to be on disk", () => {
  // The dropdown's model is the one last known to be there: it is saved.
  assert.equal(modelToSave("tiny", "small", false), "tiny");
  // Not known to be there (it is looked for, it downloads, its download just failed): the model that was saved last stays,
  // or a download that then fails would leave the settings on a missing model.
  assert.equal(modelToSave("tiny", "small", true), "small");
  // The saved model itself downloads (the first run): the same either way.
  assert.equal(modelToSave("small", "small", true), "small");
  // Nothing was saved yet (the settings did not load): the dropdown's.
  assert.equal(modelToSave("tiny", "", true), "tiny");
});
