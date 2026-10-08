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

/** What a "More" is about: its row's label, or the heading of the card it
 *  stands in; one that stands for several rows says so itself (`data-about`,
 *  an i18n key). */
function nameMore(more: HTMLElement) {
  const about = more.closest(".setting-row")?.querySelector(".label-text") ?? more.closest(".card")?.querySelector(".list-title");
  const text = more.dataset.about ? t(more.dataset.about) : (about?.textContent ?? "").trim();
  if (!text) return;
  const open = more.getAttribute("aria-expanded") === "true";
  more.setAttribute("aria-label", t(open ? "hint_less_about" : "hint_more_about").replace("{label}", () => text));
}

/** A "More" under a text that shows only its first lines (`data-clamps`; the
 *  style sheet cuts the text and opens it, as with `data-shows`). The button
 *  is there only while there is more of the text than its cut form shows:
 *  measured as the text is cut, so it follows the window's width. A text
 *  that is written anew starts closed: a new summary shows its first lines. */
export function initClamps() {
  for (const more of document.querySelectorAll<HTMLElement>(".hint-more[data-clamps]")) {
    const text = document.getElementById(more.getAttribute("aria-controls") ?? "");
    if (!text) continue;
    const close = () => {
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("data-i18n", "hint_more");
      more.textContent = t("hint_more");
      nameMore(more);
    };
    const look = () => {
      // Not on screen: nothing to measure, and nothing to change.
      if (text.clientHeight === 0) return;
      // Measured in the cut form: opened, the text is whole and says nothing about it. "Less" stays for as
      // long as that form would cut the text again, and goes once it would show all of it (a wider window).
      const open = more.getAttribute("aria-expanded") === "true";
      if (open) more.setAttribute("aria-expanded", "false");
      const cut = text.scrollHeight > text.clientHeight + 1;
      if (open && cut) return void more.setAttribute("aria-expanded", "true");
      if (open) close();
      // The button goes with the last line it was for: the focus moves to the text's own "Copy" or "Hide".
      if (!cut && document.activeElement === more) more.parentElement?.querySelector<HTMLElement>("button:not(.hint-more)")?.focus();
      more.hidden = !cut;
    };
    new ResizeObserver(look).observe(text);
    new MutationObserver(() => {
      close();
      look();
    }).observe(text, { childList: true, characterData: true, subtree: true });
  }
}

/** "More" / "Less" after a hint, anywhere in the window (also in rows built later). */
export function initHints() {
  document.addEventListener("click", (e) => {
    const more = (e.target as HTMLElement).closest<HTMLElement>(".hint-more");
    // The Soundboard redraws its rows and keeps their state itself.
    if (!more || more.dataset.own !== undefined) return;
    const longs = (more.getAttribute("aria-controls") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (longs.length === 0) return;
    const open = more.getAttribute("aria-expanded") !== "true";
    more.setAttribute("aria-expanded", String(open));
    // `data-shows`: the style sheet shows what it opens (Files' options,
    // whose hints a page without a file shows anyway).
    if (more.dataset.shows === undefined) for (const long of longs) long.hidden = !open;
    // The key too, so a language change keeps the right word.
    more.setAttribute("data-i18n", open ? "hint_less" : "hint_more");
    more.textContent = t(open ? "hint_less" : "hint_more");
    nameMore(more);
  });
}
