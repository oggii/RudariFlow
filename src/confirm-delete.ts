// The one way to delete, on every delete button of the app: the first click
// arms it ("Delete?"), the second deletes; Esc, a click elsewhere or the
// focus moving away disarms. The rule itself is src/arm.ts.
//
// A button is known by an id ("history-17", "word-Zürich"), not by its
// element: lists are redrawn while a button is armed, and the new button
// for the same id comes back armed and, if the old one had it, with the
// keyboard focus.
//
// What else every delete gets here: a double-click, a burst of clicks or a
// held Enter deletes nothing; an armed button that is scrolled out of view
// disarms; a screen reader hears that the button is armed (#delete-live)
// and what it deletes (the button's name); a delete that fails says so on
// its button and aloud, and the thing stays; while a delete runs its button
// rests; and when the deleted row takes the button away under the keyboard
// focus, the next row's Delete gets it.
import { t } from "./i18n";
import { arm, AT_REST, type ArmEvent, type ArmState } from "./arm.ts";

export interface DeleteOptions {
  /** What it deletes, for a screen reader: "Delete: Airhorn". */
  name?: string;
  /** i18n key of the text at rest, when it is not "Delete" ("history_clear"). */
  label?: string;
  /** i18n key of the armed text, when it is not "Delete?" ("history_clear_confirm"). */
  armedLabel?: string;
  /** i18n key of what a screen reader hears when it is armed, when the
   *  button's word is not "Delete" ("files_clear_said"). */
  armedSaid?: string;
  /** Where the keyboard focus goes when the last row of a list was deleted
   *  and its button went with it (the field that adds a new one, say). */
  after?: () => HTMLElement | null;
}

type Action = () => void | Promise<void>;
type After = (() => HTMLElement | null) | undefined;

/** Thrown by a delete that failed and has said why itself, in a live region
 *  of its own page (a notice beside the item). The button shows the failure
 *  like every other; the live line here stays silent, so a screen reader
 *  hears of the failure once, with its reason. */
export class FailureSaid extends Error {}

/** How long a button says that its delete failed. */
const FAILED_MS = 2500;

/** The armed button, and when it was last clicked (src/arm.ts). */
let state: ArmState = AT_REST;
/** When Enter last repeated (the event's time stamp): the click that follows
 *  it at once is the key's repeat. A time, not a flag: a key that never comes
 *  up (the window lost the focus while it was held) must not mute the keyboard. */
let heldAt = -Infinity;
/** A click this soon after a repeated Enter is that repeat's click. */
const HELD_MS = 50;
/** Deletes that run: a second word for one changes nothing. */
const running = new Set<string>();
/** Deletes that failed, until their button says "Delete" again. */
const failed = new Map<string, number>();
/** The delete that was confirmed last, the buttons of its list around it
 *  (the rows after it first) and where the focus goes after the list's last
 *  row: one of them takes the focus when its row goes. Nothing else is kept
 *  of a button: what it deletes is its own click's business, so a row that
 *  is gone leaves nothing behind here. */
let fired: { id: string; around: string[]; after: After } | null = null;
/** Where the focus was handed when that row went: a delete that fails after all takes it back. */
let handed: { id: string; to: HTMLElement } | null = null;
/** Read out, not shown: that a button is armed, that a delete failed. */
let live: HTMLElement | null = null;
/** What the live line is about now: it is worded again when the button is
 *  drawn again (a change of the Display Language). */
let saying: { id: string; failure: boolean } | null = null;
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

/** Some of `el` shows: in the window, and in every box around it that cuts
 *  off what it holds (a page or a list that scrolls). */
function inView(el: HTMLElement): boolean {
  const own = el.getBoundingClientRect();
  let top = Math.max(own.top, 0);
  let bottom = Math.min(own.bottom, window.innerHeight);
  let left = Math.max(own.left, 0);
  let right = Math.min(own.right, window.innerWidth);
  // The window stands for <body> and <html>.
  for (let box = el.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
    if (bottom <= top || right <= left) return false;
    const style = getComputedStyle(box);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const edge = box.getBoundingClientRect();
    top = Math.max(top, edge.top + box.clientTop);
    bottom = Math.min(bottom, edge.top + box.clientTop + box.clientHeight);
    left = Math.max(left, edge.left + box.clientLeft);
    right = Math.min(right, edge.left + box.clientLeft + box.clientWidth);
  }
  return bottom > top && right > left;
}

/** What the live line says of `button`, in the language of now: that it is
 *  armed, in the button's own word ("Press again to clear"), or that its
 *  delete failed. */
function words(button: HTMLElement | null, failure: boolean): string {
  const name = button?.dataset.deleteName;
  if (failure) return t("history_action_failed").replace("{action}", () => t(button?.dataset.deleteLabel ?? "delete")) + (name ? `: ${name}` : "");
  const own = button?.dataset.deleteSaid;
  if (own) return t(own);
  return name ? t("delete_armed_said").replace("{name}", () => name) : t("delete_armed_said_plain");
}

/** The live line as it should read now. The same words are not written again: nothing is read out twice. */
function resay(button: HTMLElement | null = saying ? buttonOf(saying.id) : null) {
  const text = saying ? words(button, saying.failure) : "";
  if (live && live.textContent !== text) live.textContent = text;
}

function paint(button: HTMLElement) {
  const id = button.dataset.deleteId ?? "";
  const name = button.dataset.deleteName;
  const rest = t(button.dataset.deleteLabel ?? "delete");
  const ask = t(button.dataset.deleteArmed ?? "delete_confirm");
  const on = id === state.armed;
  const text = failed.has(id) ? t("history_action_failed").replace("{action}", () => rest) : on ? ask : rest;
  button.classList.toggle("armed", on);
  if (button.textContent !== text) button.textContent = text;
  // For a style sheet that shows a row's actions only while they are needed
  // (Home's dictations): a failure stays in view.
  button.toggleAttribute("data-on", failed.has(id));
  // The button keeps the width of the wider of its two texts, so arming it
  // moves nothing beside it (styles/components.css).
  button.dataset.deleteRest = rest;
  button.dataset.deleteAsk = ask;
  // The name says the same as the button, then what it deletes.
  if (name) button.setAttribute("aria-label", on ? `${text} ${name}` : `${text}: ${name}`);
  if (running.has(id)) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
  // The line that is read out follows its button: the name, the language.
  if (saying?.id === id) resay(button);
}

/** Every delete button's text again, and the line that is read out (once
 *  the Display Language is known, and after it changed). */
export function repaintDeletes() {
  for (const button of buttons()) paint(button);
  resay();
}

/** `confirmed`: the delete of the button that was clicked, should this click be the answer. */
function dispatch(event: ArmEvent, confirmed?: { action: Action; after: After }) {
  const before = state.armed;
  const step = arm(state, event);
  state = { armed: step.armed, last: step.last, run: step.run };
  if (state.armed !== before) {
    if (state.armed) forgetFailure(state.armed);
    saying = state.armed ? { id: state.armed, failure: false } : null;
  }
  repaintDeletes();
  if (state.armed && state.armed !== before) {
    // Armed from the keyboard after the page was scrolled: "Delete?" must be
    // seen before it is answered. (A click is always on a button that shows.)
    const button = buttonOf(state.armed);
    if (button && !inView(button)) button.scrollIntoView({ block: "center", inline: "nearest" });
  }
  if (step.fire && confirmed) void carryOut(step.fire, confirmed.action, confirmed.after);
}

function forgetFailure(id: string) {
  window.clearTimeout(failed.get(id));
  failed.delete(id);
  if (saying?.id === id && saying.failure) saying = null;
}

/** The delete of `id` did not work: its button says so for a moment, and so
 *  does the live line, unless the page has said why itself (`said`). The row
 *  may have gone and come back meanwhile: the focus that was handed on, or
 *  lost, is on its button again. */
function fail(id: string, said: boolean) {
  forgetFailure(id);
  const button = buttonOf(id);
  if (usable(button) && (focusLost() || (handed?.id === id && document.activeElement === handed.to))) button.focus();
  failed.set(
    id,
    window.setTimeout(() => {
      forgetFailure(id);
      repaintDeletes();
    }, FAILED_MS),
  );
  if (!said) saying = { id, failure: true };
}

/** The confirmed delete. A caller's delete may throw: the failure is shown here. */
async function carryOut(id: string, action: Action, after: After) {
  if (running.has(id)) return;
  const peers = buttons()
    .filter(usable)
    .map((b) => b.dataset.deleteId ?? "")
    .filter((other) => listOf(other) === listOf(id));
  const at = peers.indexOf(id);
  fired = { id, around: at < 0 ? [] : [...peers.slice(at + 1), ...peers.slice(0, at).reverse()], after };
  handed = null;
  running.add(id);
  repaintDeletes();
  try {
    await action();
  } catch (err) {
    console.error(`delete "${id}" failed:`, err);
    fail(id, err instanceof FailureSaid);
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
  if (state.armed === id) {
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
    const next = fired.around.map(buttonOf).find(usable) ?? fired.after?.();
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
      // Enter held down clicks again and again: the rule takes those clicks
      // for what they are (src/arm.ts). The click follows its keydown at
      // once. (Space clicks when the key comes up: once, however long it was held.)
      if (e.key === "Enter" && e.repeat) heldAt = e.timeStamp;
      if (e.key === "Escape" && state.armed) {
        // Esc has one meaning at a time: with a button armed it only disarms.
        if (usable(buttonOf(state.armed))) {
          e.preventDefault();
          e.stopPropagation();
        }
        dispatch({ type: "cancel" });
      }
    },
    true,
  );
  // A click on anything but the armed button.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (state.armed && idOf(e.target) !== state.armed) dispatch({ type: "cancel" });
    },
    true,
  );
  // Scrolled out of view, the button would stay armed and keep the keyboard
  // focus: Enter would then delete what nobody sees. Whatever scrolls (the
  // page, a list in it, the window), an armed button that no longer shows
  // disarms. Scroll events do not bubble: caught on their way down.
  document.addEventListener(
    "scroll",
    () => {
      if (!state.armed) return;
      const button = buttonOf(state.armed);
      if (button && !inView(button)) dispatch({ type: "cancel" });
    },
    { capture: true, passive: true },
  );
  // The keyboard's way of going elsewhere. When the focus goes to nothing,
  // the button itself may have gone (a list drawn again, the deleted row):
  // that is looked at once the page is as it will be.
  document.addEventListener("focusout", (e) => {
    const id = idOf(e.target);
    if (!id || (id !== state.armed && id !== fired?.id)) return;
    if (e.relatedTarget) {
      if (id === state.armed && idOf(e.relatedTarget) !== state.armed) dispatch({ type: "cancel" });
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
  button.type = "button";
  button.dataset.deleteId = id;
  if (options.name) button.dataset.deleteName = options.name;
  if (options.label) button.dataset.deleteLabel = options.label;
  if (options.armedLabel) button.dataset.deleteArmed = options.armedLabel;
  if (options.armedSaid) button.dataset.deleteSaid = options.armedSaid;
  button.addEventListener("click", (e) => {
    if (running.has(id)) return;
    // `detail` counts the clicks of a multi-click; the keyboard's click has 0.
    dispatch({ type: "click", id, at: e.timeStamp, count: e.detail, held: e.detail === 0 && e.timeStamp - heldAt < HELD_MS }, { action: onDelete, after: options.after });
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

/** Say anew what `button` deletes (the row's text was edited, another meeting is open). */
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
  if (state.armed === id) dispatch({ type: "cancel" });
}

/** Forget a row that is gone (its id may come back for another thing). */
export function forgetDelete(id: string) {
  forgetFailure(id);
  if (state.armed === id) dispatch({ type: "cancel" });
  else resay();
}
