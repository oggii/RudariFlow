// Files tab: transcribe an audio or video file (drop it anywhere on the
// window or choose it), with the text appearing block by block, and an
// optional AI summary. The work runs in the backend (`transcribe_file`,
// `summarize_text`).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getLang, t } from "./i18n";
import { populateLanguageSelect } from "./languages";

export interface FilesHost {
  settings(): { language: string };
  /** Show the Files section (a file dropped on another tab). */
  showSection(): void;
}

interface FileTranscript {
  text: string;
  textWithTimes: string;
  language: string;
  durationMs: number;
  elapsedMs: number;
}

interface FileProgress {
  phase: "reading" | "loading" | "transcribing";
  done: number;
  total: number;
  text: string;
}

const EXTENSIONS = ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "oga", "wma", "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "3gp", "amr"];

const drop = document.getElementById("file-drop")!;
const chooseBtn = document.getElementById("file-choose") as HTMLButtonElement;
const languageSelect = document.getElementById("file-language") as HTMLSelectElement;
const job = document.getElementById("file-job")!;
const nameEl = document.getElementById("file-name")!;
const statusEl = document.getElementById("file-status")!;
const cancelBtn = document.getElementById("file-cancel") as HTMLButtonElement;
const fill = document.getElementById("file-progress-fill")!;
const result = document.getElementById("file-result")!;
const timesToggle = document.getElementById("file-times") as HTMLInputElement;
const textArea = document.getElementById("file-text") as HTMLTextAreaElement;
const copyBtn = document.getElementById("file-copy") as HTMLButtonElement;
const saveBtn = document.getElementById("file-save") as HTMLButtonElement;
const summarizeBtn = document.getElementById("file-summarize") as HTMLButtonElement;
const summaryBox = document.getElementById("file-summary-box")!;
const summaryEl = document.getElementById("file-summary")!;
const summaryCopy = document.getElementById("file-summary-copy") as HTMLButtonElement;

let host: FilesHost;
let running = false;
let transcript: FileTranscript | null = null;
let fileName = "";
let languageSet = false;

/// "4:05" or "1:02:03", like the backend's `clock`.
function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

function setStatus(text: string, tone = "") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function setProgress(fraction: number) {
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

function errorText(e: unknown): string {
  const code = String(e);
  const key: Record<string, string> = {
    busy: "files_err_busy",
    no_model: "files_err_no_model",
    no_speech: "files_err_no_speech",
    cancelled: "files_cancelled",
    no_ai_model: "files_err_no_ai_model",
  };
  return key[code] ? t(key[code]) : `${t("files_err_failed")}: ${code}`;
}

function showText() {
  if (!transcript) return;
  textArea.value = timesToggle.checked ? transcript.textWithTimes : transcript.text;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([getLang()], { type: "language" }).of(code === "jw" ? "jv" : code) ?? code;
  } catch {
    return code;
  }
}

async function transcribe(path: string) {
  if (running) {
    setStatus(t("files_err_busy"), "error");
    return;
  }
  running = true;
  transcript = null;
  fileName = path.split(/[\\/]/).pop() ?? path;
  nameEl.textContent = fileName;
  job.classList.remove("hidden");
  cancelBtn.classList.remove("hidden");
  result.classList.remove("hidden");
  summaryBox.classList.add("hidden");
  summaryEl.textContent = "";
  textArea.value = "";
  setButtons(false);
  setProgress(0);
  setStatus(t("files_reading"));
  try {
    transcript = await invoke<FileTranscript>("transcribe_file", { path, language: languageSelect.value });
    showText();
    setProgress(1);
    const secs = (transcript.elapsedMs / 1000).toFixed(1);
    setStatus(
      t("files_done")
        .replace("{audio}", clock(transcript.durationMs))
        .replace("{secs}", secs)
        .replace("{language}", languageName(transcript.language)),
      "ok",
    );
    setButtons(true);
  } catch (e) {
    setStatus(errorText(e), String(e) === "cancelled" ? "" : "error");
    // Keep what was transcribed before a cancel, as plain text.
    setButtons(textArea.value.trim().length > 0, false);
    if (!textArea.value.trim()) result.classList.add("hidden");
  } finally {
    running = false;
    cancelBtn.classList.add("hidden");
  }
}

function setButtons(enabled: boolean, withTimes = enabled) {
  copyBtn.disabled = !enabled;
  saveBtn.disabled = !enabled;
  summarizeBtn.disabled = !enabled;
  timesToggle.disabled = !withTimes;
}

function onProgress(p: FileProgress) {
  if (!running) return;
  if (p.phase === "reading") {
    setStatus(t("files_reading"));
    setProgress(p.total > 0 ? (p.done / p.total) * 0.05 : 0);
  } else if (p.phase === "loading") {
    setStatus(t("files_loading"));
    setProgress(0.05);
  } else {
    setStatus(t("files_transcribing").replace("{done}", clock(p.done)).replace("{total}", clock(p.total)));
    setProgress(0.05 + (p.total > 0 ? (p.done / p.total) * 0.95 : 0));
    if (p.text) {
      textArea.value += (textArea.value ? " " : "") + p.text;
      textArea.scrollTop = textArea.scrollHeight;
    }
  }
}

async function chooseFile() {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: t("files_filter"), extensions: EXTENSIONS }],
  });
  if (path && !Array.isArray(path)) await transcribe(path);
}

async function summarize() {
  const text = transcript?.text ?? textArea.value;
  if (!text.trim()) return;
  summarizeBtn.disabled = true;
  summaryBox.classList.remove("hidden");
  summaryEl.textContent = t("files_summarizing");
  summaryEl.dataset.tone = "";
  try {
    summaryEl.textContent = await invoke<string>("summarize_text", { text });
  } catch (e) {
    summaryEl.textContent = errorText(e);
    summaryEl.dataset.tone = "error";
  } finally {
    summarizeBtn.disabled = false;
  }
}

async function saveText() {
  const base = fileName.replace(/\.[^.]+$/, "") || "transcript";
  const path = await save({ defaultPath: `${base}.txt`, filters: [{ name: "Text", extensions: ["txt"] }] });
  if (!path) return;
  let text = textArea.value;
  if (!summaryBox.classList.contains("hidden") && summaryEl.dataset.tone !== "error" && summaryEl.textContent) {
    text = `${t("files_summary")}\n\n${summaryEl.textContent}\n\n${t("files_transcript")}\n\n${text}`;
  }
  try {
    await invoke("save_text", { path, text });
  } catch (e) {
    setStatus(`${t("files_err_failed")}: ${e}`, "error");
  }
}

async function copy(text: string, button: HTMLButtonElement, label: string) {
  await invoke("copy_text", { text });
  button.textContent = t("pc_check_copied");
  setTimeout(() => (button.textContent = t(label)), 1500);
}

export function renderFiles() {
  populateLanguageSelect(languageSelect, getLang(), t("language_auto"));
  if (!languageSet && host.settings().language) {
    languageSelect.value = host.settings().language;
    languageSet = true;
  }
}

export function initFiles(h: FilesHost) {
  host = h;
  chooseBtn.addEventListener("click", chooseFile);
  cancelBtn.addEventListener("click", () => {
    setStatus(t("files_cancelling"));
    invoke("cancel_file");
  });
  timesToggle.addEventListener("change", showText);
  copyBtn.addEventListener("click", () => copy(textArea.value, copyBtn, "files_copy"));
  summaryCopy.addEventListener("click", () => copy(summaryEl.textContent ?? "", summaryCopy, "files_copy"));
  saveBtn.addEventListener("click", saveText);
  summarizeBtn.addEventListener("click", summarize);
  listen<FileProgress>("file-progress", (e) => onProgress(e.payload));
  listen<[number, number]>("summary-progress", (e) => {
    const [done, total] = e.payload;
    if (total > 1) summaryEl.textContent = t("files_summarizing_parts").replace("{done}", String(done + 1)).replace("{total}", String(total));
  });
  // A file dropped anywhere on the window is transcribed.
  getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "over" || p.type === "enter") {
      drop.classList.add("dragging");
    } else if (p.type === "leave") {
      drop.classList.remove("dragging");
    } else if (p.type === "drop") {
      drop.classList.remove("dragging");
      const path = p.paths[0];
      if (!path) return;
      host.showSection();
      transcribe(path);
    }
  });
}
