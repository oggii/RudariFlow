// Setting rows: every control gets its accessible name from its row's label
// (so no row can be forgotten), and "More" after a one-line hint opens the
// long text in place.
import { t } from "./i18n";

let ids = 0;

/**
 * Name the controls of every `.setting-row` under `root` after the row's
 * `.label-text`. Call it again after a language change: the "Turn off"
 * buttons next to the hotkeys carry the label's text.
 */
export function nameRows(root: ParentNode = document) {
  for (const row of root.querySelectorAll<HTMLElement>(".setting-row")) {
    const label = row.querySelector<HTMLElement>(".label-text");
    if (!label) continue;
    if (!label.id) label.id = `row-label-${++ids}`;
    for (const control of row.querySelectorAll<HTMLElement>(".setting-control :is(select, textarea, input)")) {
      // A switch is a switch to a screen reader, not a checkbox.
      if (control.matches(".switch input")) control.setAttribute("role", "switch");
      if (control.hasAttribute("aria-label") || control.hasAttribute("aria-labelledby")) continue;
      control.setAttribute("aria-labelledby", label.id);
    }
    // A key box reads "Paste last dictation, Alt+Shift+V".
    for (const key of row.querySelectorAll<HTMLElement>(".setting-control .hotkey-btn")) {
      const kbd = key.querySelector("kbd");
      if (!kbd || key.hasAttribute("aria-labelledby")) continue;
      if (!kbd.id) kbd.id = `row-key-${++ids}`;
      key.setAttribute("aria-labelledby", `${label.id} ${kbd.id}`);
    }
    // The × next to it: "Turn off: Paste last dictation".
    for (const off of row.querySelectorAll<HTMLElement>(".hotkey-control .icon-btn[data-i18n-title]")) {
      off.setAttribute("aria-label", `${t(off.getAttribute("data-i18n-title") ?? "")}: ${label.textContent ?? ""}`);
    }
  }
  // "More" after a hint says what it is about: "More about PC check".
  for (const more of root.querySelectorAll<HTMLElement>(".hint-more:not([data-own])")) nameMore(more);
}

/** What a "More" is about: its row's label, or the heading of the card it stands in. */
function nameMore(more: HTMLElement) {
  const about = more.closest(".setting-row")?.querySelector(".label-text") ?? more.closest(".card")?.querySelector(".list-title");
  const text = (about?.textContent ?? "").trim();
  if (!text) return;
  const open = more.getAttribute("aria-expanded") === "true";
  more.setAttribute("aria-label", t(open ? "hint_less_about" : "hint_more_about").replace("{label}", () => text));
}

/** "More" / "Less" after a hint, anywhere in the window (also in rows built later). */
export function initHints() {
  document.addEventListener("click", (e) => {
    const more = (e.target as HTMLElement).closest<HTMLElement>(".hint-more");
    if (!more) return;
    const long = document.getElementById(more.getAttribute("aria-controls") ?? "");
    if (!long) return;
    const open = more.getAttribute("aria-expanded") !== "true";
    more.setAttribute("aria-expanded", String(open));
    long.hidden = !open;
    // The key too, so a language change keeps the right word.
    more.setAttribute("data-i18n", open ? "hint_less" : "hint_more");
    more.textContent = t(open ? "hint_less" : "hint_more");
    nameMore(more);
  });
}
