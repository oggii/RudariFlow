import { test } from "node:test";
import assert from "node:assert/strict";
import { arm } from "../../src/arm.ts";

test("nothing deletes on a single click", () => {
  assert.deepEqual(arm(null, { type: "click", id: "a" }), { armed: "a", fire: null });
});

test("the second click on the armed button deletes", () => {
  assert.deepEqual(arm("a", { type: "click", id: "a" }), { armed: null, fire: "a" });
});

test("a click on another row arms that one and deletes nothing", () => {
  assert.deepEqual(arm("a", { type: "click", id: "b" }), { armed: "b", fire: null });
});

test("Esc or a click elsewhere disarms", () => {
  assert.deepEqual(arm("a", { type: "cancel" }), { armed: null, fire: null });
  assert.deepEqual(arm(null, { type: "cancel" }), { armed: null, fire: null });
  // Armed, cancelled, clicked again: armed anew, still nothing deleted.
  const again = arm(arm("a", { type: "cancel" }).armed, { type: "click", id: "a" });
  assert.deepEqual(again, { armed: "a", fire: null });
});
