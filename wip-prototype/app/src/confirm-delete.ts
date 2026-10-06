// The one way to delete, on every delete button of the app: the first click
// arms it ("Delete?"), the second deletes; Esc, a click elsewhere or the
// focus moving away disarms. The rule itself is src/arm.ts.
//
// A button is known by an id ("history-17", "word-Zürich"), not by its
// element: lists are redrawn while a button is armed, and the new button
// for the same id comes back armed.
import { t } from "./i18n";
import { arm, type ArmEvent } from "./arm.ts";

export interface DeleteOptions {
  /** What it deletes, for a screen reader: "Delete: Airhorn". */
  name?: string;
  /** i18n key of the text at rest, when it is not "Delete" ("history_clear"). */
  label?: string;
  /** i18n key of the armed text, when it is not "Delete?" ("history_clear_confirm"). */
  armedLabel?: string;
}

let armed: string | null = null;
const actions = new Map<string, () => void | Promise<void>>();
let wired = false;

const idOf = (target: EventTarget | null) => (target instanceof Element ? (target.closest("[data-delete-id]")?.getAttribute("data-delete-id") ?? null) : null);

function paint(button: HTMLElement) {
  const on = button.dataset.deleteId === armed;
  const text = t(on ? (button.dataset.deleteArmed ?? "delete_confirm") : (button.dataset.deleteLabel ?? "delete"));
  button.classList.toggle("armed", on);
  button.textContent = text;
  if (button.dataset.deleteName) button.setAttribute("aria-label", `${text}: ${button.dataset.deleteName}`);
}

/** Every delete button's text again (after a language change). */
export function repaintDeletes() {
  for (const button of document.querySelectorAll<HTMLElement>("[data-delete-id]")) paint(button);
}

function dispatch(event: ArmEvent) {
  const step = arm(armed, event);
  armed = step.armed;
  repaintDeletes();
  if (step.fire) void actions.get(step.fire)?.();
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && armed) dispatch({ type: "cancel" });
  });
  // A click on anything but the armed button.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (armed && idOf(e.target) !== armed) dispatch({ type: "cancel" });
    },
    true,
  );
  // The keyboard's way of going elsewhere.
  document.addEventListener("focusout", (e) => {
    if (armed && idOf(e.target) === armed && idOf(e.relatedTarget) !== armed) dispatch({ type: "cancel" });
  });
}

/** Give `button` the two-click rule. `id` is the thing it deletes, unique in the window. */
export function confirmDelete(button: HTMLButtonElement, id: string, onDelete: () => void | Promise<void>, options: DeleteOptions = {}) {
  wire();
  actions.set(id, onDelete);
  button.type = "button";
  button.dataset.deleteId = id;
  if (options.name) button.dataset.deleteName = options.name;
  if (options.label) button.dataset.deleteLabel = options.label;
  if (options.armedLabel) button.dataset.deleteArmed = options.armedLabel;
  button.addEventListener("click", () => dispatch({ type: "click", id }));
  paint(button);
}

/** A "Delete" text button with the rule, for a list row. */
export function deleteButton(id: string, onDelete: () => void | Promise<void>, options: DeleteOptions = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "btn-text";
  confirmDelete(button, id, onDelete, options);
  return button;
}

/** Forget a row that is gone (its id may come back for another thing). */
export function forgetDelete(id: string) {
  actions.delete(id);
  if (armed === id) armed = null;
}
