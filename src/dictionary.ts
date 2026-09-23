// Dictionary tab: names, brands and jargon Whisper should know. Entries are
// stored as the comma-separated `customPrompt` setting (Whisper's initial
// prompt); the backend also uses them to fix spelling and to guide the AI.
import { t } from "./i18n";

export interface DictionaryHost {
  settings(): { customPrompt: string };
  save(): Promise<void>;
}

const form = document.getElementById("dict-form") as HTMLFormElement;
const input = document.getElementById("dict-input") as HTMLInputElement;
const list = document.getElementById("dict-list")!;
const empty = document.getElementById("dict-empty")!;
const count = document.getElementById("dict-count")!;
const longHint = document.getElementById("dict-long")!;

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

async function add(text: string) {
  const current = stored();
  const fresh = parseTerms(text).filter((term) => !current.some((c) => c.toLowerCase() === term.toLowerCase()));
  if (fresh.length) await store([...current, ...fresh]);
}

export function renderDictionary() {
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
