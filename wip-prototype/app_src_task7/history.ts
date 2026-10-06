// The dictation history: "Recent dictations" on Home (search over text and
// app; the newest few, "Show all" in chunks of 50), and its count and
// "Clear history" in Settings > General. The entries are the backend's
// (`history_list`); nothing here changes what is kept.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { shown } from "./search.ts";
import { confirmDelete, deleteButton } from "./confirm-delete";

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
let playing: { audio: HTMLAudioElement; url: string; btn: HTMLButtonElement } | null = null;

function stopPlayback() {
  if (!playing) return;
  playing.audio.pause();
  URL.revokeObjectURL(playing.url);
  playing.btn.textContent = t("history_play");
  playing = null;
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

function action(label: string, onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn-text";
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
}

/** One dictation as a list row: the text, a line with app, time, length and model, and its actions. */
function renderEntry(e: HistoryEntry): HTMLElement {
  const item = document.createElement("article");
  item.className = "list-row history-item";

  const main = document.createElement("div");
  main.className = "list-main";
  const text = document.createElement("p");
  text.className = "list-primary history-text";
  text.textContent = e.text;
  const meta = document.createElement("span");
  meta.className = "list-secondary history-meta";
  // The app first: it is what a search for an app finds. The line wraps, nothing is cut.
  const parts = [];
  if (e.app) parts.push(e.app);
  parts.push(formatWhen(e.id), formatDuration(e.durationMs), e.model);
  if (e.edit) parts.push(t("history_edit").replace("{instruction}", e.edit));
  meta.textContent = parts.join(" · ");
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
      action(t("history_play"), async (b) => {
        const wasThis = playing?.btn === b;
        stopPlayback();
        if (wasThis) return;
        try {
          const bytes = await invoke<ArrayBuffer>("history_audio", { id: e.id });
          const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
          const audio = new Audio(url);
          playing = { audio, url, btn: b };
          b.textContent = t("history_stop");
          audio.addEventListener("ended", stopPlayback);
          await audio.play();
        } catch (err) {
          console.error("playback failed:", err);
          stopPlayback();
        }
      }),
    );
    const rerun = action(t("history_rerun"), async (b) => {
      b.disabled = true;
      b.textContent = t("history_rerunning");
      try {
        const updated = await invoke<HistoryEntry>("history_rerun", { id: e.id });
        if (playing && item.contains(playing.btn)) stopPlayback();
        entries = entries.map((x) => (x.id === updated.id ? updated : x));
        item.replaceWith(renderEntry(updated));
        return;
      } catch (err) {
        console.error("history_rerun failed:", err);
        b.textContent = t("history_rerun_failed");
        setTimeout(() => (b.textContent = t("history_rerun")), 2500);
      } finally {
        b.disabled = false;
      }
    });
    rerun.title = t("history_rerun_title");
    // An edit's recording is the instruction; re-running it as a dictation
    // would replace the edited text with it.
    if (!e.edit) actions.appendChild(rerun);
  }
  actions.appendChild(
    deleteButton(
      `history-${e.id}`,
      async () => {
        if (playing && item.contains(playing.btn)) stopPlayback();
        await invoke("history_delete", { id: e.id });
        await refreshHistory();
      },
      { name: e.text.slice(0, 40) },
    ),
  );

  item.append(main, actions);
  return item;
}

function render() {
  stopPlayback();
  const searching = search.value.trim() !== "";
  const view = shown(entries, (e) => [e.text, e.app], search.value, expanded, pages);
  list.replaceChildren(...view.rows.map(renderEntry));

  const off = host.mode() === "off";
  empty.textContent = entries.length === 0 || off ? t(off ? "history_off" : "history_empty") : t("home_recent_none");
  empty.classList.toggle("hidden", view.rows.length > 0 && !off);
  search.classList.toggle("hidden", entries.length === 0);

  if (view.canExpand) more.textContent = t("home_recent_all").replace("{n}", String(view.found));
  else if (view.more > 0) more.textContent = t("home_recent_more").replace("{n}", String(view.more));
  more.classList.toggle("hidden", !view.canExpand && view.more === 0);
  less.classList.toggle("hidden", !expanded || searching);

  count.textContent = entries.length === 1 ? t("history_count_one") : t("history_count").replace("{n}", String(entries.length));
  clear.classList.toggle("hidden", entries.length === 0);
}

/** Read the history again and redraw (after a dictation, a delete, a language change). */
export async function refreshHistory() {
  entries = await invoke<HistoryEntry[]>("history_list");
  render();
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
  });
  less.addEventListener("click", () => {
    expanded = false;
    pages = 1;
    render();
    document.getElementById("home-recent")?.scrollIntoView({ block: "nearest" });
  });
  confirmDelete(
    clear,
    "history-all",
    async () => {
      await invoke("history_clear");
      await refreshHistory();
    },
    { label: "history_clear", armedLabel: "history_clear_confirm" },
  );
  listen("history-updated", () => refreshHistory());
}
