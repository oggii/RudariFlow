// What runs in the background and shows in the status: model downloads and
// a file being transcribed. The parts that start them (main.ts,
// ai-settings.ts, files.ts) report here; status-view.ts listens.

type Listener = () => void;

/** The models that download: the speech model, the AI model, the speaker model. */
export type DownloadKind = "speech" | "ai" | "speaker";

/** Each download that runs → its percent, in the order they started. */
const downloads = new Map<DownloadKind, number>();
let fileRunning = false;
const listeners: Listener[] = [];

function changed() {
  for (const fn of listeners) fn();
}

/** A download's progress in percent; null when it is over (done or failed). */
export function setDownload(kind: DownloadKind, percent: number | null) {
  const before = downloads.get(kind) ?? null;
  if (percent === null) downloads.delete(kind);
  else downloads.set(kind, percent);
  if (before !== percent) changed();
}

export function setFileRunning(on: boolean) {
  if (fileRunning === on) return;
  fileRunning = on;
  changed();
}

export interface Activity {
  /** Percent of the download to show (the one that started first); null: none runs. */
  download: number | null;
  /** Which download that is. */
  kind: DownloadKind | null;
  /** Percent of the speech model's download, also while another one started first; null: it does not run. */
  speech: number | null;
  fileRunning: boolean;
}

export function activity(): Activity {
  const first = downloads.entries().next();
  return {
    download: first.done ? null : first.value[1],
    kind: first.done ? null : first.value[0],
    speech: downloads.get("speech") ?? null,
    fileRunning,
  };
}

export function onActivity(fn: Listener) {
  listeners.push(fn);
}
