// The first run: which setup steps are done, and which models to suggest
// for this PC. Pure (tests/unit/setup.test.ts); src/home.ts shows the steps.
import type { SpeechStatus } from "./status.ts";

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
