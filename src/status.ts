// The one status the sidebar and Home show, worked out from what the backend
// reports. Pure: no DOM and no Tauri, so node tests it
// (tests/unit/status.test.ts).

export type LoadState = "unloaded" | "loading" | "loaded" | "failed";

/** The backend's `speech_status` (and its `speech-status` event). */
export interface SpeechStatus {
  /** "local" or "cloud". */
  engine: string;
  /** The selected speech model, e.g. "small". */
  model: string;
  /** The selected model's file is on disk. */
  downloaded: boolean;
  load: LoadState;
  /** Unloaded by Free GPU, for a game or when idle; the next dictation loads it. */
  freed: boolean;
  /** The cloud engine has an API key. */
  cloudKey: boolean;
  /** Where the model runs while it is loaded, e.g. "NVIDIA GeForce RTX 5080 (CUDA)". */
  device: string;
}

export interface StatusInput {
  /** null until the backend answered. */
  speech: SpeechStatus | null;
  /** Microphones Windows lists; null until known. */
  microphones: number | null;
  /** Percent of a model download that runs (speech, AI or speaker model; the one that started first); null: none. */
  download: number | null;
  /** Percent of the speech model's own download; null while it does not run. */
  speechDownload: number | null;
  /** The dictation: "Ready", "Recording" or "Transcribing" (`recording-state`). */
  dictation: string;
  meetingRecording: boolean;
  fileRunning: boolean;
  /** AI cleanup is on and its model is loading. */
  aiLoading: boolean;
  /** AI cleanup is on and its model was unloaded to free the GPU. */
  aiFreed: boolean;
  /** Freed for a game (`game-free`). */
  gameFreed: boolean;
}

/** What keeps a dictation from working, first things first. */
export type Missing = "microphone" | "model" | "key" | "load";

export type StatusKind =
  | "setup"
  | "downloading"
  | "recording"
  | "transcribing"
  | "meeting"
  | "file"
  | "loading"
  | "game"
  | "freed"
  | "ready";

export type Tone = "ok" | "warn" | "busy" | "rec" | "idle";

export interface Status {
  kind: StatusKind;
  tone: Tone;
  /** What keeps a dictation from working: for kind "setup" all of it, for
   *  kind "downloading" the speech model while it is the one that downloads;
   *  empty in every other state. */
  missing: Missing[];
  /** kind "downloading": 0–100. */
  percent: number;
  /** A meeting records or a file runs while another state has priority. */
  marker: "meeting" | "file" | null;
}

const TONE: Record<StatusKind, Tone> = {
  setup: "warn",
  downloading: "busy",
  recording: "rec",
  transcribing: "busy",
  meeting: "rec",
  file: "busy",
  loading: "busy",
  game: "idle",
  freed: "idle",
  ready: "ok",
};

export function missing(input: StatusInput): Missing[] {
  const out: Missing[] = [];
  if (input.microphones === 0) out.push("microphone");
  const s = input.speech;
  if (!s) return out;
  if (s.engine === "cloud") {
    if (!s.cloudKey) out.push("key");
  } else if (!s.downloaded) {
    out.push("model");
  } else if (s.load === "failed") {
    out.push("load");
  }
  return out;
}

/** The speech model is all that is missing, and it is on its way: the one
 *  download every new user makes shows its percent, not "Setup needed". */
function fetchingSpeech(input: StatusInput, miss: Missing[]): boolean {
  return miss.length === 1 && miss[0] === "model" && input.speechDownload !== null;
}

function kindOf(input: StatusInput, miss: Missing[]): StatusKind {
  if (fetchingSpeech(input, miss)) return "downloading";
  if (miss.length > 0) return "setup";
  if (input.download !== null) return "downloading";
  if (input.dictation === "Recording") return "recording";
  if (input.dictation === "Transcribing") return "transcribing";
  if (input.meetingRecording) return "meeting";
  if (input.fileRunning) return "file";
  const s = input.speech;
  // Not known yet: the app has just started.
  if (!s || input.microphones === null) return "loading";
  const local = s.engine !== "cloud";
  const speechFreed = local && s.load === "unloaded" && s.freed;
  // Loading, or about to: the app loads the model at its start and after a
  // change of the model.
  if (local && s.load !== "loaded" && !speechFreed) return "loading";
  if (input.aiLoading) return "loading";
  if (input.gameFreed) return "game";
  if (speechFreed || input.aiFreed) return "freed";
  return "ready";
}

/** Setup needed › Downloading › Recording › Transcribing › Meeting recording ›
 *  Transcribing a file › Loading models › Freed for a game / GPU freed › Ready.
 *  One case comes before "Setup needed": the speech model is the only thing
 *  missing and it downloads; then the status is that download's percent. */
export function status(input: StatusInput): Status {
  const miss = missing(input);
  const kind = kindOf(input, miss);
  const fetching = fetchingSpeech(input, miss);
  const marker = input.meetingRecording && kind !== "meeting" ? "meeting" : input.fileRunning && kind !== "file" ? "file" : null;
  const percent = fetching ? input.speechDownload : input.download;
  return {
    kind,
    tone: TONE[kind],
    missing: kind === "setup" || fetching ? miss : [],
    percent: kind === "downloading" ? Math.max(0, Math.min(100, Math.round(percent ?? 0))) : 0,
    marker,
  };
}

/** The i18n key of the status text and what to fill in for "{n}". */
export function statusText(s: Status): { key: string; n: string } {
  if (s.kind === "setup") return { key: `status_setup_${s.missing[0]}`, n: "" };
  if (s.kind === "downloading") return { key: "status_downloading", n: String(s.percent) };
  return { key: `status_${s.kind}`, n: "" };
}

/** What a screen reader is told (i18n keys): the status without a download's
 *  percent, which would be read out at every step, and the marker. It
 *  changes only when the kind, what is missing or the marker changes. */
export function statusSaid(s: Status): { key: string; marker: string | null } {
  return {
    key: s.kind === "downloading" ? "status_downloading_said" : statusText(s).key,
    marker: s.marker ? `status_marker_${s.marker}` : null,
  };
}

/** The i18n key of Home's heading: a dictation works in every state but
 *  these. A download does not stand in its way (an AI model's 5 GB arrive
 *  beside a loaded speech model), unless it is the missing speech model's. */
export function homeTitle(s: Status): string {
  if (s.missing.length > 0) return "home_title_setup";
  if (s.kind === "loading") return "home_title_loading";
  return "home_title_ready";
}
