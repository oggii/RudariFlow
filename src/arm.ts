// The one way to delete: the first click arms the button ("Delete?"), the
// second deletes; Esc, a click elsewhere or moving the focus away disarms.
// This is the rule; src/confirm-delete.ts puts it on the buttons. Pure
// (tests/unit/arm.test.ts).

export type ArmEvent =
  /** A click on the delete button with this id. `at`: when, in milliseconds
   *  on a clock that only goes forward. `count`: which click of a multi-click
   *  the browser says it is (1, 2, 3 …; 0 or left out: the keyboard).
   *  `held`: the click of a key that is held down (key repeat). */
  | { type: "click"; id: string; at: number; count?: number; held?: boolean }
  /** Esc, a click on anything else, or the focus leaving the armed button. */
  | { type: "cancel" };

export interface ArmState {
  /** The button that is armed, or null. */
  armed: string | null;
  /** When the armed button was last clicked: by the click that armed it, or
   *  by a later one that came too early. */
  last: number;
  /** Which click of a multi-click armed it. */
  run: number;
}

export interface ArmStep extends ArmState {
  /** The id to delete now, or null. */
  fire: string | null;
}

/** Nothing is armed. */
export const AT_REST: ArmState = { armed: null, last: 0, run: 0 };

/** A click this soon after the last one is the same movement of the hand
 *  (a double-click, a key that bounced, a burst), not an answer to "Delete?". */
export const ARM_GUARD_MS = 300;

/** What a click or a cancel makes of `state`. A step is a state too: hand it back with the next event. */
export function arm(state: ArmState, event: ArmEvent): ArmStep {
  if (event.type === "cancel") return { ...AT_REST, fire: null };
  const count = event.count ?? 0;
  if (state.armed === event.id) {
    // The guard counts from the last click, not from the one that armed the
    // button: every click that comes too early starts it anew, so only a
    // click after a pause is an answer, and no burst of any length deletes.
    const early = event.at - state.last < ARM_GUARD_MS;
    // Still the gesture that armed it: a double-click deletes nothing, however
    // slow the system's double-click is set.
    const double = count > 1 && count === state.run + 1;
    if (event.held || early || double) return { ...state, last: event.at, fire: null };
    return { ...AT_REST, fire: event.id };
  }
  // A key that is held down arms nothing: it is still the press that
  // confirmed the row before, whose Delete handed the focus on.
  if (event.held) return { ...state, fire: null };
  // The first click, also on another row while one is armed: that one disarms.
  return { armed: event.id, last: event.at, run: count, fire: null };
}
