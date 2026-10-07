import { test } from "node:test";
import assert from "node:assert/strict";
import { arm, ARM_GUARD_MS } from "../../src/arm.ts";

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

test("a double-click deletes nothing: the button stays armed", () => {
  // The second click of a double-click, as fast as the hand makes it.
  assert.deepEqual(arm("a", { type: "click", id: "a", since: 120 }), { armed: "a", fire: null });
  assert.deepEqual(arm("a", { type: "click", id: "a", since: ARM_GUARD_MS - 1 }), { armed: "a", fire: null });
  // A slow double-click (the system decides what one is), later than the guard.
  assert.deepEqual(arm("a", { type: "click", id: "a", since: 450, double: true }), { armed: "a", fire: null });
  // The click after it is an answer.
  assert.deepEqual(arm("a", { type: "click", id: "a", since: 900, double: false }), { armed: null, fire: "a" });
});

test("a click that comes after the guard deletes, with the mouse or the keyboard", () => {
  assert.deepEqual(arm("a", { type: "click", id: "a", since: ARM_GUARD_MS }), { armed: null, fire: "a" });
  assert.deepEqual(arm("a", { type: "click", id: "a", since: 5000, double: false }), { armed: null, fire: "a" });
  // A fast click on another row only arms that one.
  assert.deepEqual(arm("a", { type: "click", id: "b", since: 50 }), { armed: "b", fire: null });
});
