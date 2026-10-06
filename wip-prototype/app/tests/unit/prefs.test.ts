import { test } from "node:test";
import assert from "node:assert/strict";
import { PREFS_KEY, defaultPrefs, loadPrefs, savePrefs, type Store } from "../../src/prefs.ts";

function memory(initial: Record<string, string> = {}): Store & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

test("what was saved comes back", () => {
  const store = memory();
  const prefs = { ...defaultPrefs(), section: "settings", tab: "models", folds: { models: true, ai: false }, panels: { narrow: true }, aiCardDismissed: true };
  assert.equal(savePrefs(store, prefs), true);
  assert.deepEqual(loadPrefs(store), prefs);
  assert.ok(PREFS_KEY in store.data, "one key holds everything");
});

test("nothing saved, damaged JSON or strange values give the defaults", () => {
  assert.deepEqual(loadPrefs(memory()), defaultPrefs());
  assert.deepEqual(loadPrefs(null), defaultPrefs());
  assert.deepEqual(loadPrefs(memory({ [PREFS_KEY]: "{ not json" })), defaultPrefs());
  assert.deepEqual(loadPrefs(memory({ [PREFS_KEY]: "[1,2]" })).section, "home");
  const odd = loadPrefs(memory({ [PREFS_KEY]: JSON.stringify({ section: 5, tab: "general", folds: { models: "yes", ai: true }, aiCardDismissed: "true" }) }));
  assert.deepEqual(odd, { ...defaultPrefs(), tab: "general", folds: { ai: true } });
});

test("a store that refuses does not break the window", () => {
  const refusing: Store = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(loadPrefs(refusing), defaultPrefs());
  assert.equal(savePrefs(refusing, defaultPrefs()), false);
  assert.equal(savePrefs(null, defaultPrefs()), false);
});
