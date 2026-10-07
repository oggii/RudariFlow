// The dictation history: "Recent dictations" on Home (search over text and
// app; the newest few, "Show all" in chunks of 50), and its count and
// "Clear history" in Settings > General. The entries are the backend's
// (`history_list`); nothing here changes what is kept.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { shown } from "./search.ts";

export interface HistoryHost {
  /** "Keep history": "audio", "text" or "off". */
  mode(): string;
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

let host: HistoryHost;
let entries: HistoryEntry[] = [];
/** "Show all" was clicked. */
let expanded = false;
/** Chunks of 50 shown once expanded (or while searching). */
let pages = 1;
/** The recording that plays: of which dictation, and that row's Play button as the list is drawn now. */
let playing: { audio: HTMLAudioElement; url: string; id: number; btn: HTMLButtonElement } | null = null;
/** Dictations a Re-run is out for. */
const rerunning = new Set<number>();

function stopPlayback() {
  if (!playing) return;
  playing.audio.pause();
  URL.revokeObjectURL(playing.url);
  playing.btn.textContent = t("history_play");
  playing = null;
}

/** The list was drawn again: the row that plays has a new Play button. Without that row the playback stops. */
function showPlaying() {
  if (!playing) return;
  const btn = list.querySelector<HTMLButtonElement>(`.history-item[data-id="${playing.id}"] [data-action="play"]`);
  if (!btn) return stopPlayback();
  playing.btn = btn;
  btn.textContent = t("history_stop");
}

// Dates follow the system locale (24 h in Switzerland even with an English UI).
function formatWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

function formatDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
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
      setTimeout(() => (b.textContent = label), 2500);
    }
  });
  return b;
}

/** One dictation as a list row: the text, a line with app, time, length and model, and its actions. */
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
  // The app first: it is what a search for an app finds. The line wraps
  // between two parts, never inside one ("large-v3-turbo-q8_0") and never
  // before a dot: each part is one piece with the dot that follows it.
  const parts = [];
  if (e.app) parts.push(e.app);
  parts.push(formatWhen(e.id), formatDuration(e.durationMs), e.model);
  for (const [i, part] of parts.entries()) {
    const piece = document.createElement("span");
    piece.className = "history-part";
    piece.textContent = i < parts.length - 1 || e.edit ? `${part} ·` : part;
    meta.append(piece, " ");
  }
  // What was said in Edit mode is a sentence: it wraps like one.
  if (e.edit) meta.append(t("history_edit").replace("{instruction}", () => e.edit ?? ""));
  else meta.lastChild?.remove();
  main.append(text, meta);

  const actions = document.createElement("div");
  actions.className = "list-actions history-actions";
  actions.appendChild(
    action(t("history_copy"), async (b) => {
      await invoke("copy_text", { text: text.textContent ?? "" });
      b.textContent = t("history_copied");
      setTimeout(() => (b.textContent = t("history_copy")), 1200);
    }),
  );
  if (e.raw) {
    let showingRaw = false;
    actions.appendChild(
      action(t("history_original"), (b) => {
        showingRaw = !showingRaw;
        text.textContent = showingRaw ? e.raw! : e.text;
        b.textContent = showingRaw ? t("history_ai_version") : t("history_original");
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
          if (wasThis) return;
          try {
            const bytes = await invoke<ArrayBuffer>("history_audio", { id: e.id });
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
          setTimeout(() => (b.textContent = t("history_rerun")), 2500);
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
  actions.appendChild(
    action(t("history_delete"), async () => {
      if (playing && item.contains(playing.btn)) stopPlayback();
      await invoke("history_delete", { id: e.id });
      await refreshHistory();
    }),
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
 *  the same action of the same dictation takes the focus; after a Delete the
 *  first action of the row that moved up; with no row left the search
 *  field, or the text that says the list is empty. */
function restoreFocus(place: Place) {
  const rows = [...list.children] as HTMLElement[];
  const buttons = (row?: HTMLElement) => [...(row?.querySelectorAll<HTMLElement>(".history-actions button") ?? [])];
  const same = rows.find((row) => row.dataset.id === place.id);
  const target = same
    ? ((place.name ? same.querySelector<HTMLElement>(`[data-action="${place.name}"]`) : null) ?? buttons(same)[place.at] ?? buttons(same)[0])
    : buttons(rows[Math.min(place.row, rows.length - 1)])[0];
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
 *  many dictations a search finds, once the typing rests and not for every key. */
function announce(searching: boolean, found: number) {
  window.clearTimeout(sayTimer);
  const text = !empty.classList.contains("hidden")
    ? (empty.textContent ?? "")
    : searching
      ? t(found === 1 ? "home_recent_found_one" : "home_recent_found").replace("{n}", String(found))
      : "";
  const say = () => {
    if (live.textContent !== text) live.textContent = text;
  };
  if (searching) sayTimer = window.setTimeout(say, 700);
  else say();
}

function render() {
  const place = focusPlace();
  const searching = search.value.trim() !== "";
  const view = shown(entries, (e) => [e.text, e.app], search.value, expanded, pages);
  list.replaceChildren(...view.rows.map(renderEntry));
  // A recording keeps playing while its row is still in the list (a search, "Show more").
  showPlaying();

  const off = host.mode() === "off";
  empty.textContent = entries.length === 0 || off ? t(off ? "history_off" : "history_empty") : t("home_recent_none");
  empty.classList.toggle("hidden", view.rows.length > 0 && !off);
  search.classList.toggle("hidden", entries.length === 0);

  if (view.canExpand) more.textContent = t("home_recent_all").replace("{n}", String(view.found));
  else if (view.more > 0) more.textContent = t("home_recent_more").replace("{n}", String(view.more));
  more.classList.toggle("hidden", !view.canExpand && view.more === 0);
  less.classList.toggle("hidden", !expanded || searching);
  if (place) restoreFocus(place);
  announce(searching, view.found);

  count.textContent = entries.length === 1 ? t("history_count_one") : t("history_count").replace("{n}", String(entries.length));
  clear.classList.toggle("hidden", entries.length === 0);
  resetClearButton();
}

/** Read the history again and redraw (after a dictation, a delete, a language change). */
export async function refreshHistory() {
  entries = await invoke<HistoryEntry[]>("history_list");
  render();
}

let clearArmed: number | undefined;
function resetClearButton() {
  window.clearTimeout(clearArmed);
  clearArmed = undefined;
  clear.classList.remove("armed");
  clear.textContent = t("history_clear");
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
  clear.addEventListener("click", async () => {
    if (clearArmed === undefined) {
      clear.classList.add("armed");
      clear.textContent = t("history_clear_confirm");
      clearArmed = window.setTimeout(resetClearButton, 3000);
      return;
    }
    await invoke("history_clear");
    await refreshHistory();
  });
  listen("history-updated", () => refreshHistory());
}
