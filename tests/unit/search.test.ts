import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE, RECENT, fold, matches, shown } from "../../src/search.ts";

test("a search ignores case and accents and wants every word", () => {
  assert.equal(fold("Zürich Café"), "zurich cafe");
  assert.ok(matches(["Der Termin in Zürich", "olk"], "zurich TERMIN"));
  assert.ok(matches(["Please send the quote", "whatsapp.root"], "whatsapp quote"), "text and app together");
  assert.ok(!matches(["Please send the quote", "code"], "quote outlook"));
  assert.ok(matches(["anything", null, undefined], "  "), "an empty query finds every row");
  assert.ok(!matches([null], "x"));
});

const entries = Array.from({ length: 120 }, (_, i) => ({ text: i % 10 === 0 ? `invoice ${i}` : `note ${i}`, app: i < 60 ? "code" : "olk" }));
const texts = (e: { text: string; app: string }) => [e.text, e.app];

test("the short list shows the newest few and offers Show all", () => {
  const view = shown(entries, texts, "", false, 1);
  assert.deepEqual([view.rows.length, view.found, view.more, view.canExpand], [RECENT, 120, 0, true]);
  assert.equal(view.rows[0], entries[0]);
  const few = shown(entries.slice(0, 3), texts, "", false, 1);
  assert.deepEqual([few.rows.length, few.canExpand], [3, false]);
});

test("Show all pages the whole list in chunks of 50", () => {
  const first = shown(entries, texts, "", true, 1);
  assert.deepEqual([first.rows.length, first.more, first.canExpand], [PAGE, PAGE, false]);
  const second = shown(entries, texts, "", true, 2);
  assert.deepEqual([second.rows.length, second.more], [100, 20]);
  const third = shown(entries, texts, "", true, 3);
  assert.deepEqual([third.rows.length, third.more], [120, 0]);
  assert.equal(shown(entries, texts, "", true, 0).rows.length, PAGE, "never fewer than one page");
});

test("a search looks through everything, also from the short list", () => {
  const view = shown(entries, texts, "invoice", false, 1);
  assert.deepEqual([view.rows.length, view.found, view.more, view.canExpand], [12, 12, 0, false]);
  const byApp = shown(entries, texts, "olk", false, 1);
  assert.deepEqual([byApp.rows.length, byApp.found, byApp.more], [PAGE, 60, 10]);
  assert.equal(shown(entries, texts, "nothing like it", true, 1).found, 0);
});
