// Meetings tab: record an online call on this PC (the microphone as "You",
// what the PC plays as "Others"), see the transcript live, and keep every
// meeting with its notes, speakers and (for 30 days) audio. The work runs in
// the backend (`meeting_*` commands, src-tauri/src/meeting/).
//
// The backend sends "meetings-changed" and "meeting-lines" a moment before
// the "meeting-status" of the same change, and a status in between can be
// left out. So nothing here waits for one event after another: the bar is
// drawn from the last status, a meeting from the last `meeting_get` plus the
// lines since, and each part is redrawn only where it changed (the
// transcript keeps its scroll position, an open rename stays open).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { getLang, t } from "./i18n";

export interface MeetingsHost {
  settings(): { meetingReminderOff: boolean; meetingHeadphonesSeen: boolean };
  saveSettings(patch: { meetingReminderOff?: boolean; meetingHeadphonesSeen?: boolean }): Promise<void>;
  /** Show the Meetings section (a meeting started from the tray or hotkey). */
  showSection(): void;
}

type Track = "you" | "others";
type MeetingState = "recording" | "finishing" | "finished" | "interrupted";
type Step = "transcribing" | "speakers" | "notes";
type Warning = "micLost" | "pcLost" | "noPcSound" | "writeFailed";

interface Line {
  startMs: number;
  endMs: number;
  track: Track;
  speaker?: number;
  text: string;
}

interface ActionItem {
  text: string;
  done: boolean;
}

interface Notes {
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
}

interface Meeting {
  id: string;
  title: string;
  /** UTC, ms since 1970. */
  startedAt: number;
  /** Local time minus UTC at the start, in minutes. */
  utcOffsetMin: number;
  lengthMs: number;
  /** The Whisper models it was transcribed with: "small, large-v3-turbo". */
  whisperModel: string;
  language: string;
  state: MeetingState;
  lines: Line[];
  speakerNames: string[];
  notes?: Notes;
  /** "no_model", "no_runtime", "none_found" or an error text. */
  speakersError?: string;
  /** "ai_off", "no_ai_model", "gpu_freed", "empty" or an error text. */
  notesError?: string;
  audioDeleted: boolean;
}

interface Paragraph {
  startMs: number;
  track: Track;
  speaker?: number;
  text: string;
}

interface MeetingView {
  meeting: Meeting;
  paragraphs: Paragraph[];
}

interface Recording {
  id: string;
  title: string;
  startedAt: number;
  warnings: Warning[];
  paused: boolean;
}

interface Status {
  recording: Recording | null;
  finishing: { id: string; step: Step }[];
}

interface Summary {
  id: string;
  title: string;
  startedAt: number;
  utcOffsetMin: number;
  lengthMs: number;
  state: MeetingState;
  audioDeleted: boolean;
}

interface LinesChanged {
  id: string;
  from: number;
  paragraphs: Paragraph[];
}

interface Playing {
  id: string;
  fromMs: number;
}

interface Hint {
  text: string;
  tone?: "warn" | "error" | "ok" | "busy";
  /** The backend's own words, as a tooltip. */
  detail?: string;
  action?: { key: string; label: string; primary?: boolean; run: () => void };
}

/** A meeting stops itself at 4 hours (the backend's `MAX_MS`). */
const MAX_MS = 4 * 3600 * 1000;
/** Day before month and 24 hours in both languages, like the default title. */
const DATE_LOCALE: Record<string, string> = { en: "en-GB", de: "de-CH" };
const SVG = "http://www.w3.org/2000/svg";

const $ = (id: string) => document.getElementById(id)!;
const section = $("section-meetings");
const titleInput = $("mt-title") as HTMLInputElement;
const startBtn = $("mt-start-btn") as HTMLButtonElement;
const startError = $("mt-start-error");
const bar = $("mt-bar");
const barTime = $("mt-bar-time");
const barTitle = $("mt-bar-title") as HTMLButtonElement;
const stopBtn = $("mt-stop-btn") as HTMLButtonElement;
const warningsEl = $("mt-warnings");
const reminder = $("mt-reminder");
const reminderText = $("mt-reminder-text");
const reminderClose = $("mt-reminder-close") as HTMLButtonElement;
const finishingEl = $("mt-finishing");
const viewEl = $("mt-view");
const backBtn = $("mt-back") as HTMLButtonElement;
const viewTitle = $("mt-view-title") as HTMLButtonElement;
const viewMeta = $("mt-view-meta");
const copyBtn = $("mt-copy") as HTMLButtonElement;
const exportBtn = $("mt-export") as HTMLButtonElement;
const exportList = $("mt-export-list");
const exportMenu = $("mt-export-menu");
const deleteBtn = $("mt-delete") as HTMLButtonElement;
const hintEl = $("mt-hint");
const notesEl = $("mt-notes");
const speakersRow = $("mt-speakers");
const speakerChips = $("mt-speaker-chips");
const transcriptEl = $("mt-transcript");
const liveBtn = $("mt-live") as HTMLButtonElement;
const libraryEl = $("mt-library");
const listEl = $("mt-list");
const emptyEl = $("mt-empty");
const searchInput = $("mt-search") as HTMLInputElement;
const quitDialog = $("mt-quit");
const quitOk = $("mt-quit-ok") as HTMLButtonElement;
const quitCancel = $("mt-quit-cancel") as HTMLButtonElement;

let host: MeetingsHost | null = null;
let status: Status = { recording: null, finishing: [] };
let view: MeetingView | null = null;
let playing: Playing | null = null;
/** The live transcript scrolls along until the user scrolls up. */
let following = true;
/** The headphones hint shows during the first meeting only. */
let headphonesThisMeeting = false;
let clockTimer: number | undefined;
let searchTimer: number | undefined;
let deleteArmed: number | undefined;
/** The newest `meeting_get` and `meeting_list` asked for: an older answer
 *  that arrives later is dropped. */
let openSeq = 0;
let listSeq = 0;
/** Counts the events, so an answer that one of them overtook is not used. */
let statusSeen = 0;
let linesSeen = 0;
/** Titles by id (the library and the meetings opened), for "Finishing …". */
const titles = new Map<string, string>();
/** The rename that is open: a redraw leaves its input alone, and another
 *  meeting opening ends it (saving what was typed). */
let editing: { kind: "title" | "speaker"; id: string; end: (keep: boolean) => void } | null = null;
/** Under the title: an export that was saved, or why an action failed. */
let flash: { text: string; tone: "ok" | "error" } | null = null;
/** Buttons whose work runs: "finish:<id>", "notes:<id>", "speaker-model". */
const running = new Set<string>();
/** Whether the speaker model is downloaded now; null until asked. */
let speakerModel: boolean | null = null;
let askingSpeakerModel = false;
let speakerModelPercent = 0;
/** What the view shows, so only what changed is drawn again. */
const drawn = { id: "", lang: "", bar: "", finishing: "", hints: "", notes: "", chips: "", paragraphs: [] as Paragraph[] };
/** The speaker chip to focus once the chips are drawn again (after a rename
 *  with the keyboard). */
let focusChip = -1;

/// "4:05" or "1:02:03", like the backend's `clock`.
function clock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

/** "3 Oct 2026, 14:00": the meeting's own local time at its start. */
function when(startedAt: number, utcOffsetMin: number): string {
  return new Intl.DateTimeFormat(DATE_LOCALE[getLang()] ?? "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(startedAt + utcOffsetMin * 60_000));
}

/** A command's refusal in words. */
function errorText(e: unknown): string {
  const code = String(e);
  const key: Record<string, string> = {
    already_recording: "mt_err_already",
    no_model: "mt_err_no_model",
    disk_full: "mt_err_disk",
    pc_check: "mt_err_pc_check",
    busy: "mt_err_busy",
    no_ai_model: "mt_hint_notes_no_ai_model",
    no_audio: "mt_audio_deleted",
    recording: "mt_err_recording",
    gpu_freed: "mt_err_gpu_freed",
    no_meeting: "mt_err_gone",
  };
  return key[code] ? t(key[code]) : `${t("files_err_failed")}: ${code}`;
}

/** Who said a paragraph or line: You, Others, or a speaker's name. */
function who(track: Track, speaker: number | undefined, names: string[]): string {
  if (track === "you") return t("mt_you");
  if (speaker === undefined) return t("mt_others");
  return names[speaker]?.trim() || speakerDefault(speaker);
}

function speakerDefault(speaker: number): string {
  return t("files_speaker_n").replace("{n}", String(speaker + 1));
}

/** How many speakers the others were told apart into. */
function speakerCount(items: { speaker?: number }[]): number {
  return items.reduce((n, l) => (l.speaker !== undefined ? Math.max(n, l.speaker + 1) : n), 0);
}

function stepText(step: Step): string {
  return t(`mt_step_${step}`);
}

/** The first paragraph that differs between what is drawn and what is new. */
function changedFrom(old: Paragraph[], now: Paragraph[]): number {
  const n = Math.min(old.length, now.length);
  for (let i = 0; i < n; i++) {
    const [a, b] = [old[i], now[i]];
    if (a.startMs !== b.startMs || a.track !== b.track || a.speaker !== b.speaker || a.text !== b.text) return i;
  }
  return n;
}

async function copy(text: string, button: HTMLButtonElement, label: string) {
  await invoke("copy_text", { text });
  button.textContent = t("pc_check_copied");
  setTimeout(() => (button.textContent = t(label)), 1500);
}

function icon(path: string): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "currentColor");
  svg.append(p);
  return svg;
}

// ── Recording bar ─────────────────────────────────────

function renderStatus() {
  const rec = status.recording;
  section.classList.toggle("mt-recording", !!rec);
  bar.classList.toggle("hidden", !rec);
  window.clearInterval(clockTimer);
  if (rec) {
    const tick = () => (barTime.textContent = t("mt_recording").replace("{time}", clock(Date.now() - rec.startedAt)));
    tick();
    clockTimer = window.setInterval(tick, 1000);
    barTitle.textContent = rec.title;
  }
  const warning: Record<Warning, string> = {
    micLost: "mt_warn_mic",
    pcLost: "mt_warn_pc",
    noPcSound: "mt_warn_no_pc",
    writeFailed: "mt_warn_write",
  };
  const lines = (rec?.warnings ?? []).map((w) => (warning[w] ? t(warning[w]) : String(w)));
  if (rec?.paused) lines.push(t("mt_paused"));
  // Drawn again only when they changed: the region is announced.
  const key = lines.join("\n");
  if (key !== drawn.bar) {
    drawn.bar = key;
    warningsEl.replaceChildren(
      ...lines.map((text) => {
        const p = document.createElement("p");
        p.className = "mt-warning";
        p.textContent = text;
        return p;
      }),
    );
  }
  renderReminder();
  renderFinishing();
}

/** "Finishing …" for the meetings whose end steps run, but the open one:
 *  its view says it. */
function renderFinishing() {
  const lines = status.finishing
    .filter((f) => f.id !== view?.meeting.id)
    .map((f) => t("mt_finishing").replace("{title}", titles.get(f.id) ?? t("mt_this_meeting")).replace("{step}", stepText(f.step)));
  if (lines.join("\n") === drawn.finishing) return;
  drawn.finishing = lines.join("\n");
  finishingEl.replaceChildren(
    ...lines.map((text) => {
      const p = document.createElement("p");
      p.className = "label-hint mt-finishing-line";
      p.textContent = text;
      return p;
    }),
  );
}

function renderReminder() {
  const parts: string[] = [];
  if (status.recording && host) {
    if (!host.settings().meetingReminderOff) parts.push(t("mt_reminder_consent"));
    if (headphonesThisMeeting) parts.push(t("mt_reminder_headphones"));
  }
  reminderText.textContent = parts.join(" ");
  reminder.classList.toggle("hidden", parts.length === 0);
}

async function start() {
  if (startBtn.disabled) return;
  startBtn.disabled = true;
  startError.classList.add("hidden");
  try {
    await invoke<string>("meeting_start", { title: titleInput.value.trim() || null });
    titleInput.value = "";
  } catch (e) {
    startError.textContent = errorText(e);
    startError.classList.remove("hidden");
  } finally {
    startBtn.disabled = false;
  }
}

async function stop() {
  stopBtn.disabled = true;
  try {
    await invoke("meeting_stop");
  } catch (e) {
    // "not_recording": the hotkey, the tray or the 4-hour limit was first.
    console.error("meeting_stop failed:", e);
  } finally {
    stopBtn.disabled = false;
  }
}

/** A meeting started (here, in the tray or by hotkey): open its live view. */
async function onStarted(rec: Recording) {
  following = true;
  startError.classList.add("hidden");
  if (host && !host.settings().meetingHeadphonesSeen) {
    headphonesThisMeeting = true;
    renderReminder();
    host.saveSettings({ meetingHeadphonesSeen: true }).catch((e) => console.error("saving the settings failed:", e));
  }
  await open(rec.id);
  host?.showSection();
}

function onStatus(next: Status) {
  statusSeen++;
  const before = status.recording?.id;
  status = next;
  const now = status.recording;
  if (!now) headphonesThisMeeting = false;
  renderStatus();
  // The step, the buttons that wait for a meeting to end, ▶.
  renderView();
  if (now && now.id !== before) void onStarted(now);
}

// ── One meeting ───────────────────────────────────────

/** Load meeting `id` and show it. */
async function open(id: string) {
  const seq = ++openSeq;
  let next: MeetingView | null = null;
  // An answer that a "meeting-lines" overtook lacks those lines (and the
  // next event counts on them): asked again.
  for (let tries = 0; tries < 3; tries++) {
    const seen = linesSeen;
    try {
      next = await invoke<MeetingView>("meeting_get", { id });
    } catch (e) {
      // "no_meeting": deleted meanwhile.
      if (String(e) !== "no_meeting") console.error("meeting_get failed:", e);
      next = null;
      break;
    }
    if (seen === linesSeen) break;
  }
  if (seq !== openSeq) return;
  setView(next);
  if (!next) void refreshList();
}

function setView(next: MeetingView | null) {
  if (editing && editing.id !== next?.meeting.id) editing.end(true);
  if (next?.meeting.id !== view?.meeting.id) {
    flash = null;
    // It may have been downloaded in the Files tab since.
    if (!running.has("speaker-model")) speakerModel = null;
  }
  view = next;
  renderView();
  renderFinishing();
}

/** Back to the library; the focus goes to the meeting that was open (the
 *  button pressed went with the view). */
async function closeView() {
  const id = view?.meeting.id;
  openSeq++;
  setView(null);
  await refreshList();
  const item = id ? listEl.querySelector<HTMLElement>(`.mt-item[data-id="${CSS.escape(id)}"]`) : null;
  (item ?? listEl.querySelector<HTMLElement>(".mt-item") ?? titleInput).focus();
}

/** Whether the end steps of `id` run or its notes are written. */
function finishingStep(id: string): Step | undefined {
  return status.finishing.find((f) => f.id === id)?.step;
}

function renderView() {
  const m = view?.meeting;
  section.classList.toggle("mt-open", !!m);
  section.classList.toggle("mt-has-notes", !!m?.notes);
  viewEl.classList.toggle("hidden", !m);
  libraryEl.classList.toggle("hidden", !!m);
  if (!view || !m) {
    drawn.id = "";
    return;
  }
  titles.set(m.id, m.title);
  const fresh = drawn.id !== m.id || drawn.lang !== getLang();
  // The same meeting in another language keeps its place.
  const top = drawn.id === m.id ? transcriptEl.scrollTop : 0;
  if (fresh) {
    editing?.end(true);
    setExportMenu(false);
    resetDelete();
    Object.assign(drawn, { id: m.id, lang: getLang(), hints: "", notes: "", chips: "", paragraphs: [] });
    hintEl.replaceChildren();
    notesEl.replaceChildren();
    speakerChips.replaceChildren();
    transcriptEl.replaceChildren();
  }
  const live = m.state === "recording";
  viewTitle.textContent = m.title;
  const meta = live ? [when(m.startedAt, m.utcOffsetMin)] : [clock(m.lengthMs), when(m.startedAt, m.utcOffsetMin)];
  if (m.whisperModel) meta.push(t("mt_meta_model").replace("{model}", m.whisperModel));
  viewMeta.textContent = meta.join(" · ");
  copyBtn.disabled = view.paragraphs.length === 0;
  exportBtn.disabled = live || m.lines.length === 0;
  deleteBtn.disabled = live || m.state === "finishing" || !!finishingStep(m.id);
  if (deleteBtn.disabled) resetDelete();
  transcriptEl.dataset.empty = live ? t("mt_transcript_waiting") : m.state === "finished" ? t("mt_transcript_empty") : "";
  renderHints();
  renderNotes(m);
  renderSpeakers();
  renderTranscript();
  if (fresh && !(live && following)) transcriptEl.scrollTop = top;
}

function renderHints() {
  if (!view) return;
  const hints = hintsOf(view.meeting);
  const key = JSON.stringify(hints.map((h) => [h.text, h.tone, h.detail, h.action?.key, h.action?.label, h.action && running.has(h.action.key)]));
  if (key === drawn.hints) return;
  drawn.hints = key;
  const focused = (document.activeElement as HTMLElement | null)?.dataset.action;
  hintEl.replaceChildren(
    ...hints.map((h) => {
      const row = document.createElement("div");
      row.className = "mt-hint-row";
      if (h.tone) row.dataset.tone = h.tone;
      const span = document.createElement("span");
      span.className = "mt-hint-text";
      span.textContent = h.text;
      if (h.detail) span.title = h.detail;
      row.append(span);
      const action = h.action;
      if (action) {
        const b = document.createElement("button");
        b.className = action.primary ? "btn-primary" : "btn-secondary";
        b.textContent = action.label;
        b.dataset.action = action.key;
        b.disabled = running.has(action.key);
        b.addEventListener("click", action.run);
        row.append(b);
      }
      return row;
    }),
  );
  hintEl.classList.toggle("hidden", hints.length === 0);
  if (focused) hintEl.querySelector<HTMLElement>(`[data-action="${CSS.escape(focused)}"]`)?.focus();
}

/** A hint's button: `work` once at a time; a refusal shows in words. */
function action(key: string, label: string, work: () => Promise<unknown>, primary = false): Hint["action"] {
  const run = async () => {
    if (running.has(key)) return;
    running.add(key);
    flash = null;
    renderHints();
    try {
      await work();
    } catch (e) {
      flash = { text: errorText(e), tone: "error" };
    } finally {
      running.delete(key);
      renderHints();
    }
  };
  return { key, label, primary, run: () => void run() };
}

function hintsOf(m: Meeting): Hint[] {
  const hints: Hint[] = [];
  const step = finishingStep(m.id);
  const writeNotes = () => action(`notes:${m.id}`, t("mt_write_notes"), () => invoke("meeting_write_notes", { id: m.id }));
  // The status may be a moment behind the meeting: "Finishing…" until then.
  if (step) hints.push({ text: `${stepText(step)}…`, tone: "busy" });
  else if (m.state === "finishing") hints.push({ text: t("mt_finishing_plain"), tone: "busy" });
  if (m.state === "interrupted" && !step) {
    if (m.audioDeleted) {
      // Finish needs the audio; the notes do not.
      hints.push({ text: t("mt_interrupted_no_audio"), tone: "warn", action: m.notes || !m.lines.length ? undefined : writeNotes() });
    } else {
      const finish = action(`finish:${m.id}`, t("mt_finish"), () => invoke("meeting_finish", { id: m.id }), true);
      hints.push({ text: t("mt_interrupted_hint"), tone: "warn", action: finish });
    }
  }
  if (m.lengthMs >= MAX_MS && m.state !== "recording") hints.push({ text: t("mt_hint_limit"), tone: "warn" });
  if (m.state === "finished" && m.speakersError && m.speakersError !== "none_found") {
    if (m.speakersError === "no_model") {
      if (speakerModel === null) void askSpeakerModel();
      if (speakerModel) hints.push({ text: t("mt_hint_speakers_no_model_then") });
      else {
        const label = running.has("speaker-model") ? `${speakerModelPercent} %` : t("download");
        const download = speakerModel === false ? action("speaker-model", label, downloadSpeakerModel) : undefined;
        hints.push({ text: t("mt_hint_speakers_no_model"), action: download });
      }
    } else if (m.speakersError === "no_runtime") {
      hints.push({ text: t("mt_hint_speakers_no_runtime") });
    } else {
      hints.push({ text: t("mt_hint_speakers_error").replace("{error}", m.speakersError) });
    }
  }
  if (m.state === "finished" && !m.notes && m.notesError && !step) {
    const known = ["ai_off", "no_ai_model", "gpu_freed", "empty"].includes(m.notesError);
    hints.push({
      text: known ? t(`mt_hint_notes_${m.notesError}`) : t("mt_hint_notes_error"),
      detail: known ? undefined : m.notesError,
      action: m.notesError === "empty" ? undefined : writeNotes(),
    });
  }
  if (m.audioDeleted && m.state !== "interrupted") hints.push({ text: t("mt_audio_deleted") });
  if (flash) hints.push({ text: flash.text, tone: flash.tone });
  return hints;
}

async function askSpeakerModel() {
  if (askingSpeakerModel) return;
  askingSpeakerModel = true;
  try {
    speakerModel = (await invoke<{ downloaded: boolean }>("speaker_model_status")).downloaded;
  } catch (e) {
    console.error("speaker_model_status failed:", e);
    return;
  } finally {
    askingSpeakerModel = false;
  }
  renderHints();
}

async function downloadSpeakerModel() {
  speakerModelPercent = 0;
  await invoke("speaker_model_download");
  speakerModel = true;
}

/** A notes section as text, for its copy button and the exports. */
function sectionText(n: Notes, key: "summary" | "decisions" | "actions"): string {
  if (key === "summary") return n.summary || t("mt_none");
  if (key === "decisions") return n.decisions.length ? n.decisions.map((d) => `- ${d}`).join("\n") : t("mt_none");
  return n.actionItems.length ? n.actionItems.map((a) => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n") : t("mt_none");
}

function notesText(n: Notes): string {
  return (["summary", "decisions", "actions"] as const).map((k) => `${t(`mt_${k}`)}\n${sectionText(n, k)}`).join("\n\n");
}

function renderNotes(m: Meeting) {
  const n = m.notes;
  notesEl.classList.toggle("hidden", !n);
  const key = n ? JSON.stringify([n.summary, n.decisions, n.actionItems.map((a) => a.text)]) : "";
  if (key === drawn.notes) {
    // Only ticks changed: the boxes follow, nothing is drawn again.
    notesEl.querySelectorAll<HTMLInputElement>(".mt-checklist input").forEach((box, i) => {
      const done = n?.actionItems[i]?.done ?? false;
      if (box.checked !== done) box.checked = done;
    });
    return;
  }
  drawn.notes = key;
  notesEl.replaceChildren();
  if (!n) return;
  for (const key of ["summary", "decisions", "actions"] as const) {
    const part = document.createElement("section");
    part.className = "mt-notes-section";
    const head = document.createElement("div");
    head.className = "mt-notes-head";
    const h = document.createElement("h4");
    h.textContent = t(`mt_${key}`);
    const copyOne = document.createElement("button");
    copyOne.className = "btn-ghost";
    copyOne.textContent = t("files_copy");
    copyOne.setAttribute("aria-label", t("mt_copy_section").replace("{section}", t(`mt_${key}`)));
    // The notes as they are when it is pressed (the ticks change).
    copyOne.addEventListener("click", () => {
      const now = view?.meeting.id === m.id ? view.meeting.notes : undefined;
      if (now) void copy(sectionText(now, key), copyOne, "files_copy");
    });
    head.append(h, copyOne);
    part.append(head);
    const empty = key === "summary" ? !n.summary : key === "decisions" ? !n.decisions.length : !n.actionItems.length;
    if (empty) {
      const p = document.createElement("p");
      p.className = "label-hint";
      p.textContent = t("mt_none");
      part.append(p);
    } else if (key === "summary") {
      const p = document.createElement("p");
      p.className = "mt-notes-text";
      p.textContent = n.summary;
      part.append(p);
    } else if (key === "decisions") {
      const ul = document.createElement("ul");
      for (const d of n.decisions) {
        const li = document.createElement("li");
        li.textContent = d;
        ul.append(li);
      }
      part.append(ul);
    } else {
      const ul = document.createElement("ul");
      ul.className = "mt-checklist";
      n.actionItems.forEach((a, index) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = a.done;
        box.addEventListener("change", async () => {
          const done = box.checked;
          try {
            await invoke("meeting_set_action_done", { id: m.id, index, done });
          } catch (e) {
            box.checked = !done;
            console.error("meeting_set_action_done failed:", e);
          }
        });
        const span = document.createElement("span");
        span.textContent = a.text;
        label.append(box, span);
        li.append(label);
        ul.append(li);
      });
      part.append(ul);
    }
    notesEl.append(part);
  }
}

/** The others' speakers as chips; a click renames one ("You" keeps its name). */
function renderSpeakers() {
  if (!view) return;
  // The input of an open rename stays; drawn again when it ends.
  if (editing?.kind === "speaker") return;
  const m = view.meeting;
  const count = Math.max(speakerCount(view.paragraphs), speakerCount(m.lines));
  const names = Array.from({ length: count }, (_, i) => who("others", i, m.speakerNames));
  const key = JSON.stringify(names);
  if (key !== drawn.chips) {
    drawn.chips = key;
    // The chip that has the focus keeps it.
    if (focusChip < 0) focusChip = Array.prototype.indexOf.call(speakerChips.children, document.activeElement);
    speakersRow.classList.toggle("hidden", count === 0);
    speakerChips.replaceChildren(
      ...names.map((name, i) => {
        const chip = document.createElement("button");
        chip.className = "speaker-chip";
        chip.textContent = name;
        chip.title = t("files_speaker_rename");
        chip.setAttribute("aria-label", t("mt_rename_speaker").replace("{name}", name));
        chip.addEventListener("click", () => renameSpeaker(m.id, i, chip));
        return chip;
      }),
    );
  }
  if (focusChip >= 0) {
    (speakerChips.children[focusChip] as HTMLElement | undefined)?.focus();
    focusChip = -1;
  }
}

function renameSpeaker(id: string, i: number, chip: HTMLButtonElement) {
  if (editing) return;
  const shown = chip.textContent ?? "";
  const input = document.createElement("input");
  input.className = "speaker-chip-input";
  input.value = shown;
  input.maxLength = 60;
  input.spellcheck = false;
  input.setAttribute("aria-label", t("mt_rename_speaker").replace("{name}", shown));
  chip.replaceWith(input);
  input.focus();
  input.select();
  const end = (keep: boolean, refocus = false) => {
    if (editing?.end !== end) return;
    editing = null;
    const name = input.value.trim();
    // Drawn again from the meeting as it is now (the event of the rename
    // brings the new name).
    drawn.chips = "";
    if (refocus) focusChip = i;
    renderSpeakers();
    // The default name is not saved as a name: it follows the language.
    if (keep && name !== shown) {
      invoke("meeting_rename_speaker", { id, speaker: i, name: name === speakerDefault(i) ? "" : name }).catch((e) => {
        console.error("meeting_rename_speaker failed:", e);
        showFlash(errorText(e), "error");
      });
    }
  };
  editing = { kind: "speaker", id, end };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") end(true, true);
    if (e.key === "Escape") {
      // Not the export menu's or the dialog's Escape as well.
      e.stopPropagation();
      end(false, true);
    }
  });
  input.addEventListener("blur", () => end(true));
}

function renameTitle() {
  if (!view || editing) return;
  const { id, title } = view.meeting;
  const input = document.createElement("input");
  input.className = "mt-title-edit";
  input.value = title;
  input.maxLength = 200;
  input.spellcheck = false;
  input.setAttribute("aria-label", t("mt_title_label"));
  viewTitle.replaceWith(input);
  input.focus();
  input.select();
  const end = (keep: boolean, refocus = false) => {
    if (editing?.end !== end) return;
    editing = null;
    const next = input.value.trim();
    input.replaceWith(viewTitle);
    if (refocus) viewTitle.focus();
    if (keep && next && next !== title) {
      // Shown at once; the event of the rename confirms it.
      if (view?.meeting.id === id) viewTitle.textContent = next;
      invoke("meeting_rename", { id, title: next }).catch((e) => {
        console.error("meeting_rename failed:", e);
        showFlash(errorText(e), "error");
        if (view?.meeting.id === id) viewTitle.textContent = view.meeting.title;
      });
    }
  };
  editing = { kind: "title", id, end };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") end(true, true);
    if (e.key === "Escape") {
      e.stopPropagation();
      end(false, true);
    }
  });
  input.addEventListener("blur", () => end(true));
}

function showFlash(text: string, tone: "ok" | "error") {
  flash = { text, tone };
  renderHints();
}

/** Why ▶ is off for this meeting, or "". */
function playOff(m: Meeting): string {
  if (m.audioDeleted) return t("mt_play_off_deleted");
  // Any meeting that records: what plays would be recorded into it.
  if (status.recording || m.state === "recording") return t("mt_play_off_recording");
  return "";
}

function paragraphRow(p: Paragraph): HTMLElement {
  const row = document.createElement("div");
  row.className = "mt-para";
  row.dataset.track = p.track;
  row.dataset.start = String(p.startMs);
  const head = document.createElement("div");
  head.className = "mt-para-head";
  const play = document.createElement("button");
  play.className = "mt-play";
  play.append(icon("M3.5 2.2v7.6L10 6z"), icon("M3 3h6v6H3z"));
  const time = document.createElement("span");
  time.className = "mt-para-time";
  time.textContent = clock(p.startMs);
  const name = document.createElement("span");
  name.className = "mt-para-who";
  head.append(play, time, name);
  const text = document.createElement("p");
  text.className = "mt-para-text";
  text.textContent = p.text;
  row.append(head, text);
  return row;
}

/** Draw the paragraphs from the first changed one on; the ones before stay
 *  as they are, so the transcript keeps its place. */
function renderTranscript() {
  if (!view) return;
  const from = changedFrom(drawn.paragraphs, view.paragraphs);
  // A ▶ that has the focus keeps it when its row is drawn again.
  const active = document.activeElement?.closest<HTMLElement>("#mt-transcript .mt-para");
  const focused = active ? Array.prototype.indexOf.call(transcriptEl.children, active) : -1;
  while (transcriptEl.children.length > from) transcriptEl.lastElementChild!.remove();
  const rows = document.createDocumentFragment();
  for (const p of view.paragraphs.slice(from)) rows.append(paragraphRow(p));
  transcriptEl.append(rows);
  drawn.paragraphs = view.paragraphs;
  syncRows();
  if (focused >= from) transcriptEl.children[focused]?.querySelector<HTMLElement>(".mt-play")?.focus();
  const live = view.meeting.state === "recording";
  if (live && following) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  liveBtn.classList.toggle("hidden", !live || following);
}

/** The names and ▶ of every row, without drawing the rows again. */
function syncRows() {
  if (!view) return;
  const m = view.meeting;
  const off = playOff(m);
  for (let i = 0; i < transcriptEl.children.length; i++) {
    const row = transcriptEl.children[i] as HTMLElement;
    const p = view.paragraphs[i];
    if (!p) break;
    const name = row.querySelector<HTMLElement>(".mt-para-who")!;
    const label = who(p.track, p.speaker, m.speakerNames);
    if (name.textContent !== label) name.textContent = label;
    const play = row.querySelector<HTMLButtonElement>(".mt-play")!;
    const isPlaying = !off && playing?.id === m.id && playing.fromMs === p.startMs;
    const title = off || t(isPlaying ? "mt_stop_play" : "mt_play");
    if (play.disabled !== !!off) play.disabled = !!off;
    if (play.dataset.playing !== String(isPlaying)) play.dataset.playing = String(isPlaying);
    if (play.title !== title) {
      play.title = title;
      play.setAttribute("aria-label", `${title} (${clock(p.startMs)})`);
    }
  }
}

async function togglePlay(fromMs: number) {
  if (!view) return;
  const id = view.meeting.id;
  flash = null;
  try {
    if (playing?.id === id && playing.fromMs === fromMs) await invoke("meeting_stop_playing");
    else await invoke("meeting_play", { id, fromMs });
    renderHints();
  } catch (e) {
    showFlash(errorText(e), "error");
  }
}

/** The transcript as text: "[4:05] You: …" paragraphs. */
function transcriptText(): string {
  if (!view) return "";
  const names = view.meeting.speakerNames;
  return view.paragraphs.map((p) => `[${clock(p.startMs)}] ${who(p.track, p.speaker, names)}: ${p.text}`).join("\n\n");
}

type ExportKind = "pdf" | "docx" | "srt" | "vtt" | "txt";

function setExportMenu(isOpen: boolean) {
  exportList.classList.toggle("hidden", !isOpen);
  exportBtn.setAttribute("aria-expanded", String(isOpen));
}

/** Export with the Files tab's exporters: the lines as segments (0 You,
 *  1 Others, 2 + n Speaker n+1), the notes on top for PDF, Word and text. */
async function exportAs(kind: ExportKind) {
  setExportMenu(false);
  if (!view) return;
  const m = view.meeting;
  const path = await save({
    defaultPath: `${m.title.replace(/[\\/:*?"<>|]/g, "-")}.${kind}`,
    filters: [{ name: t(`files_filter_${kind}`), extensions: [kind] }],
  });
  if (!path) return;
  const names = [
    t("mt_you"),
    t("mt_others"),
    ...Array.from({ length: speakerCount(m.lines) }, (_, i) => who("others", i, m.speakerNames)),
  ];
  const segments = m.lines.map((l) => ({
    startMs: l.startMs,
    endMs: l.endMs,
    text: l.text,
    speaker: l.track === "you" ? 0 : l.speaker === undefined ? 1 : l.speaker + 2,
  }));
  const doc = {
    title: m.title,
    meta: `${clock(m.lengthMs)} · ${when(m.startedAt, m.utcOffsetMin)}`,
    segments,
    names,
    times: true,
    summary: m.notes ? notesText(m.notes) : null,
    summaryTitle: t("mt_notes"),
    transcriptTitle: t("files_transcript"),
  };
  let done: { text: string; tone: "ok" | "error" };
  try {
    await invoke("export_file", { kind, path, doc });
    done = { text: t("files_exported").replace("{name}", path.split(/[\\/]/).pop() ?? path), tone: "ok" };
  } catch (e) {
    done = { text: `${t("files_err_failed")}: ${e}`, tone: "error" };
  }
  // Another meeting may be open by now.
  if (view?.meeting.id === m.id) showFlash(done.text, done.tone);
}

function resetDelete() {
  window.clearTimeout(deleteArmed);
  deleteArmed = undefined;
  deleteBtn.classList.remove("armed");
  deleteBtn.textContent = t("mt_delete");
}

/** Asks once: the first click arms the button for 3 seconds. */
async function deleteMeeting() {
  if (!view) return;
  if (deleteArmed === undefined) {
    deleteBtn.classList.add("armed");
    deleteBtn.textContent = t("mt_delete_confirm");
    deleteArmed = window.setTimeout(resetDelete, 3000);
    return;
  }
  const id = view.meeting.id;
  resetDelete();
  try {
    await invoke("meeting_delete", { id });
    // Its "meetings-changed" may have closed the view already.
    if (!view || view.meeting.id === id) await closeView();
  } catch (e) {
    showFlash(errorText(e), "error");
  }
}

// ── Library ───────────────────────────────────────────

async function refreshList() {
  const seq = ++listSeq;
  const query = searchInput.value;
  let items: Summary[] = [];
  try {
    items = await invoke<Summary[]>("meeting_list", { query });
  } catch (e) {
    console.error("meeting_list failed:", e);
  }
  // A newer search or change asked again; that answer draws.
  if (seq !== listSeq) return;
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".mt-item")?.dataset.id;
  for (const s of items) titles.set(s.id, s.title);
  listEl.replaceChildren(...items.map(renderItem));
  if (focused) listEl.querySelector<HTMLElement>(`.mt-item[data-id="${CSS.escape(focused)}"]`)?.focus();
  emptyEl.textContent = t(query.trim() ? "mt_no_match" : "mt_empty");
  emptyEl.classList.toggle("hidden", items.length > 0);
  // Nothing to search in an empty library.
  searchInput.classList.toggle("hidden", items.length === 0 && query === "");
  renderFinishing();
}

function renderItem(s: Summary): HTMLElement {
  const item = document.createElement("button");
  item.className = "mt-item";
  item.dataset.id = s.id;
  const title = document.createElement("span");
  title.className = "mt-item-title";
  title.textContent = s.title;
  const meta = document.createElement("span");
  meta.className = "label-hint mt-item-meta";
  const parts = [when(s.startedAt, s.utcOffsetMin)];
  if (s.state !== "recording") parts.push(clock(s.lengthMs));
  if (s.lengthMs >= MAX_MS && s.state !== "recording") parts.push(t("mt_limit_short"));
  if (s.audioDeleted) parts.push(t("mt_no_audio_short"));
  meta.textContent = parts.join(" · ");
  item.append(title, meta);
  if (s.state !== "finished") {
    const badge = document.createElement("span");
    badge.className = "mt-badge";
    badge.dataset.state = s.state;
    badge.textContent = t(`mt_state_${s.state}`);
    item.append(badge);
  }
  item.addEventListener("click", () => {
    following = true;
    void open(s.id);
  });
  return item;
}

// ── Wiring ────────────────────────────────────────────

/** The title a meeting started now gets, as the field's placeholder. */
async function refreshPlaceholder() {
  try {
    titleInput.placeholder = await invoke<string>("meeting_default_title");
  } catch {
    titleInput.placeholder = "";
  }
}

/** Fill the tab again (on show and after a language change). */
export async function renderMeetings() {
  if (!host) return;
  titleInput.setAttribute("aria-label", t("mt_title_label"));
  searchInput.setAttribute("aria-label", t("mt_search"));
  transcriptEl.setAttribute("aria-label", t("files_transcript"));
  void refreshPlaceholder();
  // In the language of now.
  drawn.bar = drawn.finishing = "\0";
  renderStatus();
  renderView();
  if (!view) await refreshList();
}

/** The quit question, asked by the tray's Quit while a meeting records.
 *  Called when the app starts, before the settings are loaded: the question
 *  must not wait for the tab. */
export function initMeetingQuit() {
  let back: HTMLElement | null = null;
  const close = () => {
    quitDialog.classList.add("hidden");
    back?.focus();
    back = null;
  };
  quitOk.addEventListener("click", () => {
    quitOk.disabled = true;
    invoke("meeting_quit").catch((e) => {
      console.error("meeting_quit failed:", e);
      quitOk.disabled = false;
    });
  });
  quitCancel.addEventListener("click", close);
  quitDialog.addEventListener("mousedown", (e) => {
    if (e.target === quitDialog) close();
  });
  quitDialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // The two buttons are all there is: focus stays in the dialog.
      e.preventDefault();
      (document.activeElement === quitOk ? quitCancel : quitOk).focus();
    }
  });
  void listen("meeting-quit-asked", () => {
    if (quitDialog.classList.contains("hidden")) back = document.activeElement as HTMLElement | null;
    quitOk.disabled = false;
    quitDialog.classList.remove("hidden");
    quitOk.focus();
  });
}

export async function initMeetings(h: MeetingsHost) {
  host = h;
  startBtn.addEventListener("click", start);
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void start();
  });
  titleInput.addEventListener("focus", () => void refreshPlaceholder());
  stopBtn.addEventListener("click", stop);
  // The bar's title leads back to the meeting that records.
  barTitle.addEventListener("click", () => {
    if (!status.recording) return;
    following = true;
    void open(status.recording.id);
  });
  reminderClose.addEventListener("click", async () => {
    headphonesThisMeeting = false;
    try {
      await h.saveSettings({ meetingReminderOff: true, meetingHeadphonesSeen: true });
    } catch (e) {
      console.error("saving the settings failed:", e);
    }
    renderReminder();
  });
  backBtn.addEventListener("click", () => void closeView());
  viewTitle.addEventListener("click", renameTitle);
  copyBtn.addEventListener("click", () => copy(transcriptText(), copyBtn, "mt_copy_all"));
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setExportMenu(exportList.classList.contains("hidden"));
  });
  exportList.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((b) =>
    b.addEventListener("click", () => exportAs(b.dataset.kind as ExportKind)),
  );
  // A disclosure like the Files tab's: a click elsewhere, focus leaving it
  // or Escape closes it.
  document.addEventListener("click", () => setExportMenu(false));
  exportMenu.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (!next || !exportMenu.contains(next)) setExportMenu(false);
  });
  exportMenu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || exportList.classList.contains("hidden")) return;
    const returnFocus = exportList.contains(document.activeElement);
    setExportMenu(false);
    if (returnFocus) exportBtn.focus();
  });
  deleteBtn.addEventListener("click", deleteMeeting);
  transcriptEl.addEventListener("click", (e) => {
    const play = (e.target as Element).closest<HTMLButtonElement>(".mt-play");
    const row = play?.closest<HTMLElement>(".mt-para");
    if (play && row && !play.disabled) void togglePlay(Number(row.dataset.start));
  });
  // Scrolling up stops the following; Jump to live starts it again.
  transcriptEl.addEventListener("scroll", () => {
    if (view?.meeting.state !== "recording") return;
    const atEnd = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 24;
    following = atEnd;
    liveBtn.classList.toggle("hidden", atEnd);
  });
  liveBtn.addEventListener("click", () => {
    following = true;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    liveBtn.classList.add("hidden");
    transcriptEl.focus();
  });
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(refreshList, 200);
  });
  // The default title has the minute in it.
  window.setInterval(() => {
    if (section.classList.contains("active") && !view && !status.recording) void refreshPlaceholder();
  }, 30_000);

  await listen<Status>("meeting-status", (e) => onStatus(e.payload));
  await listen<LinesChanged>("meeting-lines", (e) => {
    linesSeen++;
    const { id, from, paragraphs } = e.payload;
    if (!view || view.meeting.id !== id) return;
    // A gap: this view missed lines (it was loaded around an event).
    if (from > view.paragraphs.length) {
      void open(id);
      return;
    }
    view.paragraphs = view.paragraphs.slice(0, from).concat(paragraphs);
    copyBtn.disabled = view.paragraphs.length === 0;
    renderSpeakers();
    renderTranscript();
  });
  await listen("meetings-changed", () => {
    if (view) void open(view.meeting.id);
    else void refreshList();
  });
  await listen<Playing | null>("meeting-playing", (e) => {
    playing = e.payload;
    syncRows();
  });
  await listen<{ percent: number }>("speaker-model-progress", (e) => {
    speakerModelPercent = Math.round(e.payload.percent);
    if (running.has("speaker-model")) renderHints();
  });

  const seen = statusSeen;
  try {
    const current = await invoke<{ status: Status; meeting: MeetingView | null }>("meeting_state");
    // A status event during the question is newer than its answer.
    if (seen === statusSeen) {
      status = current.status;
      if (current.meeting && !view) view = current.meeting;
    }
  } catch (e) {
    console.error("meeting_state failed:", e);
  }
  await renderMeetings();
}
