// What runs in the background and shows in the status: model downloads and
// a file being transcribed. The parts that start them (main.ts,
// ai-settings.ts, files.ts) report here; status-view.ts listens.

type Listener = () => void;

/** "speech", "ai", "speaker" → percent. */
const downloads = new Map<string, number>();
let fileRunning = false;
const listeners: Listener[] = [];

function changed() {
  for (const fn of listeners) fn();
}

/** A download's progress in percent; null when it is over (done or failed). */
export function setDownload(kind: "speech" | "ai" | "speaker", percent: number | null) {
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

/** The download to show (the one that started first), and whether a file runs. */
export function activity(): { download: number | null; fileRunning: boolean } {
  const first = downloads.values().next();
  return { download: first.done ? null : first.value, fileRunning };
}

export function onActivity(fn: Listener) {
  listeners.push(fn);
}
