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
  settings(): { language: string; fileSpeakers: string };
  saveSettings(patch: { fileSpeakers?: string }): Promise<void>;
  /** Show the Files section (a file dropped on another tab). */
  showSection(): void;
}

interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: number;
}

interface FileTranscript {
  segments: Segment[];
  speakers: number;
  speakersError?: string;
  language: string;
  durationMs: number;
  elapsedMs: number;
}

interface FileProgress {
  phase: "reading" | "loading" | "transcribing" | "speakers";
  done: number;
  total: number;
  text: string;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
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
const exportBtn = document.getElementById("file-export") as HTMLButtonElement;
const exportList = document.getElementById("file-export-list")!;
const exportMenu = document.querySelector(".export-menu")!;
const summarizeBtn = document.getElementById("file-summarize") as HTMLButtonElement;
const summaryBox = document.getElementById("file-summary-box")!;
const summaryEl = document.getElementById("file-summary")!;
const summaryCopy = document.getElementById("file-summary-copy") as HTMLButtonElement;
const speakersSelect = document.getElementById("file-speakers") as HTMLSelectElement;
const speakersHint = document.getElementById("file-speakers-hint")!;
const speakersRow = document.getElementById("file-speakers-row")!;
const speakerChips = document.getElementById("file-speaker-chips")!;

let host: FilesHost;
let running = false;
let transcript: FileTranscript | null = null;
let fileName = "";
let languageSet = false;
let speakersSet = false;
/** Counts summaries; a new file or summary makes older results stale. */
let summaryRun = 0;
let summarizing = false;

let segments: Segment[] = [];
/** One name per speaker, "Speaker 1" … until renamed. */
let names: string[] = [];
/** The speaker model download, while it runs. */
let modelDownload: Promise<boolean> | null = null;

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

/** The transcript as shown: paragraphs, speaker names, times if on. */
async function shownText(times: boolean): Promise<string> {
  return invoke<string>("format_file_text", { segments, names, times });
}

async function showText() {
  if (!segments.length) return;
  textArea.value = await shownText(timesToggle.checked);
}

function defaultName(i: number): string {
  return t("files_speaker_n").replace("{n}", String(i + 1));
}

function renderChips() {
  speakerChips.replaceChildren();
  speakersRow.classList.toggle("hidden", names.length === 0);
  names.forEach((name, i) => {
    const chip = document.createElement("button");
    chip.className = "speaker-chip";
    chip.textContent = name;
    chip.title = t("files_speaker_rename");
    chip.addEventListener("click", () => renameSpeaker(i, chip));
    speakerChips.append(chip);
  });
}

function renameSpeaker(i: number, chip: HTMLButtonElement) {
  const input = document.createElement("input");
  input.className = "speaker-chip-input";
  input.value = names[i];
  chip.replaceWith(input);
  input.focus();
  input.select();
  // A new transcription replaces `names` with a fresh array; a rename still
  // open from the old one must not write into it or re-render for it.
  const startNames = names;
  let done = false;
  const apply = async (keep: boolean) => {
    if (done || names !== startNames) return;
    done = true;
    if (keep) names[i] = input.value.trim() || defaultName(i);
    renderChips();
    await showText();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply(true);
    if (e.key === "Escape") apply(false);
  });
  input.addEventListener("blur", () => apply(true));
}

/** Download the speaker model if needed; true when it is ready. */
function ensureSpeakerModel(): Promise<boolean> {
  if (modelDownload) return modelDownload;
  modelDownload = (async () => {
    try {
      const status = await invoke<{ downloaded: boolean }>("speaker_model_status");
      if (status.downloaded) return true;
      speakersHint.textContent = t("files_speakers_downloading").replace("{percent}", "0");
      await invoke("speaker_model_download");
      speakersHint.textContent = t("files_speakers_hint");
      return true;
    } catch {
      speakersHint.textContent = t("files_speakers_download_failed");
      return false;
    } finally {
      modelDownload = null;
    }
  })();
  return modelDownload;
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
  segments = [];
  names = [];
  renderChips();
  transcript = null;
  fileName = path.split(/[\\/]/).pop() ?? path;
  nameEl.textContent = fileName;
  job.classList.remove("hidden");
  cancelBtn.classList.remove("hidden");
  result.classList.remove("hidden");
  summaryRun++;
  summarizing = false;
  summaryBox.classList.add("hidden");
  summaryEl.textContent = "";
  textArea.value = "";
  setButtons(false);
  setProgress(0);
  setStatus(t("files_reading"));
  // A failed or missing model must not drop the transcript: wait for a
  // download (or a running one) but transcribe regardless of the outcome —
  // the backend falls back to an unlabelled transcript and reports why.
  if (speakersSelect.value !== "off") {
    await ensureSpeakerModel();
  }
  try {
    transcript = await invoke<FileTranscript>("transcribe_file", {
      path,
      language: languageSelect.value,
      speakers: speakersSelect.value,
    });
    segments = transcript.segments;
    names = Array.from({ length: transcript.speakers }, (_, i) => defaultName(i));
    renderChips();
    await showText();
    setProgress(1);
    const secs = (transcript.elapsedMs / 1000).toFixed(1);
    let status = t("files_done")
      .replace("{audio}", clock(transcript.durationMs))
      .replace("{secs}", secs)
      .replace("{language}", languageName(transcript.language));
    if (transcript.speakersError) {
      const key = `files_speakers_missing_${transcript.speakersError}`;
      const known = key === "files_speakers_missing_no_model" || key === "files_speakers_missing_no_runtime";
      status += " · " + (known ? t(key) : t("files_speakers_missing_error").replace("{error}", transcript.speakersError));
    }
    setStatus(status, transcript.speakersError ? "error" : "ok");
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
  exportBtn.disabled = !enabled || !segments.length;
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
  } else if (p.phase === "speakers") {
    setStatus(t("files_speakers_running").replace("{percent}", String(p.done)));
    setProgress(0.95 + (p.done / 100) * 0.05);
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
  const text = segments.length ? await shownText(false) : textArea.value;
  if (!text.trim()) return;
  // A summary still running for an earlier file must not land in this one.
  const run = ++summaryRun;
  summarizing = true;
  summarizeBtn.disabled = true;
  summaryBox.classList.remove("hidden");
  summaryEl.textContent = t("files_summarizing");
  summaryEl.dataset.tone = "";
  try {
    const summary = await invoke<string>("summarize_text", { text });
    if (run === summaryRun) summaryEl.textContent = summary;
  } catch (e) {
    if (run === summaryRun) {
      summaryEl.textContent = errorText(e);
      summaryEl.dataset.tone = "error";
    }
  } finally {
    if (run === summaryRun) {
      summarizing = false;
      summarizeBtn.disabled = running;
    }
  }
}

type ExportKind = "pdf" | "docx" | "srt" | "vtt" | "txt";

function setExportMenu(open: boolean) {
  exportList.classList.toggle("hidden", !open);
  exportBtn.setAttribute("aria-expanded", String(open));
}

/** "2:52 · English · 2 speakers · 24.09.2026" under the title. */
function exportMeta(): string {
  const parts = [clock(transcript?.durationMs ?? 0), languageName(transcript?.language ?? "")];
  if (names.length) parts.push(t("files_speakers_count").replace("{n}", String(names.length)));
  parts.push(new Date().toLocaleDateString(getLang()));
  return parts.join(" · ");
}

async function exportAs(kind: ExportKind) {
  setExportMenu(false);
  const base = fileName.replace(/\.[^.]+$/, "") || "transcript";
  const path = await save({
    defaultPath: `${base}.${kind}`,
    filters: [{ name: t(`files_filter_${kind}`), extensions: [kind] }],
  });
  if (!path) return;
  const summaryReady = !summarizing && !summaryBox.classList.contains("hidden") && summaryEl.dataset.tone !== "error";
  const doc = {
    title: fileName,
    meta: exportMeta(),
    segments,
    names,
    times: timesToggle.checked,
    summary: summaryReady && summaryEl.textContent ? summaryEl.textContent : null,
    summaryTitle: t("files_summary"),
    transcriptTitle: t("files_transcript"),
  };
  try {
    await invoke("export_file", { kind, path, doc });
    setStatus(t("files_exported").replace("{name}", path.split(/[\\/]/).pop() ?? path), "ok");
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
  if (!speakersSet) {
    speakersSelect.value = host.settings().fileSpeakers || "off";
    speakersSet = true;
  }
}

export function initFiles(h: FilesHost) {
  host = h;
  chooseBtn.addEventListener("click", chooseFile);
  cancelBtn.addEventListener("click", () => {
    setStatus(t("files_cancelling"));
    invoke("cancel_file");
  });
  speakersSelect.addEventListener("change", async () => {
    await host.saveSettings({ fileSpeakers: speakersSelect.value });
    if (speakersSelect.value !== "off") ensureSpeakerModel();
  });
  timesToggle.addEventListener("change", showText);
  copyBtn.addEventListener("click", () => copy(textArea.value, copyBtn, "files_copy"));
  summaryCopy.addEventListener("click", () => copy(summaryEl.textContent ?? "", summaryCopy, "files_copy"));
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setExportMenu(exportList.classList.contains("hidden"));
  });
  exportList.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((item) =>
    item.addEventListener("click", () => exportAs(item.dataset.kind as ExportKind)),
  );
  document.addEventListener("click", () => setExportMenu(false));
  // A disclosure, not an ARIA menu: focus leaving the button and its list
  // (Tab past the last item, or anywhere else) closes it without trapping
  // or moving focus; Escape closes it and, only if focus was inside the
  // list, returns focus to the Export button.
  exportMenu.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (!next || !exportMenu.contains(next)) setExportMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const returnFocus = exportList.contains(document.activeElement);
      setExportMenu(false);
      if (returnFocus) exportBtn.focus();
    }
  });
  summarizeBtn.addEventListener("click", summarize);
  listen<FileProgress>("file-progress", (e) => onProgress(e.payload));
  listen<DownloadProgress>("speaker-model-progress", (e) => {
    speakersHint.textContent = t("files_speakers_downloading").replace("{percent}", String(Math.round(e.payload.percent)));
  });
  listen<[number, number]>("summary-progress", (e) => {
    const [done, total] = e.payload;
    if (summarizing && total > 1) summaryEl.textContent = t("files_summarizing_parts").replace("{done}", String(done + 1)).replace("{total}", String(total));
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
