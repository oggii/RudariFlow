// The window's frame: the five sidebar sections, the Settings tabs and the
// Advanced folds, and what the window remembers of them (src/prefs.ts).
import { TABS, resolve, route, startRoute, type Route } from "./route.ts";
import { changePrefs, loadPrefs, type Prefs } from "./prefs.ts";

type Listener = (now: Route, before: Route) => void;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // a private window: the window just forgets
  }
}

/** What the window remembers. Read it; change it with `updatePrefs`. */
export let prefs: Prefs = loadPrefs(storage());

/** Change what the window remembers and save it (the pop-out's changes are kept, see `changePrefs`). */
export function updatePrefs(change: (prefs: Prefs) => void) {
  prefs = changePrefs(storage(), prefs, change);
}

let current: Route = route(prefs.section, prefs.tab);
/** The user chose a place: the start no longer moves the window (`startOn`). */
let chosen = false;
const listeners: Listener[] = [];

export function currentRoute(): Route {
  return current;
}

/** Called after every change of the section or the Settings tab, and once
 *  for the place the window starts on (`announceRoute`). */
export function onRoute(fn: Listener) {
  listeners.push(fn);
}

/** Tell every `onRoute` listener the place that shows, as if the window had
 *  just come to it. Called once at the start, after all of them registered:
 *  a window that opens on a remembered place makes no change, and a page
 *  that waits to be shown (the Soundboard for a dropped sound, AI cleanup
 *  for the open apps) would never learn that it is. A listener may hear of
 *  the same place twice (a change during the start), so what it does must
 *  bear repeating. */
export function announceRoute() {
  for (const fn of listeners) fn(current, current);
}

function draw() {
  for (const item of document.querySelectorAll<HTMLElement>(".nav-item")) {
    if (item.dataset.section === current.section) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  for (const section of document.querySelectorAll<HTMLElement>(".content-section")) {
    section.classList.toggle("active", section.id === `section-${current.section}`);
  }
  for (const tab of document.querySelectorAll<HTMLElement>("#settings-tabs [role=tab]")) {
    const on = tab.dataset.tab === current.tab;
    tab.setAttribute("aria-selected", String(on));
    // Arrow keys move between the tabs; Tab goes from the selected one into its panel.
    tab.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(`panel-${tab.dataset.tab}`);
    if (panel) panel.hidden = !on;
  }
}

function show(next: Route, remember: boolean) {
  const before = current;
  const moved = next.section !== before.section || next.tab !== before.tab;
  current = next;
  draw();
  if (remember) {
    updatePrefs((p) => {
      p.section = current.section;
      p.tab = current.tab;
    });
  }
  if (moved) {
    endVisits();
    document.getElementById("content")?.scrollTo(0, 0);
  }
  for (const fn of listeners) fn(current, before);
}

/** Show a place: "home", "settings", "settings/models", or a section name of 0.16 ("engine"). */
export function go(name: string) {
  chosen = true;
  show(resolve(name, current), true);
}

/** Once, when the first status is known: Home for a first run, unless the
 *  user has gone somewhere already. */
export function startOn(firstRun: boolean) {
  if (chosen) return;
  const start = startRoute(current, firstRun);
  if (start.section !== current.section) show(start, false);
}

/** Folds a link opened to show a control in them (`reveal`): open for the
 *  visit, not remembered. A fold is remembered as the user leaves it, and
 *  the user did not open this one. */
const visited = new Set<HTMLDetailsElement>();

/** The visit is over (the user went to another place): a fold a link opened is as it is remembered again. */
function endVisits() {
  for (const fold of visited) {
    if (fold.closest<HTMLElement>(".tab-panel")?.hidden === false && current.section === "settings") continue;
    visited.delete(fold);
    fold.open = prefs.folds[fold.dataset.fold ?? ""] === true;
  }
}

/** Show the control with this id: its section, its tab, its fold open, scrolled to and focused. */
export function reveal(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const panel = el.closest<HTMLElement>(".tab-panel");
  const section = el.closest<HTMLElement>(".content-section");
  if (panel) go(`settings/${panel.id.replace("panel-", "")}`);
  else if (section) go(section.id.replace("section-", ""));
  const fold = el.closest<HTMLDetailsElement>("details.fold");
  if (fold && !fold.open) {
    visited.add(fold);
    fold.open = true;
  }
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
}

// ── The window's width ────────────────────────────────

/** From this much room beside the sidebar a page is two columns (Home). */
export const WIDE = 900;
/** From this much it has room for more: Home's controls are two columns of
 *  cards themselves, and a Settings tab is two columns. */
export const WIDER = 1600;

/** The room beside the sidebar, with the scrollbar's own room in it.
 *  `clientWidth` loses that room when the page gets a scrollbar: a layout
 *  that is decided on it and is higher in one form than in the other brings
 *  its own scrollbar, loses the width, steps back, loses the scrollbar, and
 *  so on in every frame. Every layout step is decided on this width. */
export function roomBeside(): number {
  return document.getElementById("content")?.offsetWidth ?? 0;
}

/** The pages that are two columns in a large window: Settings (styles/settings.css),
 *  Files (the drop zone beside its options) and the Meetings library (style.css). */
const WIDER_PAGES = ["section-settings", "section-files", "section-meetings"];

function layoutWider() {
  const wider = roomBeside() >= WIDER;
  for (const id of WIDER_PAGES) document.getElementById(id)?.classList.toggle("wider", wider);
}

/** Wire the sidebar, the tab bar and the folds, and show the remembered place. */
export function initShell() {
  for (const item of document.querySelectorAll<HTMLElement>(".nav-item")) {
    item.addEventListener("click", () => go(item.dataset.section ?? "home"));
  }

  const tabs = [...document.querySelectorAll<HTMLElement>("#settings-tabs [role=tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => go(`settings/${tab.dataset.tab}`));
    tab.addEventListener("keydown", (e) => {
      const at = TABS.indexOf(current.tab);
      const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
      // Left of the first tab is the last one: -1 is a place here, not "no key".
      if (to === null) return;
      e.preventDefault();
      const next = TABS[(to + TABS.length) % TABS.length];
      go(`settings/${next}`);
      document.getElementById(`tab-${next}`)?.focus();
    });
  }

  // An Advanced fold stays as the user left it, per tab.
  for (const fold of document.querySelectorAll<HTMLDetailsElement>("details.fold[data-fold]")) {
    const key = fold.dataset.fold ?? "";
    fold.open = prefs.folds[key] === true;
    fold.addEventListener("toggle", () => {
      // Opened by a link to a control in it: for this visit, nothing is saved.
      if (fold.open && visited.has(fold)) return;
      // Anything else is the user's own word (or the end of a visit, which changes nothing).
      visited.delete(fold);
      if ((prefs.folds[key] === true) === fold.open) return;
      updatePrefs((p) => (p.folds[key] = fold.open));
    });
  }

  const content = document.getElementById("content");
  if (content) new ResizeObserver(layoutWider).observe(content);
  layoutWider();

  draw();
}
