// The one way to delete: the first click arms the button ("Delete?"), the
// second deletes; Esc, a click elsewhere or moving the focus away disarms.
// This is the rule; src/confirm-delete.ts puts it on the buttons. Pure
// (tests/unit/arm.test.ts).

export type ArmEvent =
  /** A click on the delete button with this id. */
  | { type: "click"; id: string }
  /** Esc, a click on anything else, or the focus leaving the armed button. */
  | { type: "cancel" };

export interface ArmStep {
  /** The button that is armed afterwards, or null. */
  armed: string | null;
  /** The id to delete now, or null. */
  fire: string | null;
}

export function arm(armed: string | null, event: ArmEvent): ArmStep {
  if (event.type === "cancel") return { armed: null, fire: null };
  if (armed === event.id) return { armed: null, fire: event.id };
  // The first click, also on another row while one is armed: that one disarms.
  return { armed: event.id, fire: null };
}
