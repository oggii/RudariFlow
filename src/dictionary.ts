// Dictionary tab: names, brands and jargon Whisper should know. Entries are
// stored as the comma-separated `customPrompt` setting (Whisper's initial
// prompt); the backend also uses them to fix spelling and to guide the AI.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";

export interface DictionaryHost {
  settings(): { customPrompt: string; swissSpelling: boolean; screenContext: boolean; learnDictionary: boolean };
  save(): Promise<void>;
}

const form = document.getElementById("dict-form") as HTMLFormElement;
const input = document.getElementById("dict-input") as HTMLInputElement;
const list = document.getElementById("dict-list")!;
const empty = document.getElementById("dict-empty")!;
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

/// Adds the new entries of `text`; returns how many were new.
async function add(text: string): Promise<number> {
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

function renderSuggestions(suggestions: Suggestion[]) {
  suggestList.innerHTML = "";
  for (const s of suggestions) {
    const row = document.createElement("div");
    row.className = "dict-row";
    const text = document.createElement("span");
    text.className = "dict-suggest-text";
    const word = document.createElement("span");
    word.className = "dict-term";
    word.textContent = s.word;
    const heard = document.createElement("span");
    heard.className = "label-hint";
    heard.textContent =
      t("learn_heard").replace("{heard}", s.heard) + (s.count > 1 ? ` · ${t("learn_seen").replace("{n}", String(s.count))}` : "");
    text.append(word, heard);
    const actions = document.createElement("span");
    actions.className = "dict-suggest-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "btn-secondary";
    addBtn.textContent = t("dictionary_add");
    addBtn.addEventListener("click", () => resolve(s.word, false));
    const dismiss = document.createElement("button");
    dismiss.className = "btn-ghost";
    dismiss.textContent = t("learn_dismiss");
    dismiss.addEventListener("click", () => resolve(s.word, true));
    actions.append(addBtn, dismiss);
    row.append(text, actions);
    suggestList.appendChild(row);
  }
  suggestCard.classList.toggle("hidden", suggestions.length === 0);
}

/// Add a suggestion to the dictionary (or dismiss it for good).
async function resolve(word: string, dismiss: boolean) {
  if (!dismiss) await add(word);
  renderSuggestions(await invoke<Suggestion[]>("learn_resolve", { word, dismiss }));
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
    const added = await add(entries.join("\n"));
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
  swissToggle.checked = !!host.settings().swissSpelling;
  screenToggle.checked = host.settings().screenContext ?? true;
  learnToggle.checked = host.settings().learnDictionary ?? true;
  const terms = stored();
  list.innerHTML = "";
  const sorted = [...terms].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  for (const term of sorted) {
    const row = document.createElement("div");
    row.className = "dict-row";
    const label = document.createElement("span");
    label.className = "dict-term";
    label.textContent = term;
    const remove = document.createElement("button");
    remove.className = "btn-ghost";
    remove.textContent = t("replacement_remove");
    remove.addEventListener("click", () => store(stored().filter((x) => x !== term)));
    row.append(label, remove);
    list.appendChild(row);
  }
  empty.classList.toggle("hidden", terms.length > 0);
  count.textContent =
    terms.length === 1 ? t("dictionary_count_one") : t("dictionary_count").replace("{n}", String(terms.length));
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
  listen<Suggestion[]>("dictionary-suggestions", (e) => renderSuggestions(e.payload));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await add(input.value);
    input.value = "";
    input.focus();
  });
  // A text input turns pasted line breaks into spaces, so lists are split here.
  input.addEventListener("paste", async (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/[,\n]/.test(text)) return;
    e.preventDefault();
    await add(text);
    input.value = "";
  });
}
