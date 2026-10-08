import { test } from "node:test";
import assert from "node:assert/strict";
import { arm, ARM_GUARD_MS, AT_REST, type ArmEvent, type ArmState } from "../../src/arm.ts";

/** A click with the mouse (`count` 1, 2, 3 … as the browser counts a multi-click) or the keyboard (`count` 0). */
const click = (id: string, at: number, count = 1): ArmEvent => ({ type: "click", id, at, count });
/** The click of a key that is held down. */
const held = (id: string, at: number): ArmEvent => ({ type: "click", id, at, count: 0, held: true });
const cancel: ArmEvent = { type: "cancel" };

/** The events one after the other: what is armed at the end, and everything that was deleted on the way. */
function after(...events: ArmEvent[]) {
  let state: ArmState = AT_REST;
  const fired: string[] = [];
  for (const event of events) {
    const step = arm(state, event);
    if (step.fire) fired.push(step.fire);
    state = step;
  }
  return { armed: state.armed, fired };
}

/** `n` clicks on "a", `gap` ms apart, counted by the browser as one multi-click or each as a click of its own. */
const burst = (n: number, gap: number, counted: boolean) => Array.from({ length: n }, (_, i) => click("a", i * gap, counted ? i + 1 : 1));

test("nothing deletes on a single click", () => {
  assert.deepEqual(after(click("a", 0)), { armed: "a", fired: [] });
});

test("the second click on the armed button deletes", () => {
  assert.deepEqual(after(click("a", 0), click("a", 1000)), { armed: null, fired: ["a"] });
});

test("a click on another row arms that one and deletes nothing", () => {
  assert.deepEqual(after(click("a", 0), click("b", 1000)), { armed: "b", fired: [] });
  // A fast click on another row only arms that one too.
  assert.deepEqual(after(click("a", 0), click("b", 50)), { armed: "b", fired: [] });
  // And its own guard starts with it: the row armed first has no say in it.
  assert.deepEqual(after(click("a", 0), click("b", 1000), click("b", 1100)), { armed: "b", fired: [] });
});

test("Esc or a click elsewhere disarms", () => {
  assert.deepEqual(after(click("a", 0), cancel), { armed: null, fired: [] });
  assert.deepEqual(after(cancel), { armed: null, fired: [] });
  // Armed, cancelled, clicked again: armed anew, still nothing deleted.
  assert.deepEqual(after(click("a", 0), cancel, click("a", 1000)), { armed: "a", fired: [] });
});

test("a double-click deletes nothing: the button stays armed", () => {
  // The second click of a double-click, as fast as the hand makes it.
  assert.deepEqual(after(click("a", 0), click("a", 120, 2)), { armed: "a", fired: [] });
  assert.deepEqual(after(click("a", 0), click("a", ARM_GUARD_MS - 1, 2)), { armed: "a", fired: [] });
  // A slow double-click (the system decides what one is), later than the guard.
  assert.deepEqual(after(click("a", 0), click("a", 450, 2)), { armed: "a", fired: [] });
  // The click after it is an answer.
  assert.deepEqual(after(click("a", 0), click("a", 450, 2), click("a", 900)), { armed: null, fired: ["a"] });
});

test("a click that comes after the guard deletes, with the mouse or the keyboard", () => {
  assert.deepEqual(after(click("a", 0), click("a", ARM_GUARD_MS)), { armed: null, fired: ["a"] });
  assert.deepEqual(after(click("a", 0, 0), click("a", 5000, 0)), { armed: null, fired: ["a"] });
});

test("a burst of clicks deletes nothing, however long it is", () => {
  for (const n of [3, 4, 10]) {
    for (const counted of [true, false]) {
      assert.deepEqual(after(...burst(n, 60, counted)), { armed: "a", fired: [] }, `${n} clicks 60 ms apart, ${counted ? "one multi-click" : "single clicks"}`);
    }
  }
  // The guard counts from the last click, not from the one that armed the
  // button: the third of these comes 316 ms after the first, and 66 ms after the second.
  assert.deepEqual(after(click("a", 19), click("a", 269), click("a", 335)), { armed: "a", fired: [] });
});

test("only a click after a pause deletes", () => {
  const last = 9 * 60;
  // One millisecond too early starts the guard anew; the pause after the last click decides.
  assert.deepEqual(after(...burst(10, 60, false), click("a", last + ARM_GUARD_MS - 1)), { armed: "a", fired: [] });
  assert.deepEqual(after(...burst(10, 60, false), click("a", last + ARM_GUARD_MS)), { armed: null, fired: ["a"] });
  assert.deepEqual(after(...burst(10, 60, true), click("a", last + ARM_GUARD_MS)), { armed: null, fired: ["a"] });
  // Once, not once per click of the burst.
  assert.deepEqual(after(...burst(4, 60, false), click("a", 3 * 60 + 400), click("a", 3 * 60 + 420)), { armed: "a", fired: ["a"] });
});

test("Enter held down deletes nothing", () => {
  // The press arms; the key's repeat starts after half a second, later than the guard, and goes on.
  const repeats = Array.from({ length: 40 }, (_, i) => held("a", 500 + i * 33));
  const end = 500 + 39 * 33;
  assert.deepEqual(after(click("a", 0, 0), ...repeats), { armed: "a", fired: [] });
  // The key comes up and is pressed again at once: still the same movement.
  assert.deepEqual(after(click("a", 0, 0), ...repeats, click("a", end + 80, 0)), { armed: "a", fired: [] });
  // Pressed again after a pause: an answer.
  assert.deepEqual(after(click("a", 0, 0), ...repeats, click("a", end + ARM_GUARD_MS, 0)), { armed: null, fired: ["a"] });
  // The press that confirmed a delete is still down when the next row's button gets the focus: it arms nothing there.
  assert.deepEqual(after(click("a", 0, 0), click("a", 400, 0), held("b", 900), held("b", 933)), { armed: null, fired: ["a"] });
});
