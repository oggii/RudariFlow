import { test } from "node:test";
import assert from "node:assert/strict";
import { HOME, resolve, route, startRoute } from "../../src/route.ts";

test("an unknown place falls back to Home and the first tab", () => {
  assert.deepEqual(route("settings", "models"), { section: "settings", tab: "models" });
  assert.deepEqual(route("engine", "nope"), HOME);
  assert.deepEqual(route(null, undefined), HOME);
  assert.deepEqual(route("files", 7), { section: "files", tab: "dictation" });
});

test("the window opens where it was left, on Home for a first run", () => {
  const left = route("settings", "general");
  assert.deepEqual(startRoute(left, false), left);
  assert.deepEqual(startRoute(left, true), { section: "home", tab: "general" });
});

test("the old section names lead to their new places", () => {
  const from = route("files", "ai");
  assert.deepEqual(resolve("engine", from), { section: "settings", tab: "models" });
  assert.deepEqual(resolve("recording", from), { section: "settings", tab: "dictation" });
  assert.deepEqual(resolve("replacements", from), { section: "settings", tab: "dictionary" });
  assert.deepEqual(resolve("general", from), { section: "settings", tab: "general" });
  assert.deepEqual(resolve("history", from), { section: "home", tab: "ai" });
  assert.deepEqual(resolve("meetings", from), { section: "meetings", tab: "ai" });
  assert.deepEqual(resolve("settings", from), { section: "settings", tab: "ai" }, "Settings opens on the tab it was left on");
  assert.deepEqual(resolve("settings/models", from), { section: "settings", tab: "models" });
  assert.deepEqual(resolve("nowhere", from), { section: "home", tab: "ai" });
  // Two old names are tab names now: alone they still mean the old page.
  const general = route("files", "general");
  assert.deepEqual(resolve("ai", general), { section: "settings", tab: "ai" });
  assert.deepEqual(resolve("dictionary", general), { section: "settings", tab: "dictionary" });
  assert.deepEqual(resolve("history", general), { section: "home", tab: "general" });
  for (const name of ["home", "files", "meetings", "soundboard"]) assert.deepEqual(resolve(name, general), { section: name, tab: "general" });
});

test("a tab that does not exist keeps the tab the window was on", () => {
  const from = route("home", "models");
  assert.deepEqual(resolve("settings/bogus", from), { section: "settings", tab: "models" });
  assert.deepEqual(resolve("settings/", from), { section: "settings", tab: "models" });
  assert.deepEqual(resolve("bogus/ai", from), { section: "home", tab: "ai" });
});
