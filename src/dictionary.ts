// Dictionary tab: names, brands and jargon Whisper should know. Entries are
// stored as the comma-separated `customPrompt` setting (Whisper's initial
// prompt); the backend also uses them to fix spelling and to guide the AI.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import { deleteButton } from "./confirm-delete";
import { matches } from "./search.ts";

export interface DictionaryHost {
  settings(): { customPrompt: string; swissSpelling: boolean; screenContext: boolean; learnDictionary: boolean };
  save(): Promise<void>;
}

const form = document.getElementById("dict-form") as HTMLFormElement;
const input = document.getElementById("dict-input") as HTMLInputElement;
const list = document.getElementById("dict-list")!;
const empty = document.getElementById("dict-empty")!;
const noMatch = document.getElementById("dict-no-match")!;
const search = document.getElementById("dict-search") as HTMLInputElement;
const live = document.getElementById("dict-live")!;
const count = document.getElementById("dict-count")!;
const longHint = document.getElementById("dict-long")!;
const swissToggle = document.getElementById("swiss-toggle") as HTMLInputElement;
const screenToggle = document.getElementById("screen-toggle") as HTMLInputElement;
const learnToggle = document.getElementById("learn-toggle") as HTMLInputElement;
const suggestCard = document.getElementById("dict-suggest")!;
const suggestList = document.getElementById("dict-suggest-list")!;
const importBtn = document.getElementById("dict-import") as HTMLButtonElement;
const exportBtn = document.getElementById("dict-export") as HTMLButtonElement;
const ioStatus = document.getElementById("dict-io-status")!;

/// Whisper reads about the last 224 tokens of its prompt; past this many
/// characters the oldest entries start to drop out.
const LONG_PROMPT_CHARS = 600;

let host: DictionaryHost;

const sayTimers = new WeakMap<HTMLElement, number>();
/** Tell a screen reader what a search found, once the typing rests and not
 *  for every key (as Home's list does). Also the replacements' search. */
export function sayFound(line: HTMLElement, text: string) {
  window.clearTimeout(sayTimers.get(line));
  sayTimers.set(
    line,
    window.setTimeout(() => {
      if (line.textContent !== text) line.textContent = text;
    }, 700),
  );
}

/// Same rules as `dictionary::terms` in the backend: commas or line breaks
/// separate entries, blanks and case-insensitive duplicates are dropped.
export function parseTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n\r]/)) {
    const term = raw.split(/\s+/).filter(Boolean).join(" ");
    if (term && !out.some((t) => t.toLowerCase() === term.toLowerCase())) out.push(term);
  }
  return out;
}

function stored(): string[] {
  return parseTerms(host.settings().customPrompt ?? "");
}

async function store(terms: string[]) {
  // Insertion order is kept: Whisper favours the end of a long prompt, so
  // the newest entries count first.
  host.settings().customPrompt = terms.join(", ");
  await host.save();
  renderDictionary();
}

/** Delete one word. A save that fails leaves the word in the list and
 *  throws: its Delete button says so (src/confirm-delete.ts). */
async function removeWord(term: string) {
  const before = host.settings().customPrompt;
  try {
    await store(stored().filter((x) => x !== term));
  } catch (err) {
    host.settings().customPrompt = before;
    renderDictionary();
    throw err;
  }
}

/// Adds the new entries of `text`; returns how many were new. Also Home's "Add a word".
export async function addWords(text: string): Promise<number> {
  const current = stored();
  const fresh = parseTerms(text).filter((term) => !current.some((c) => c.toLowerCase() === term.toLowerCase()));
  if (fresh.length) await store([...current, ...fresh]);
  return fresh.length;
}

/// A word the user corrected after a dictation (backend `learn::Suggestion`).
interface Suggestion {
  word: string;
  heard: string;
  count: number;
}

/** The suggestions as the backend last sent them; drawn again with the list (a language change). */
let suggestions: Suggestion[] = [];

function renderSuggestions(now: Suggestion[] = suggestions) {
  suggestions = now;
  suggestList.innerHTML = "";
  for (const s of suggestions) {
    const row = document.createElement("div");
    row.className = "list-row dict-row";
    row.setAttribute("role", "listitem");
    const text = document.createElement("span");
    text.className = "list-main dict-suggest-text";
    const word = document.createElement("span");
    word.className = "list-primary dict-term";
    word.textContent = s.word;
    const heard = document.createElement("span");
    heard.className = "list-secondary";
    heard.textContent =
      t("learn_heard").replace("{heard}", s.heard) + (s.count > 1 ? ` · ${t("learn_seen").replace("{n}", String(s.count))}` : "");
    text.append(word, heard);
    const actions = document.createElement("span");
    actions.className = "list-actions dict-suggest-actions";
    // Named after their word: a screen reader says which one "Add" adds.
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn-text";
    addBtn.dataset.suggest = "add";
    addBtn.textContent = t("dictionary_add");
    addBtn.setAttribute("aria-label", `${t("dictionary_add")}: ${s.word}`);
    addBtn.addEventListener("click", () => resolve(s.word, false));
    // Not a delete: a suggestion is the app's guess, not something the user
    // made, so one click puts it away ("Dismiss").
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn-text";
    dismiss.dataset.suggest = "dismiss";
    dismiss.textContent = t("learn_dismiss");
    dismiss.setAttribute("aria-label", `${t("learn_dismiss")}: ${s.word}`);
    dismiss.addEventListener("click", () => resolve(s.word, true));
    actions.append(addBtn, dismiss);
    row.append(text, actions);
    suggestList.appendChild(row);
  }
  suggestCard.classList.toggle("hidden", suggestions.length === 0);
}

/// Add a suggestion to the dictionary (or dismiss it for good).
async function resolve(word: string, dismiss: boolean) {
  const held = suggestList.contains(document.activeElement);
  if (!dismiss) await addWords(word);
  renderSuggestions(await invoke<Suggestion[]>("learn_resolve", { word, dismiss }));
  // The row went with the button that was pressed: the same button of the
  // first suggestion left takes the focus, or the field that adds a word.
  if (!held || (document.activeElement && document.activeElement !== document.body)) return;
  (suggestList.querySelector<HTMLElement>(`[data-suggest="${dismiss ? "dismiss" : "add"}"]`) ?? input).focus();
}

async function loadSuggestions() {
  try {
    renderSuggestions(await invoke<Suggestion[]>("learn_suggestions"));
  } catch {
    renderSuggestions([]);
  }
}

const FILE_FILTERS = [{ name: "Text", extensions: ["txt", "csv"] }];

function showIoStatus(text: string, tone = "") {
  ioStatus.textContent = text;
  ioStatus.dataset.tone = tone;
}

async function exportDictionary() {
  const path = await save({ defaultPath: "rudariflow-dictionary.txt", filters: FILE_FILTERS });
  if (!path) return;
  try {
    const n = await invoke<number>("dictionary_export", { path });
    const file = path.split(/[\\/]/).pop() ?? path;
    showIoStatus(t("dictionary_exported").replace("{n}", String(n)).replace("{file}", file));
  } catch (e) {
    showIoStatus(`${t("dictionary_io_failed")}: ${e}`, "error");
  }
}

async function importDictionary() {
  const path = await open({ multiple: false, directory: false, filters: FILE_FILTERS });
  if (!path || Array.isArray(path)) return;
  try {
    const entries = await invoke<string[]>("dictionary_read_file", { path });
    const added = await addWords(entries.join("\n"));
    showIoStatus(
      added > 0
        ? t("dictionary_imported").replace("{n}", String(added)).replace("{total}", String(entries.length))
        : t("dictionary_imported_none").replace("{total}", String(entries.length)),
    );
  } catch (e) {
    showIoStatus(`${t("dictionary_io_failed")}: ${e}`, "error");
  }
}

export function renderDictionary() {
  renderSuggestions();
  swissToggle.checked = !!host.settings().swissSpelling;
  screenToggle.checked = host.settings().screenContext ?? true;
  learnToggle.checked = host.settings().learnDictionary ?? true;
  const terms = stored();
  list.innerHTML = "";
  const sorted = [...terms].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  // The list is drawn from the setting, so the search simply leaves rows out.
  const found = sorted.filter((term) => matches([term], search.value));
  for (const term of found) {
    const row = document.createElement("div");
    row.className = "list-row dict-row";
    row.setAttribute("role", "listitem");
    const label = document.createElement("span");
    label.className = "list-main dict-term";
    label.textContent = term;
    const actions = document.createElement("span");
    actions.className = "list-actions";
    // After the last word the field that adds one takes the focus.
    actions.append(deleteButton(`word-${term}`, () => removeWord(term), { name: term, after: () => input }));
    row.append(label, actions);
    list.appendChild(row);
  }
  empty.classList.toggle("hidden", terms.length > 0);
  noMatch.classList.toggle("hidden", terms.length === 0 || found.length > 0);
  search.classList.toggle("hidden", terms.length === 0);
  // "12" after the title; "3 of 12" while a search leaves words out.
  count.textContent = (found.length < terms.length ? t("dictionary_count_found").replace("{found}", String(found.length)) : t("dictionary_count")).replace("{n}", String(terms.length));
  count.classList.toggle("hidden", terms.length === 0);
  longHint.classList.toggle("hidden", (host.settings().customPrompt ?? "").length < LONG_PROMPT_CHARS);
}

export function initDictionary(h: DictionaryHost) {
  host = h;
  exportBtn.addEventListener("click", exportDictionary);
  importBtn.addEventListener("click", importDictionary);
  swissToggle.addEventListener("change", async () => {
    host.settings().swissSpelling = swissToggle.checked;
    await host.save();
  });
  screenToggle.addEventListener("change", async () => {
    host.settings().screenContext = screenToggle.checked;
    await host.save();
  });
  learnToggle.addEventListener("change", async () => {
    host.settings().learnDictionary = learnToggle.checked;
    await host.save();
  });
  loadSuggestions();
  search.addEventListener("input", () => {
    renderDictionary();
    const found = list.children.length;
    sayFound(live, search.value.trim() === "" ? "" : found === 0 ? t("dict_no_match") : t("dict_found").replace("{found}", String(found)).replace("{n}", String(stored().length)));
  });
  listen<Suggestion[]>("dictionary-suggestions", (e) => renderSuggestions(e.payload));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await addWords(input.value);
    input.value = "";
    input.focus();
  });
  // A text input turns pasted line breaks into spaces, so lists are split here.
  input.addEventListener("paste", async (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/[,\n]/.test(text)) return;
    e.preventDefault();
    await addWords(text);
    input.value = "";
  });
}
