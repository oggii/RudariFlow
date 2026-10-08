// The dictation history: "Recent dictations" on Home (search over text and
// app; the newest few, "Show all" in chunks of 50), and its count and
// "Delete history" in Settings > General. The entries are the backend's
// (`history_list`); nothing here changes what is kept.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { shown } from "./search.ts";
import { confirmDelete, deleteButton } from "./confirm-delete";

export interface HistoryHost {
  /** "Keep history": "audio", "text" or "off". */
  mode(): string;
  /** Show the "Keep history" setting (Settings > General). */
  openSetting(): void;
  /** The history was read again: how many dictations it has may have changed. */
  changed?(): void;
}

interface HistoryEntry {
  id: number;
  text: string;
  durationMs: number;
  model: string;
  hasAudio: boolean;
  /** Text before AI cleanup, when the AI changed it. */
  raw?: string | null;
  /** Program the dictation went into, e.g. "whatsapp.root". */
  app?: string;
  /** What was said in Edit mode; `raw` then holds the selected text. */
  edit?: string | null;
}

const list = document.getElementById("history-list")!;
const empty = document.getElementById("history-empty")!;
const live = document.getElementById("history-live")!;
const search = document.getElementById("history-search") as HTMLInputElement;
const more = document.getElementById("history-more") as HTMLButtonElement;
const less = document.getElementById("history-less") as HTMLButtonElement;
const count = document.getElementById("history-count")!;
const clear = document.getElementById("history-clear") as HTMLButtonElement;
/** The way from the list to its setting. */
const toSetting = document.getElementById("history-settings") as HTMLButtonElement;

let host: HistoryHost;
let entries: HistoryEntry[] = [];
/** The backend has answered once (or failed to): the history is known. */
let known = false;
/** Numbers the questions to the backend: only the latest one's answer is drawn. */
let asked = 0;
/** "Show all" was clicked. */
let expanded = false;
/** Chunks of 50 shown once expanded (or while searching). */
let pages = 1;
/** The recording that plays: of which dictation, and that row's Play button as the list is drawn now. */
let playing: { audio: HTMLAudioElement; url: string; id: number; btn: HTMLButtonElement } | null = null;
/** Dictations a Re-run is out for. */
const rerunning = new Set<number>();
/** Counts the clicks on Play: of two recordings asked for, only the one asked for last plays. */
let playAsked = 0;

/** A row's action that says something of the moment ("Stop" while its
 *  recording plays, "AI version" while the original shows, a failure) stays
 *  in view; the others show with the pointer on the row or the keyboard in
 *  it (styles/home.css, "Row actions"). */
function keep(btn: HTMLElement, on: boolean) {
  btn.toggleAttribute("data-on", on);
}

function stopPlayback() {
  if (!playing) return;
  playing.audio.pause();
  URL.revokeObjectURL(playing.url);
  playing.btn.textContent = t("history_play");
  keep(playing.btn, false);
  playing = null;
}

/** The list was drawn again: the row that plays has a new Play button. Without that row the playback stops. */
function showPlaying() {
  if (!playing) return;
  const btn = list.querySelector<HTMLButtonElement>(`.history-item[data-id="${playing.id}"] [data-action="play"]`);
  if (!btn) return stopPlayback();
  playing.btn = btn;
  btn.textContent = t("history_stop");
  keep(btn, true);
}

// Dates follow the system locale (24 h in Switzerland even with an English UI).
function formatWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

/** How long a dictation was, written so that it cannot be read as a time
 *  of day beside one: "6 s", "1 min 12 s" (the units are the same in both
 *  languages). */
function formatDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return `${secs} s`;
  return secs % 60 === 0 ? `${secs / 60} min` : `${Math.floor(secs / 60)} min ${secs % 60} s`;
}

/** A row's action as a button. `name` finds the same action again in a row
 *  that was drawn anew. An action that fails says so on its button for a
 *  moment, as a failed Re-run does. */
function action(label: string, onClick: (btn: HTMLButtonElement) => void | Promise<void>, name = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn-text";
  if (name) b.dataset.action = name;
  b.textContent = label;
  b.addEventListener("click", async () => {
    try {
      await onClick(b);
    } catch (err) {
      console.error(`history: "${label}" failed:`, err);
      b.textContent = t("history_action_failed").replace("{action}", () => label);
      keep(b, true);
      setTimeout(() => {
        b.textContent = label;
        keep(b, false);
      }, 2500);
    }
  });
  return b;
}

/** One dictation as a list row: the text, a line with app, time and length, and its actions. */
function renderEntry(e: HistoryEntry): HTMLElement {
  const item = document.createElement("article");
  item.className = "list-row history-item";
  // An item of the list, named after its text: a screen reader says which
  // dictation "Copy" and "Delete" belong to.
  item.setAttribute("role", "listitem");
  item.setAttribute("aria-labelledby", `history-text-${e.id}`);
  item.dataset.id = String(e.id);

  const main = document.createElement("div");
  main.className = "list-main";
  const text = document.createElement("p");
  text.className = "list-primary history-text";
  text.id = `history-text-${e.id}`;
  text.textContent = e.text;
  const meta = document.createElement("span");
  meta.className = "list-secondary history-meta";
  // The app first: it is what a search for an app finds; then when, and
  // for how long ("01:55 · 6 s": a time and a length cannot be mistaken for
  // each other). The three are one line that never breaks, so no dot is
  // left at a line's end; a name too long for it ends in an ellipsis. Which
  // model wrote it is not said here: Home's "loaded" card names the model.
  const parts = [];
  if (e.app) parts.push(e.app);
  parts.push(formatWhen(e.id), formatDuration(e.durationMs));
  const line = document.createElement("span");
  line.className = "history-parts";
  line.textContent = parts.join(" · ");
  meta.append(line);
  // What was said in Edit mode is a sentence: it has a line of its own and wraps like one.
  if (e.edit) {
    const said = document.createElement("span");
    said.className = "history-edit";
    said.textContent = t("history_edit").replace("{instruction}", () => e.edit ?? "");
    meta.append(said);
  }
  main.append(text, meta);

  // The actions end in "Copy" and, apart from it at the card's edge, Delete:
  // what a row can do besides stands before them, so the "Copy" of all rows
  // stand under each other whatever else a row has (styles/home.css).
  const actions = document.createElement("div");
  actions.className = "list-actions history-actions";
  const copy = action(
    t("history_copy"),
    async (b) => {
      await invoke("copy_text", { text: text.textContent ?? "" });
      b.textContent = t("history_copied");
      setTimeout(() => (b.textContent = t("history_copy")), 1200);
    },
    "copy",
  );
  if (e.raw) {
    let showingRaw = false;
    actions.appendChild(
      action(t("history_original"), (b) => {
        showingRaw = !showingRaw;
        text.textContent = showingRaw ? e.raw! : e.text;
        b.textContent = showingRaw ? t("history_ai_version") : t("history_original");
        keep(b, showingRaw);
      }),
    );
  }
  if (e.hasAudio) {
    actions.appendChild(
      action(
        t("history_play"),
        async (b) => {
          const wasThis = playing?.id === e.id;
          stopPlayback();
          const asked = ++playAsked;
          if (wasThis) return;
          try {
            const bytes = await invoke<ArrayBuffer>("history_audio", { id: e.id });
            // Play was clicked again while the recording was fetched (a
            // double-click, another row): that click's recording plays, not
            // this one beside it, which no button could stop any more.
            if (asked !== playAsked) return;
            const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
            const audio = new Audio(url);
            playing = { audio, url, id: e.id, btn: b };
            // The list may have been drawn again while the recording was fetched,
            // or the row is gone: then nothing plays.
            showPlaying();
            if (!playing) return;
            audio.addEventListener("ended", stopPlayback);
            await audio.play();
          } catch (err) {
            console.error("playback failed:", err);
            stopPlayback();
          }
        },
        "play",
      ),
    );
    const rerun = action(
      t("history_rerun"),
      async (b) => {
        // Not `disabled`: a disabled button drops the keyboard focus, and the
        // row is replaced when the answer comes.
        if (rerunning.has(e.id)) return;
        rerunning.add(e.id);
        b.setAttribute("aria-disabled", "true");
        b.textContent = t("history_rerunning");
        try {
          const updated = await invoke<HistoryEntry>("history_rerun", { id: e.id });
          rerunning.delete(e.id);
          if (playing?.id === e.id) stopPlayback();
          entries = entries.map((x) => (x.id === updated.id ? updated : x));
          // A dictation arrived meanwhile and the list was drawn again: this
          // row is no longer the one on screen.
          if (!item.isConnected) return render();
          const focused = item.contains(document.activeElement);
          const fresh = renderEntry(updated);
          item.replaceWith(fresh);
          // The focus was in the row that went: it stays on Re-run.
          if (focused) fresh.querySelector<HTMLElement>('[data-action="rerun"]')?.focus();
        } catch (err) {
          console.error("history_rerun failed:", err);
          rerunning.delete(e.id);
          if (!b.isConnected) return render();
          b.removeAttribute("aria-disabled");
          b.textContent = t("history_rerun_failed");
          keep(b, true);
          setTimeout(() => {
            b.textContent = t("history_rerun");
            keep(b, false);
          }, 2500);
        }
      },
      "rerun",
    );
    if (rerunning.has(e.id)) {
      rerun.setAttribute("aria-disabled", "true");
      rerun.textContent = t("history_rerunning");
    }
    rerun.title = t("history_rerun_title");
    // An edit's recording is the instruction; re-running it as a dictation
    // would replace the edited text with it.
    if (!e.edit) actions.appendChild(rerun);
  }
  actions.appendChild(copy);
  actions.appendChild(
    deleteButton(
      `history-${e.id}`,
      // A delete that fails throws: the button says so and the dictation
      // stays (src/confirm-delete.ts).
      async () => {
        await invoke("history_delete", { id: e.id });
        if (playing?.id === e.id) stopPlayback();
        await refreshHistory();
      },
      { name: e.text.slice(0, 40) },
    ),
  );

  item.append(main, actions);
  return item;
}

/** Where the keyboard focus is in the list: the row, the action in it, and their places. */
interface Place {
  id: string;
  name: string;
  at: number;
  row: number;
}

function focusPlace(): Place | null {
  const el = document.activeElement;
  const row = el instanceof HTMLElement ? el.closest<HTMLElement>(".history-item") : null;
  if (!(el instanceof HTMLElement) || !row || row.parentElement !== list) return null;
  return { id: row.dataset.id ?? "", name: el.dataset.action ?? "", at: [...(el.parentElement?.children ?? [])].indexOf(el), row: [...list.children].indexOf(row) };
}

/** The list was drawn again and the focused button went with the old rows:
 *  the same action of the same dictation takes the focus; after a Delete
 *  "Copy" of the row that moved up (the action that always shows, so the
 *  focus lands on something that is seen); with no row left the search
 *  field, or the text that says the list is empty. */
function restoreFocus(place: Place) {
  const rows = [...list.children] as HTMLElement[];
  const buttons = (row?: HTMLElement) => [...(row?.querySelectorAll<HTMLElement>(".history-actions button") ?? [])];
  const copyOf = (row?: HTMLElement) => row?.querySelector<HTMLElement>('[data-action="copy"]') ?? buttons(row)[0];
  const same = rows.find((row) => row.dataset.id === place.id);
  const target = same
    ? ((place.name ? same.querySelector<HTMLElement>(`[data-action="${place.name}"]`) : null) ?? buttons(same)[place.at] ?? copyOf(same))
    : copyOf(rows[Math.min(place.row, rows.length - 1)]);
  (target ?? (search.classList.contains("hidden") ? empty : search)).focus();
}

/** A button below the list that went away under the focus hands it to the
 *  one that remains, or to the search field. */
function keepFootFocus(gone: HTMLButtonElement, other: HTMLButtonElement) {
  if (document.activeElement !== gone || !gone.classList.contains("hidden")) return;
  (other.classList.contains("hidden") ? search : other).focus();
}

let sayTimer: number | undefined;
/** What a screen reader is told about the list: that it is empty, and how
 *  many dictations a search finds, once the typing rests and not for every key.
 *  Not that it is empty when the keyboard focus went to that very sentence
 *  (the last dictation was deleted): the focus reads it out already. */
function announce(searching: boolean, found: number) {
  window.clearTimeout(sayTimer);
  const text = !empty.classList.contains("hidden")
    ? document.activeElement === empty
      ? ""
      : (empty.textContent ?? "")
    : searching
      ? t(found === 1 ? "home_recent_found_one" : "home_recent_found").replace("{n}", () => String(found))
      : "";
  const say = () => {
    if (live.textContent !== text) live.textContent = text;
  };
  if (searching) sayTimer = window.setTimeout(say, 700);
  else say();
}

/** How many dictations the history has; null until it was read. Home keeps
 *  the list on screen under the setup steps while there is one, and only a
 *  PC without a history is welcomed as new. */
export function historyCount(): number | null {
  return known ? entries.length : null;
}

/** "History is off. …" with the way to the setting that turns it on. */
function offText(): Node[] {
  const link = document.createElement("button");
  link.type = "button";
  link.className = "link-btn";
  link.textContent = t("history_off_open");
  link.addEventListener("click", () => host.openSetting());
  return [document.createTextNode(`${t("history_off")} `), link];
}

function render() {
  const place = focusPlace();
  const searching = search.value.trim() !== "";
  const view = shown(entries, (e) => [e.text, e.app], search.value, expanded, pages);
  list.replaceChildren(...view.rows.map(renderEntry));
  // A recording keeps playing while its row is still in the list (a search, "Show more").
  showPlaying();

  const off = host.mode() === "off";
  // Drawn again only when its words change: the link in it may have the keyboard focus.
  const words = off ? "history_off" : entries.length === 0 ? "history_empty" : "home_recent_none";
  const said = `${words} ${t(words)}`;
  if (empty.dataset.said !== said) {
    empty.dataset.said = said;
    if (off) empty.replaceChildren(...offText());
    else empty.textContent = t(words);
  }
  empty.classList.toggle("hidden", view.rows.length > 0 && !off);
  // With the history off the sentence itself leads to the setting.
  toSetting.classList.toggle("hidden", off);
  search.classList.toggle("hidden", entries.length === 0);

  if (view.canExpand) more.textContent = t("home_recent_all").replace("{n}", () => String(view.found));
  else if (view.more > 0) more.textContent = t("home_recent_more").replace("{n}", () => String(view.more));
  more.classList.toggle("hidden", !view.canExpand && view.more === 0);
  less.classList.toggle("hidden", !expanded || searching);
  if (place) restoreFocus(place);
  announce(searching, view.found);

  count.textContent = entries.length === 1 ? t("history_count_one") : t("history_count").replace("{n}", () => String(entries.length));
  clear.classList.toggle("hidden", entries.length === 0);
}

/** Draw the list again from what is known (the language or "Keep history" changed). */
export function renderHistory() {
  if (host) render();
}

/** Read the history again and redraw (after a dictation, a delete, a change
 *  of "Keep history"). Of two questions that are out, only the later one's
 *  answer is drawn: the earlier one can arrive last, with a list that lacks
 *  the newest dictation or still has a deleted one. */
export async function refreshHistory() {
  const mine = ++asked;
  let answer: HistoryEntry[] | null = null;
  try {
    answer = await invoke<HistoryEntry[]>("history_list");
  } catch (err) {
    console.error("history_list failed:", err);
  }
  if (mine !== asked) return;
  // Without an answer the list stays as it is; it is known as far as it can be.
  if (answer) entries = answer;
  known = true;
  render();
  host.changed?.();
}

export function initHistory(h: HistoryHost) {
  host = h;
  search.addEventListener("input", () => {
    pages = 1;
    render();
  });
  more.addEventListener("click", () => {
    // The short list opens to the first 50; from then on each click adds 50.
    if (!expanded && search.value.trim() === "") expanded = true;
    else pages += 1;
    render();
    keepFootFocus(more, less);
  });
  less.addEventListener("click", () => {
    expanded = false;
    pages = 1;
    render();
    keepFootFocus(less, more);
    document.getElementById("home-recent")?.scrollIntoView({ block: "nearest" });
  });
  confirmDelete(
    clear,
    "history-all",
    async () => {
      await invoke("history_clear");
      await refreshHistory();
    },
    // The button goes with the last dictation: the row above takes the focus.
    { label: "history_clear", armedLabel: "history_clear_confirm", after: () => document.getElementById("history-mode-select") },
  );
  toSetting.addEventListener("click", () => host.openSetting());
  listen("history-updated", () => refreshHistory());
}
