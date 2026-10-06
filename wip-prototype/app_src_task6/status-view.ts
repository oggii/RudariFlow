// The status under the logo: gathers what the backend reports, asks
// src/status.ts which state wins, and shows it. Home shows the same status
// (onStatus).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { activity, onActivity } from "./activity";
import { status, statusText, type SpeechStatus, type Status, type StatusInput } from "./status.ts";

export interface StatusHost {
  /** Microphones Windows lists; null until they were listed. */
  microphones(): number | null;
  /** AI cleanup is on and its model is loading / was unloaded to free the GPU. */
  ai(): { loading: boolean; freed: boolean };
}

const pill = document.getElementById("status-indicator")!;
const text = document.getElementById("status-text")!;
const marker = document.getElementById("status-marker")!;

let host: StatusHost | null = null;
let speech: SpeechStatus | null = null;
let dictation = "Ready";
let meetingRecording = false;
let gameFreed = false;
const listeners: ((now: Status) => void)[] = [];

export function statusInput(): StatusInput {
  const ai = host?.ai() ?? { loading: false, freed: false };
  return {
    speech,
    microphones: host?.microphones() ?? null,
    download: activity().download,
    dictation,
    meetingRecording,
    fileRunning: activity().fileRunning,
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

/** Work the status out again and show it. Call it when something it is
 *  made of changed here in the page (the microphones, the AI, the language). */
export function renderStatus() {
  const now = currentStatus();
  const { key, n } = statusText(now);
  pill.dataset.tone = now.tone;
  pill.dataset.kind = now.kind;
  // Not a data-i18n text: "{n}" is filled in, and a language change calls this again.
  text.removeAttribute("data-i18n");
  text.textContent = t(key).replace("{n}", n);
  marker.classList.toggle("hidden", now.marker === null);
  if (now.marker) {
    const label = t(`status_marker_${now.marker}`);
    marker.dataset.marker = now.marker;
    marker.title = label;
    marker.setAttribute("aria-label", label);
  }
  for (const fn of listeners) fn(now);
}

/** Ask the backend for the speech model's state (also sent as "speech-status" when it changes). */
export async function refreshSpeech() {
  try {
    speech = await invoke<SpeechStatus>("speech_status");
  } catch (e) {
    console.error("speech_status failed:", e);
  }
  renderStatus();
}

export async function initStatus(h: StatusHost) {
  host = h;
  onActivity(renderStatus);
  listen<SpeechStatus>("speech-status", (e) => {
    speech = e.payload;
    renderStatus();
  });
  listen<string>("recording-state", (e) => {
    dictation = e.payload;
    renderStatus();
  });
  listen<{ recording: unknown | null }>("meeting-status", (e) => {
    meetingRecording = e.payload.recording !== null;
    renderStatus();
  });
  listen<boolean>("game-free", (e) => {
    gameFreed = e.payload;
    renderStatus();
  });
  // Whatever happened while the window was away.
  window.addEventListener("focus", () => void refreshSpeech());
  const [state, meeting, game] = await Promise.all([
    invoke<string>("get_recording_state").catch(() => "Ready"),
    invoke<{ status: { recording: unknown | null } }>("meeting_state").catch(() => null),
    invoke<boolean>("game_free_state").catch(() => false),
  ]);
  dictation = state;
  meetingRecording = !!meeting && meeting.status.recording !== null;
  gameFreed = game;
  await refreshSpeech();
}
