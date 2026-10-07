// The first run: which setup steps are done, which models to suggest for
// this PC, how the speech model's step stands, when the microphone's level
// may run, and what Home's heading says meanwhile. Pure
// (tests/unit/setup.test.ts); src/home.ts shows the steps.
import { homeTitle, statusText, type SpeechStatus, type Status } from "./status.ts";

export interface SetupInput {
  /** null until the backend answered. */
  speech: SpeechStatus | null;
  /** Microphones Windows lists; null until known. */
  microphones: number | null;
  /** The selected AI model is downloaded. */
  aiDownloaded: boolean;
  /** The user closed the optional AI cleanup card. */
  aiDismissed: boolean;
}

export interface Setup {
  /** Home shows the setup steps instead of the daily view. */
  needed: boolean;
  /** Step 1: a microphone is there. */
  microphone: boolean;
  /** Step 2: a speech model is there (or the cloud engine has its key). */
  model: boolean;
  /** The optional card "AI cleanup": until its model is downloaded or the card is closed. */
  aiCard: boolean;
}

/** Step 3, the dictation key, has nothing to wait for: it always has a default. */
export function setup(input: SetupInput): Setup {
  const s = input.speech;
  // Nothing is shown as missing before the backend answered.
  if (!s || input.microphones === null) return { needed: false, microphone: true, model: true, aiCard: false };
  const microphone = input.microphones > 0;
  const model = s.engine === "cloud" ? s.cloudKey : s.downloaded;
  return { needed: !(microphone && model), microphone, model, aiCard: !input.aiDownloaded && !input.aiDismissed };
}

/** A graphics card as `detect_gpus` lists it. */
export interface Gpu {
  name: string;
  integrated: boolean;
  memory_mib: number;
}

export interface Recommendation {
  /** Speech model id. */
  model: string;
  /** AI model id. */
  ai: string;
  /** The graphics card it is for; "" without a dedicated one. */
  gpu: string;
}

/** Up to this much video memory the small AI model fits best (the Models & GPU hint's rule). */
const SMALL_VRAM_GB = 8.5;

/** The rule of the hints under "GPU backend": without a dedicated card
 *  Whisper Small and Gemma 4 E2B; with one Large v3 Turbo q8, and the
 *  bigger AI model from more than 8.5 GB of video memory. */
export function recommend(gpus: Gpu[]): Recommendation {
  // An integrated GPU reports shared system memory, so only dedicated cards count.
  const dedicated = gpus.filter((g) => !g.integrated).sort((a, b) => b.memory_mib - a.memory_mib);
  if (dedicated.length === 0) return { model: "small", ai: "gemma-4-e2b", gpu: "" };
  const best = dedicated[0];
  return {
    model: "large-v3-turbo-q8_0",
    ai: best.memory_mib / 1024 <= SMALL_VRAM_GB ? "gemma-4-e2b" : "gemma-4-e4b",
    gpu: best.name,
  };
}

/** A file size in words: "870 MB", "5.0 GB". What would round to "1000 MB" is "1.0 GB". */
export function sizeText(bytes: number): string {
  const mb = Math.max(1, Math.round(bytes / 1e6));
  return mb >= 1000 ? `${(bytes / 1e9).toFixed(1)} GB` : `${mb} MB`;
}

/** What a download reports while it runs. */
export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

/** A download's numbers: the percent as a whole number from 0 to 100, what
 *  stands under the bar ("43 % · 201 MB of 466 MB") and what the bar itself
 *  says to a screen reader ("43 %, 201 MB of 466 MB"). `shown` and `said`
 *  are the two sentences with "{percent}", "{done}" and "{total}" in them.
 *  Before the first report, and from a server that does not say how much is
 *  to come, there is no size to show: then what has arrived, or the percent
 *  alone. */
export function progressWords(p: DownloadProgress, shown: string, said: string): { percent: number; shown: string; said: string } {
  const percent = Math.max(0, Math.min(100, Math.round(p.percent) || 0));
  if (p.total > 0) {
    const fill = (text: string) => text.replace("{percent}", String(percent)).replace("{done}", sizeText(p.downloaded)).replace("{total}", sizeText(p.total));
    return { percent, shown: fill(shown), said: fill(said) };
  }
  const alone = p.downloaded > 0 ? sizeText(p.downloaded) : `${percent} %`;
  return { percent, shown: alone, said: alone };
}

// ── Home's heading ────────────────────────────────────

/** Home's heading and the pill beside it, as i18n keys; `n` fills the pill's "{n}". */
export interface Header {
  title: string;
  pill: string;
  n: string;
}

/** The heading and the pill never say the same thing twice. Beside the
 *  welcome (a PC without a speech model) the pill is the short state, "Setup
 *  needed" or the download's percent: the steps below say what is missing.
 *  Under the plain heading "Setup needed" (a microphone that was unplugged
 *  later, a cloud key that is gone, a model that did not load) it is only
 *  the reason. In every other state it is the status as the sidebar has it. */
export function header(now: Status, s: Setup, cloud: boolean): Header {
  const full = statusText(now);
  if (s.needed && !s.model && !cloud) return { title: "setup_title", pill: now.kind === "setup" ? "home_title_setup" : full.key, n: full.n };
  const title = homeTitle(now);
  if (now.kind === "setup") return { title, pill: `home_reason_${now.missing[0]}`, n: "" };
  return { title, pill: full.key, n: full.n };
}

// ── Step 2, the speech model ──────────────────────────

/** How step 2 stands. With the cloud engine: "key" (its key is missing) or
 *  "cloud". With the local one: "checking" (which model to suggest is not
 *  known yet), "todo", "starting" (Download was pressed, the download has not
 *  begun), "downloading", "failed", and with the model there "loading" or
 *  "done". */
export type ModelStep = "key" | "cloud" | "checking" | "todo" | "starting" | "downloading" | "failed" | "loading" | "done";

export interface ModelStepInput {
  /** null until the backend answered. */
  speech: SpeechStatus | null;
  /** The speech model's download runs (the status has it). */
  fetching: boolean;
  /** It ran when the step was last drawn. */
  wasFetching: boolean;
  /** The step said last that the download had failed. */
  wasFailed: boolean;
  /** Download was pressed here and what it started has not ended. */
  starting: boolean;
  /** The models to suggest for this PC are known. */
  suggested: boolean;
}

/** Step 2's state, and whether its download counts as failed from here on.
 *  A download leaves the status only once the model is known to be there
 *  (src/main.ts), so one that ends without the model has failed; that holds
 *  until a new try starts or the model is there. */
export function modelStep(input: ModelStepInput): { state: ModelStep; failed: boolean } {
  const s = input.speech;
  const cloud = s?.engine === "cloud";
  const there = !!s && (cloud ? s.cloudKey : s.downloaded);
  const busy = input.fetching || input.starting;
  const failed = !busy && !there && (input.wasFetching || input.wasFailed);
  let state: ModelStep;
  if (cloud) state = there ? "cloud" : "key";
  else if (there) state = s?.load === "loading" ? "loading" : "done";
  else if (input.fetching) state = "downloading";
  else if (input.starting) state = "starting";
  else if (failed) state = "failed";
  else state = input.suggested ? "todo" : "checking";
  return { state, failed };
}

// ── Step 1, the microphone's level ────────────────────

/** The level is started, or started again, only while the user touched the
 *  window this recently (pointer, key, click, focus). */
export const METER_USE_MS = 60_000;

/** How long ago the last touch was, from what two clocks say has passed
 *  since: the one that counts while the page runs (`performance.now()`) and
 *  the wall clock. The longer answer counts. The first can stand still
 *  while the PC sleeps, the second can be set back (then it says less than
 *  nothing: taken as 0): neither stretches the minute. */
export function idleFor(running: number, wall: number): number {
  return Math.max(running, wall, 0);
}
/** The backend sends about 30 levels a second. Without one for this long its
 *  meter is over: it stops by itself after two minutes, when the window is
 *  closed to the tray and when the microphone is unplugged, and says nothing. */
export const METER_SILENT_MS = 1500;
/** A meter that fell silent is started again at most this often. */
export const METER_REVIVE_MS = 5000;

export interface MeterInput {
  /** The steps are on screen: the setup is needed, Home is the page, the document is not hidden. */
  steps: boolean;
  /** The window shows, as the window itself last answered: not hidden to the tray, not minimized. */
  shown: boolean;
  /** Windows lists a microphone. */
  microphone: boolean;
  /** The microphone did not open: no new try by itself. */
  failed: boolean;
  /** Milliseconds since the user last touched the window; null: never. */
  idle: number | null;
}

/** May the microphone be opened for the level now? Only for someone who is
 *  at this window: a window that is covered by another app, a locked PC and
 *  a PC that slept all still "show". */
export function meterMay(m: MeterInput): boolean {
  return m.steps && m.shown && m.microphone && !m.failed && m.idle !== null && m.idle <= METER_USE_MS;
}

export interface MeterNow extends MeterInput {
  /** The page asked for the meter and has not asked to stop it. */
  on: boolean;
  /** Its start has not answered yet (a device can take seconds to open). */
  opening: boolean;
  /** Milliseconds since the last level arrived. */
  silent: number;
  /** Milliseconds since the meter was last started. */
  sinceStart: number;
}

/** What to do with the meter: "start" it, "restart" one that fell silent,
 *  "stop" it, or "keep" things as they are. One that runs is left to run to
 *  the backend's limit; once it is silent it comes back only for a user who
 *  is still there, and is given up otherwise. */
export function meterStep(m: MeterNow): "start" | "restart" | "stop" | "keep" {
  if (!m.on) return meterMay(m) ? "start" : "keep";
  if (!(m.steps && m.shown && m.microphone && !m.failed)) return "stop";
  if (m.opening || m.silent <= METER_SILENT_MS) return "keep";
  if (!meterMay(m)) return "stop";
  return m.sinceStart > METER_REVIVE_MS ? "restart" : "keep";
}
