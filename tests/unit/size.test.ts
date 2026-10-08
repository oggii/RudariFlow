import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeText } from "../../src/size.ts";
import { SPEECH_MODELS, modelSize } from "../../src/models.ts";

test("sizes in words", () => {
  assert.equal(sizeText(870_000_000), "870 MB");
  assert.equal(sizeText(4_977_171_584), "5.0 GB");
  assert.equal(sizeText(3_106_738_272), "3.1 GB");
  assert.equal(sizeText(10), "1 MB");
  assert.equal(sizeText(0), "1 MB", "a file is never shown as nothing");
});

test("never 1000 MB: what rounds up to it is a gigabyte", () => {
  assert.equal(sizeText(999_400_000), "999 MB");
  assert.equal(sizeText(999_600_000), "1.0 GB");
  assert.equal(sizeText(1_000_000_000), "1.0 GB");
  // An unused model of this size read "1000 MB" in its row.
  assert.equal(sizeText(999_999_999), "1.0 GB");
});

test("every place that shows a size uses the one way to write it", () => {
  // The speech models' table has megabytes: the same words as for bytes.
  for (const model of SPEECH_MODELS) assert.equal(modelSize(model.mb), sizeText(model.mb * 1e6), model.id);
  assert.equal(modelSize(1500), "1.5 GB");
  assert.equal(modelSize(1000), "1.0 GB");
  assert.equal(modelSize(466), "466 MB");
});
