import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, onActivity, setDownload, setFileRunning } from "../../src/activity.ts";

test("a download is told to its listeners once per whole percent, not once per report", () => {
  let told = 0;
  onActivity(() => told++);
  // A download reports about ten times a second: 200 reports on the way from 0 to 43 %.
  setDownload("ai", 0);
  for (let i = 1; i <= 200; i++) setDownload("ai", i * 0.215);
  assert.equal(activity().download, 43);
  // 0, 1, 2 … 43: every listener (the status, and with it all of Home) drew 44 times, not 201.
  assert.equal(told, 44);
  // The same percent again changes nothing.
  setDownload("ai", 43.2);
  setDownload("ai", 42.6);
  assert.equal(told, 44);
  setDownload("ai", null);
  assert.equal(told, 45);
  assert.equal(activity().download, null);
  // Over already: nothing to tell.
  setDownload("ai", null);
  assert.equal(told, 45);
});

test("a percent is a whole number from 0 to 100, whatever is reported", () => {
  setDownload("speech", 100.9);
  assert.equal(activity().speech, 100);
  setDownload("speech", -3);
  assert.equal(activity().speech, 0);
  setDownload("speech", Number.NaN);
  assert.equal(activity().speech, 0);
  setDownload("speech", null);
  assert.equal(activity().speech, null);
});

test("the download that started first is the one the status shows, and the speech model's is kept apart", () => {
  setDownload("ai", 10);
  setDownload("speech", 60);
  assert.deepEqual(activity(), { download: 10, kind: "ai", speech: 60, fileRunning: false });
  setDownload("ai", null);
  assert.deepEqual(activity(), { download: 60, kind: "speech", speech: 60, fileRunning: false });
  setDownload("speech", null);
  setFileRunning(true);
  assert.equal(activity().fileRunning, true);
  setFileRunning(false);
});
