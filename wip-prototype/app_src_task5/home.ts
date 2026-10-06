// Home, the dictation page. The daily view: the hotkeys (set in place), the
// quick switches (the same settings as in Settings, mirrored), what is
// loaded, "add a word", and the recent dictations (src/history.ts). Before
// the setup is done: the first-run steps instead.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { activity } from "./activity";
import { mirrorSelect, mirrorSwitch } from "./mirror";
import { prefs, rememberPrefs, reveal } from "./shell";
import { currentSpeech, currentStatus, onStatus } from "./status-view";
import { homeTitle, statusText, type Status } from "./status.ts";
import { recommend, setup, sizeText, type Gpu, type Recommendation } from "./setup.ts";

export interface HomeHost {
  /** "push-to-talk" or "toggle". */
  recordingMode(): string;
  /** The dictation hotkey as it is shown ("Ctrl+Shift+Space"). */
  dictationKey(): string;
  /** Microphones Windows lists; null until they were listed. */
  microphones(): number | null;
  /** The AI model in use and its state line, as Settings shows them. */
  ai(): { name: string; state: string; tone: string; downloaded: boolean };
  /** An AI model's name and size (the setup suggests one for this PC). */
  aiModel(id: string): { name: string; bytes: number } | null;
  /** Add words to the dictionary; how many were new. */
  addWords(text: string): Promise<number>;
  /** Choose this AI model, download it and turn AI cleanup on. */
  setUpAi(id: string): Promise<boolean>;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const title = $("home-title");
const pill = $("home-status");
const pillText = $("home-status-text");
const how = $("home-how");
const notice = $("home-notice");
const daily = $("home-daily");
const recent = $("home-recent");
const setupBox = $("home-setup");
const aiCard = $("home-ai-card");

let host: HomeHost;
let syncs: (() => void)[] = [];
let gpus: Gpu[] = [];
let suggestion: Recommendation = recommend([]);
/** The setup's microphone meter runs (the backend keeps the microphone open). */
let metering = false;
/** The layout the cards are in: two columns or one; null before the first look. */
let laidOutWide: boolean | null = null;

// ── Header ────────────────────────────────────────────

/** "Hold ‹key› and speak.": the sentence with the key as a key box. */
function renderHow() {
  const [before, after] = t(host.recordingMode() === "toggle" ? "home_how_toggle" : "home_how_hold").split("{key}");
  const key = document.createElement("kbd");
  key.textContent = host.dictationKey();
  how.replaceChildren(before, key, after ?? "");
}

function renderHeader(now: Status, firstRun: boolean) {
  const { key, n } = statusText(now);
  title.removeAttribute("data-i18n");
  title.textContent = t(firstRun ? "setup_title" : homeTitle(now));
  pill.dataset.tone = now.tone;
  pillText.textContent = t(key).replace("{n}", n);
  how.classList.toggle("hidden", firstRun);
  // The speech model is there and did not load: say what helps.
  notice.classList.toggle("hidden", !now.missing.includes("load"));
}

// ── What is loaded ────────────────────────────────────

/** The speech model's name as its dropdown shows it, without the "downloaded" mark. */
function speechModelName(id: string): string {
  const option = document.querySelector<HTMLOptionElement>(`#model-select option[value="${CSS.escape(id)}"]`);
  return (option?.dataset.baseText ?? option?.textContent ?? id).replace(/\s*✓$/, "");
}

function renderLoaded() {
  const speech = currentSpeech();
  const speechLine = $("home-loaded-speech");
  if (!speech) {
    speechLine.textContent = "";
  } else if (speech.engine === "cloud") {
    speechLine.textContent = t("engine_cloud");
    speechLine.dataset.tone = speech.cloudKey ? "ok" : "warn";
  } else {
    const state: Record<string, string> = {
      loaded: speech.device,
      loading: t("home_speech_loading"),
      failed: t("home_speech_failed"),
      unloaded: speech.downloaded ? t("home_speech_unloaded") : t("home_speech_missing"),
    };
    speechLine.textContent = `${speechModelName(speech.model)} · ${state[speech.load]}`;
    speechLine.dataset.tone = speech.load === "loaded" ? "ok" : speech.load === "failed" || !speech.downloaded ? "warn" : "";
  }
  const ai = host.ai();
  const aiLine = $("home-loaded-ai");
  aiLine.textContent = `${ai.name} · ${ai.state}`;
  aiLine.dataset.tone = ai.tone;
  const mic = document.querySelector<HTMLSelectElement>("#mic-select");
  $("home-loaded-mic").textContent = mic?.selectedOptions[0]?.textContent ?? "";
  // The AI's state line under the quick switch.
  const line = $("home-ai-status");
  line.textContent = ai.state;
  line.dataset.tone = ai.tone;
}

// ── First run ─────────────────────────────────────────

function currentSetup() {
  return setup({ speech: currentSpeech(), microphones: host.microphones(), aiDownloaded: host.ai().downloaded, aiDismissed: prefs.aiCardDismissed });
}

function step(id: string, done: boolean) {
  const el = $(id);
  el.dataset.done = String(done);
  el.querySelector(".setup-num")!.textContent = done ? "✓" : el.id === "setup-mic" ? "1" : el.id === "setup-model" ? "2" : "3";
}

function renderSetup() {
  const s = currentSetup();
  const speech = currentSpeech();
  setupBox.classList.toggle("hidden", !s.needed);
  daily.classList.toggle("hidden", s.needed);
  aiCard.classList.toggle("hidden", !s.aiCard);
  void meter(s.needed && !document.hidden && $("section-home").classList.contains("active"));

  if (s.needed) {
    step("setup-mic", s.microphone);
    const mic = document.querySelector<HTMLSelectElement>("#mic-select");
    $("setup-mic-text").textContent = s.microphone ? `${mic?.selectedOptions[0]?.textContent ?? ""}. ${t("setup_mic_hint")}` : t("setup_mic_missing");
    $("setup-level").classList.toggle("hidden", !s.microphone);
    $("setup-mic-change").classList.toggle("hidden", !s.microphone || !$("setup-mic-select").classList.contains("hidden"));

    step("setup-model", s.model);
    const download = $<HTMLButtonElement>("setup-model-download");
    const text = $("setup-model-text");
    if (speech?.engine === "cloud") {
      text.textContent = t(s.model ? "setup_model_cloud" : "setup_model_cloud_key");
      download.textContent = t("home_open_models");
      download.classList.toggle("hidden", s.model);
    } else if (s.model) {
      text.textContent = t("setup_model_done").replace("{model}", speechModelName(speech?.model ?? ""));
      download.classList.add("hidden");
    } else {
      const name = speechModelName(suggestion.model);
      text.textContent = suggestion.gpu ? t("setup_model_for").replace("{gpu}", suggestion.gpu).replace("{model}", name) : t("setup_model_cpu").replace("{model}", name);
      download.textContent = t("download");
      download.classList.remove("hidden");
    }

    step("setup-key", true);
    $("setup-key-text").textContent = t(host.recordingMode() === "toggle" ? "setup_key_toggle" : "setup_key_hold");
  }
  if (s.aiCard) {
    const ai = host.aiModel(suggestion.ai);
    $("setup-ai-text").textContent = t("setup_ai_text").replace("{model}", ai?.name ?? "").replace("{size}", ai ? sizeText(ai.bytes) : "");
  }
  // A download that ended, also one that failed: its bar goes.
  if (activity().download === null) {
    progress("setup-model", null);
    progress("setup-ai", null);
  }
}

/** The microphone's level while the setup shows; off as soon as it does not. */
async function meter(on: boolean) {
  if (on === metering) return;
  metering = on;
  try {
    await invoke(on ? "mic_meter_start" : "mic_meter_stop");
  } catch (e) {
    console.error("the microphone meter:", e);
    if (on) metering = false;
  }
  if (!on) $("setup-level-fill").style.width = "0%";
}

function progress(prefix: string, p: DownloadProgress | null) {
  const box = $(`${prefix}-progress`);
  box.classList.toggle("hidden", p === null);
  if (!p) return;
  $(`${prefix}-fill`).style.width = `${p.percent}%`;
  $(`${prefix}-numbers`).textContent = t("progress_numbers")
    .replace("{percent}", String(Math.round(p.percent)))
    .replace("{done}", sizeText(p.downloaded))
    .replace("{total}", sizeText(p.total));
}

// ── Layout ────────────────────────────────────────────

/** Two columns from 900 px of content; in one column the recent dictations
 *  come right after the quick switches. The card is moved, so the Tab order
 *  is the order on the page in both. */
function layout() {
  const wide = $("content").clientWidth >= 900;
  if (wide === laidOutWide) return;
  laidOutWide = wide;
  daily.classList.toggle("wide", wide);
  if (wide) daily.append(recent);
  else $("home-switches").after(recent);
}

// ── Wiring ────────────────────────────────────────────

/** Draw Home again from the settings and the status (after a load, a save, a language change). */
export function renderHome() {
  if (!host) return;
  for (const sync of syncs) sync();
  const now = currentStatus();
  renderHeader(now, currentSetup().needed);
  renderHow();
  renderLoaded();
  renderSetup();
}

export function initHome(h: HomeHost) {
  host = h;
  const select = (id: string) => $<HTMLSelectElement>(id);
  syncs = [
    mirrorSwitch($<HTMLInputElement>("ai-toggle"), $<HTMLInputElement>("home-ai-toggle")),
    mirrorSelect(select("language-select"), select("home-language-select")),
    mirrorSelect(select("ai-output-select"), select("home-output-select")),
    mirrorSelect(select("mic-select"), select("setup-mic-select")),
  ];

  for (const row of document.querySelectorAll<HTMLElement>("#home-loaded [data-reveal]")) {
    row.addEventListener("click", () => reveal(row.dataset.reveal ?? ""));
  }
  $("home-notice-open").addEventListener("click", () => reveal("model-select"));

  const wordForm = $<HTMLFormElement>("home-word-form");
  const wordInput = $<HTMLInputElement>("home-word-input");
  wordForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const word = wordInput.value.trim();
    if (!word) return;
    const added = await host.addWords(word);
    $("home-word-status").textContent = added > 0 ? t("home_word_added").replace("{word}", word) : t("home_word_known");
    wordInput.value = "";
    wordInput.focus();
  });

  // The setup.
  $("setup-mic-change").addEventListener("click", () => {
    $("setup-mic-select").classList.remove("hidden");
    $("setup-mic-change").classList.add("hidden");
    $("setup-mic-select").focus();
  });
  // Another microphone: the meter follows.
  $("setup-mic-select").addEventListener("change", async () => {
    await meter(false);
    renderSetup();
  });
  $("setup-model-download").addEventListener("click", () => {
    if (currentSpeech()?.engine === "cloud") return reveal("groq-key");
    // The Settings dropdown downloads a model that is missing and saves the choice.
    const model = select("model-select");
    model.value = suggestion.model;
    model.dispatchEvent(new Event("change", { bubbles: true }));
  });
  $("setup-ai-download").addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("setup-ai-download");
    button.disabled = true;
    await host.setUpAi(suggestion.ai);
    button.disabled = false;
    renderHome();
  });
  $("setup-ai-dismiss").addEventListener("click", () => {
    prefs.aiCardDismissed = true;
    rememberPrefs();
    renderSetup();
  });

  listen<DownloadProgress>("download-progress", (e) => progress("setup-model", e.payload));
  listen<DownloadProgress>("ai-download-progress", (e) => progress("setup-ai", e.payload));
  listen<number>("mic-level", (e) => {
    const percent = Math.round(Math.max(0, Math.min(1, e.payload)) * 100);
    $("setup-level-fill").style.width = `${percent}%`;
    $("setup-level").setAttribute("aria-valuenow", String(percent));
  });
  // The microphone is open only while the setup is on screen.
  document.addEventListener("visibilitychange", renderSetup);

  // The models to suggest for this PC.
  invoke<Gpu[]>("detect_gpus")
    .then((found) => {
      gpus = found;
      suggestion = recommend(gpus);
      renderSetup();
    })
    .catch((e) => console.error("detect_gpus failed:", e));

  new ResizeObserver(layout).observe($("content"));
  layout();
  onStatus(renderHome);
  renderHome();
}
