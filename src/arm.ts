// The one way to delete: the first click arms the button ("Delete?"), the
// second deletes; Esc, a click elsewhere or moving the focus away disarms.
// This is the rule; src/confirm-delete.ts puts it on the buttons. Pure
// (tests/unit/arm.test.ts).

export type ArmEvent =
  /** A click on the delete button with this id. `since`: the milliseconds
   *  since that button was armed (left out: long ago). `double`: the browser
   *  counts this click and the one that armed the button as a double-click. */
  | { type: "click"; id: string; since?: number; double?: boolean }
  /** Esc, a click on anything else, or the focus leaving the armed button. */
  | { type: "cancel" };

export interface ArmStep {
  /** The button that is armed afterwards, or null. */
  armed: string | null;
  /** The id to delete now, or null. */
  fire: string | null;
}

/** A second click this soon after the first is the same movement of the hand
 *  (a double-click, a key that bounced), not an answer to "Delete?". */
export const ARM_GUARD_MS = 300;

export function arm(armed: string | null, event: ArmEvent): ArmStep {
  if (event.type === "cancel") return { armed: null, fire: null };
  if (armed === event.id) {
    // Still the gesture that armed it: a double-click deletes nothing, however
    // slow the system's double-click is set. The button stays armed.
    if ((event.since ?? Infinity) < ARM_GUARD_MS || event.double) return { armed, fire: null };
    return { armed: null, fire: event.id };
  }
  // The first click, also on another row while one is armed: that one disarms.
  return { armed: event.id, fire: null };
}
