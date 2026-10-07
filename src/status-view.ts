// The status under the logo: gathers what the backend reports, asks
// src/status.ts which state wins, and shows it. Home shows the same status
// (onStatus).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { activity, onActivity } from "./activity";
import { homeTitle, status, statusSaid, statusText, type SpeechStatus, type Status, type StatusInput } from "./status.ts";

export interface StatusHost {
  /** Microphones Windows lists; null until they were listed. */
  microphones(): number | null;
  /** AI cleanup is on and its model is loading / was unloaded to free the GPU. */
  ai(): { loading: boolean; freed: boolean };
}

const pill = document.getElementById("status-indicator")!;
const text = document.getElementById("status-text")!;
const marker = document.getElementById("status-marker")!;
const live = document.getElementById("status-live")!;
const homeHeading = document.getElementById("home-title");

let host: StatusHost | null = null;
let speech: SpeechStatus | null = null;
let dictation = "Ready";
let meetingRecording = false;
let gameFreed = false;
/** Events received so far, by what they report. An answer to a question
 *  that was out while one arrived is the older news and is dropped: the
 *  backend sends a state once and does not repeat it. */
const events = { speech: 0, dictation: 0, meeting: 0, game: 0 };
const listeners: ((now: Status) => void)[] = [];

export function statusInput(): StatusInput {
  const ai = host?.ai() ?? { loading: false, freed: false };
  const running = activity();
  return {
    speech,
    microphones: host?.microphones() ?? null,
    download: running.download,
    speechDownload: running.speech,
    dictation,
    meetingRecording,
    fileRunning: running.fileRunning,
    aiLoading: ai.loading,
    aiFreed: ai.freed,
    gameFreed,
  };
}

export function currentStatus(): Status {
  return status(statusInput());
}

/** The speech model's state as the backend last reported it. */
export function currentSpeech(): SpeechStatus | null {
  return speech;
}

/** Called with every status that is shown. */
export function onStatus(fn: (now: Status) => void) {
  listeners.push(fn);
}

/** The text in the pill. "Setup needed: no speech model" keeps its reason
 *  together: in the narrow pill the line breaks after the colon, not inside
 *  the reason. */
function write(words: string, setup: boolean) {
  const colon = setup ? words.indexOf(": ") : -1;
  if (colon < 0) {
    text.textContent = words;
    return;
  }
  const reason = document.createElement("span");
  reason.className = "status-reason";
  reason.textContent = words.slice(colon + 2);
  text.replaceChildren(words.slice(0, colon + 2), reason);
}

/** Work the status out again and show it. Call it when something it is
 *  made of changed here in the page (the microphones, the AI, the language). */
export function renderStatus() {
  const now = currentStatus();
  const { key, n } = statusText(now);
  pill.dataset.tone = now.tone;
  pill.dataset.kind = now.kind;
  // Not a data-i18n text: "{n}" is filled in, and a language change calls this again.
  text.removeAttribute("data-i18n");
  // Only what differs is written: a download reports far more often than its percent changes.
  const words = t(key).replace("{n}", n);
  if (text.textContent !== words) write(words, now.kind === "setup");
  marker.classList.toggle("hidden", now.marker === null);
  if (now.marker) {
    const label = t(`status_marker_${now.marker}`);
    marker.dataset.marker = now.marker;
    marker.title = label;
    marker.setAttribute("aria-label", label);
  }
  // What is read out. The text above is hidden from a screen reader: every
  // percent of a download would be announced. This line has no number and
  // changes only with the kind, what is missing or the marker.
  const said = statusSaid(now);
  const spoken = said.marker ? `${t(said.key).replace(/…$/, "")}. ${t(said.marker)}` : t(said.key);
  if (live.textContent !== spoken) live.textContent = spoken;
  // Home's heading says the same as the status. Until Home has its own page
  // code (src/home.ts, which then writes the heading from `onStatus` below
  // and makes these lines superfluous) nothing else would set it.
  if (homeHeading) {
    homeHeading.removeAttribute("data-i18n");
    const title = t(homeTitle(now));
    if (homeHeading.textContent !== title) homeHeading.textContent = title;
  }
  for (const fn of listeners) fn(now);
}

/** Ask the backend for the speech model's state (also sent as "speech-status" when it changes). */
export async function refreshSpeech() {
  const before = events.speech;
  try {
    const answer = await invoke<SpeechStatus>("speech_status");
    if (events.speech === before) speech = answer;
  } catch (e) {
    console.error("speech_status failed:", e);
  }
  renderStatus();
}

export async function initStatus(h: StatusHost) {
  host = h;
  onActivity(renderStatus);
  listen<SpeechStatus>("speech-status", (e) => {
    events.speech++;
    speech = e.payload;
    renderStatus();
  });
  listen<string>("recording-state", (e) => {
    events.dictation++;
    dictation = e.payload;
    renderStatus();
  });
  listen<{ recording: unknown | null }>("meeting-status", (e) => {
    events.meeting++;
    meetingRecording = e.payload.recording !== null;
    renderStatus();
  });
  listen<boolean>("game-free", (e) => {
    events.game++;
    gameFreed = e.payload;
    renderStatus();
  });
  // Whatever happened while the window was away.
  window.addEventListener("focus", () => void refreshSpeech());
  const before = { ...events };
  const [state, meeting, game] = await Promise.all([
    invoke<string>("get_recording_state").catch(() => "Ready"),
    invoke<{ status: { recording: unknown | null } }>("meeting_state").catch(() => null),
    invoke<boolean>("game_free_state").catch(() => false),
  ]);
  if (events.dictation === before.dictation) dictation = state;
  if (events.meeting === before.meeting) meetingRecording = !!meeting && meeting.status.recording !== null;
  if (events.game === before.game) gameFreed = game;
  await refreshSpeech();
}
