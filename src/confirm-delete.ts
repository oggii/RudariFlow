// The one way to delete, on every delete button of the app: the first click
// arms it ("Delete?"), the second deletes; Esc, a click elsewhere or the
// focus moving away disarms. The rule itself is src/arm.ts.
//
// A button is known by an id ("history-17", "word-Zürich"), not by its
// element: lists are redrawn while a button is armed, and the new button
// for the same id comes back armed and, if the old one had it, with the
// keyboard focus.
//
// What else every delete gets here: a double-click or a held Enter deletes
// nothing; a screen reader hears that the button is armed (#delete-live)
// and what it deletes (the button's name); a delete that fails says so on
// its button and aloud, and the thing stays; while a delete runs its button
// rests; and when the deleted row takes the button away under the keyboard
// focus, the next row's Delete gets it.
import { t } from "./i18n";
import { arm, type ArmEvent } from "./arm.ts";

export interface DeleteOptions {
  /** What it deletes, for a screen reader: "Delete: Airhorn". */
  name?: string;
  /** i18n key of the text at rest, when it is not "Delete" ("history_clear"). */
  label?: string;
  /** i18n key of the armed text, when it is not "Delete?" ("history_clear_confirm"). */
  armedLabel?: string;
  /** Where the keyboard focus goes when the last row of a list was deleted
   *  and its button went with it (the field that adds a new one, say). */
  after?: () => HTMLElement | null;
}

type Action = () => void | Promise<void>;

/** How long a button says that its delete failed. */
const FAILED_MS = 2500;

let armed: string | null = null;
/** The click that armed it: when, and which click of a multi-click it was. */
let armedAt = 0;
let armedRun = 0;
const actions = new Map<string, Action>();
const afters = new Map<string, () => HTMLElement | null>();
/** Deletes that run: a second word for one changes nothing. */
const running = new Set<string>();
/** Deletes that failed, until their button says "Delete" again. */
const failed = new Map<string, number>();
/** The delete that was confirmed last, and the buttons of its list around
 *  it (the rows after it first): one of them takes the focus when its row goes. */
let fired: { id: string; around: string[] } | null = null;
/** Where the focus was handed when that row went: a delete that fails after all takes it back. */
let handed: { id: string; to: HTMLElement } | null = null;
/** Read out, not shown: that a button is armed, that a delete failed. */
let live: HTMLElement | null = null;
let wired = false;

const idOf = (target: EventTarget | null) => (target instanceof Element ? (target.closest("[data-delete-id]")?.getAttribute("data-delete-id") ?? null) : null);
const buttons = () => Array.from(document.querySelectorAll<HTMLElement>("[data-delete-id]"));
/** The button for `id` as the page has it now (ids hold user text: no selector is built from one). */
const buttonOf = (id: string) => buttons().find((b) => b.dataset.deleteId === id) ?? null;
/** On the page, shown and not switched off: it can take the focus. */
const usable = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && el.getClientRects().length > 0 && !el.matches(":disabled");
/** The focus is nowhere: what had it was removed, hidden or switched off. */
const focusLost = () => {
  const el = document.activeElement;
  return !el || el === document.body || !el.isConnected;
};
/** The list an id belongs to: "word" of "word-Zürich". */
const listOf = (id: string) => id.split("-", 1)[0];

function say(text: string) {
  if (live && live.textContent !== text) live.textContent = text;
}

function paint(button: HTMLElement) {
  const id = button.dataset.deleteId ?? "";
  const name = button.dataset.deleteName;
  const rest = t(button.dataset.deleteLabel ?? "delete");
  const ask = t(button.dataset.deleteArmed ?? "delete_confirm");
  const on = id === armed;
  const text = failed.has(id) ? t("history_action_failed").replace("{action}", () => rest) : on ? ask : rest;
  button.classList.toggle("armed", on);
  if (button.textContent !== text) button.textContent = text;
  // The button keeps the width of the wider of its two texts, so arming it
  // moves nothing beside it (styles/components.css).
  button.dataset.deleteRest = rest;
  button.dataset.deleteAsk = ask;
  // The name says the same as the button, then what it deletes.
  if (name) button.setAttribute("aria-label", on ? `${text} ${name}` : `${text}: ${name}`);
  if (running.has(id)) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
}

/** Every delete button's text again (after a language change). */
export function repaintDeletes() {
  for (const button of buttons()) paint(button);
}

function dispatch(event: ArmEvent, at = 0, count = 0) {
  const before = armed;
  const step = arm(armed, event);
  armed = step.armed;
  if (armed && armed !== before) {
    armedAt = at;
    armedRun = count;
    forgetFailure(armed);
  }
  repaintDeletes();
  if (armed !== before) {
    const name = armed ? buttonOf(armed)?.dataset.deleteName : undefined;
    say(!armed ? "" : name ? t("delete_armed_said").replace("{name}", () => name) : t("delete_armed_said_plain"));
  }
  if (step.fire) void carryOut(step.fire);
}

function forgetFailure(id: string) {
  window.clearTimeout(failed.get(id));
  failed.delete(id);
}

/** The delete of `id` did not work: its button and the live line say so for a
 *  moment. The row may have gone and come back meanwhile: the focus that was
 *  handed on, or lost, is on its button again. */
function fail(id: string) {
  forgetFailure(id);
  const button = buttonOf(id);
  if (usable(button) && (focusLost() || (handed?.id === id && document.activeElement === handed.to))) button.focus();
  const rest = t(button?.dataset.deleteLabel ?? "delete");
  const name = button?.dataset.deleteName;
  const words = t("history_action_failed").replace("{action}", () => rest) + (name ? `: ${name}` : "");
  failed.set(
    id,
    window.setTimeout(() => {
      failed.delete(id);
      repaintDeletes();
      if (live?.textContent === words) say("");
    }, FAILED_MS),
  );
  say(words);
}

/** The confirmed delete. A caller's delete may throw: the failure is shown here. */
async function carryOut(id: string) {
  const action = actions.get(id);
  if (!action || running.has(id)) return;
  const peers = buttons()
    .filter(usable)
    .map((b) => b.dataset.deleteId ?? "")
    .filter((other) => listOf(other) === listOf(id));
  const at = peers.indexOf(id);
  fired = { id, around: at < 0 ? [] : [...peers.slice(at + 1), ...peers.slice(0, at).reverse()] };
  handed = null;
  running.add(id);
  repaintDeletes();
  try {
    await action();
  } catch (err) {
    console.error(`delete "${id}" failed:`, err);
    fail(id);
  } finally {
    running.delete(id);
    repaintDeletes();
  }
}

/** The button for `id` lost the focus to nowhere (`gone` is the element that
 *  had it): the list was drawn again, the row was deleted, the button was
 *  hidden, or the window is no longer in front. */
function settle(id: string, gone: HTMLElement) {
  const now = buttonOf(id);
  const redrawn = !!now && now !== gone && usable(now);
  if (armed === id) {
    // Drawn again: the new button is the armed one and keeps the focus.
    if (redrawn && focusLost()) now.focus();
    if (redrawn && document.activeElement === now) return;
    dispatch({ type: "cancel" });
    return;
  }
  if (fired?.id !== id) return;
  if (redrawn) {
    if (focusLost()) now.focus();
    return;
  }
  // Still there and shown (the window went to the back): nothing was deleted yet.
  if (usable(gone)) return;
  // The row is gone. A list that hands the focus on itself (Home's) has done so by now.
  if (focusLost()) {
    const next = fired.around.map(buttonOf).find(usable) ?? afters.get(id)?.();
    if (usable(next)) {
      next.focus();
      handed = { id, to: next };
    }
  }
  fired = null;
}

function wire() {
  if (wired) return;
  wired = true;
  live = document.createElement("div");
  live.id = "delete-live";
  live.className = "sr-only";
  live.setAttribute("role", "status");
  document.body.append(live);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && armed) {
        // Esc has one meaning at a time: with a button armed it only disarms.
        if (usable(buttonOf(armed))) {
          e.preventDefault();
          e.stopPropagation();
        }
        dispatch({ type: "cancel" });
      }
      // Enter held down clicks again and again: the first press arms, the rest do nothing.
      else if (e.key === "Enter" && e.repeat && idOf(e.target)) e.preventDefault();
    },
    true,
  );
  // A click on anything but the armed button.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (armed && idOf(e.target) !== armed) dispatch({ type: "cancel" });
    },
    true,
  );
  // The keyboard's way of going elsewhere. When the focus goes to nothing,
  // the button itself may have gone (a list drawn again, the deleted row):
  // that is looked at once the page is as it will be.
  document.addEventListener("focusout", (e) => {
    const id = idOf(e.target);
    if (!id || (id !== armed && id !== fired?.id)) return;
    if (e.relatedTarget) {
      if (id === armed && idOf(e.relatedTarget) !== armed) dispatch({ type: "cancel" });
      return;
    }
    const gone = (e.target as Element).closest<HTMLElement>("[data-delete-id]")!;
    queueMicrotask(() => settle(id, gone));
  });
}

/** Give `button` the two-click rule. `id` is the thing it deletes, unique in
 *  the window; its part before the first "-" names its list. `onDelete` may
 *  throw or reject: the button then says that the delete failed. */
export function confirmDelete(button: HTMLButtonElement, id: string, onDelete: Action, options: DeleteOptions = {}) {
  wire();
  actions.set(id, onDelete);
  if (options.after) afters.set(id, options.after);
  else afters.delete(id);
  button.type = "button";
  button.dataset.deleteId = id;
  if (options.name) button.dataset.deleteName = options.name;
  if (options.label) button.dataset.deleteLabel = options.label;
  if (options.armedLabel) button.dataset.deleteArmed = options.armedLabel;
  button.addEventListener("click", (e) => {
    if (running.has(id)) return;
    const mine = armed === id;
    dispatch(
      { type: "click", id, since: mine ? e.timeStamp - armedAt : undefined, double: mine && e.detail > 1 && e.detail === armedRun + 1 },
      e.timeStamp,
      e.detail,
    );
  });
  paint(button);
}

/** A "Delete" text button with the rule, for a list row. */
export function deleteButton(id: string, onDelete: Action, options: DeleteOptions = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "btn-text";
  confirmDelete(button, id, onDelete, options);
  return button;
}

/** Say anew what `button` deletes (the row's text was edited). */
export function nameDelete(button: HTMLElement, name: string) {
  if (name) button.dataset.deleteName = name;
  else {
    delete button.dataset.deleteName;
    button.removeAttribute("aria-label");
  }
  paint(button);
}

/** Disarm the button for `id` (what it would delete is no longer what it shows). */
export function disarmDelete(id: string) {
  if (armed === id) dispatch({ type: "cancel" });
}

/** Forget a row that is gone (its id may come back for another thing). */
export function forgetDelete(id: string) {
  actions.delete(id);
  afters.delete(id);
  forgetFailure(id);
  if (armed === id) armed = null;
}
