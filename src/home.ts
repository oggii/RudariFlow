// Home, the dictation page. The daily view: the hotkeys (set in place), the
// quick switches (the same settings as in Settings, mirrored), what is
// loaded, "add a word", and the recent dictations (src/history.ts). Before
// the setup is done: the first-run steps instead.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "./i18n";
import { activity } from "./activity";
import { mirrorHint, mirrorSelect, mirrorSwitch } from "./mirror";
import { prefs, reveal, updatePrefs } from "./shell";
import { currentSpeech, currentStatus, onStatus } from "./status-view";
import { homeTitle, statusText, type Status } from "./status.ts";
import { recommend, setup, sizeText, type Gpu, type Recommendation, type Setup } from "./setup.ts";

export interface HomeHost {
  /** "push-to-talk" or "toggle". */
  recordingMode(): string;
  /** The dictation hotkey as it is shown ("Ctrl+Shift+Space"). */
  dictationKey(): string;
  /** Microphones Windows lists; null until they were listed. */
  microphones(): number | null;
  /** List the microphones again: one may have been plugged in. */
  findMicrophones(): Promise<void>;
  /** The AI model in use and its state line, as Settings shows them: the
   *  text, its tone, what kind of state it is ("ready", "off", "missing",
   *  "loading", "failed" …) and, after a failed start, the way to try again. */
  ai(): { name: string; state: string; tone: string; kind: string; downloaded: boolean; retry: (() => void) | null };
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
/** The models to suggest for this PC; null until its graphics cards are known. */
let suggestion: Recommendation | null = null;
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

function renderHeader(now: Status, s: Setup) {
  const { key, n } = statusText(now);
  title.removeAttribute("data-i18n");
  // The welcome is for a PC that has no speech model yet. A microphone that
  // was unplugged later, or a cloud key that is gone, is "Setup needed".
  const welcome = s.needed && !s.model && currentSpeech()?.engine !== "cloud";
  const heading = t(welcome ? "setup_title" : homeTitle(now));
  if (title.textContent !== heading) title.textContent = heading;
  pill.dataset.tone = now.tone;
  pillText.textContent = t(key).replace("{n}", n);
  // The steps say how to dictate (step 3).
  how.classList.toggle("hidden", s.needed);
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
    speechLine.textContent = speech.cloudKey ? t("engine_cloud") : `${t("engine_cloud")} · ${t("home_key_missing")}`;
    speechLine.dataset.tone = speech.cloudKey ? "" : "warn";
  } else {
    const state: Record<string, string> = {
      loaded: speech.device,
      loading: t("home_speech_loading"),
      failed: t("home_speech_failed"),
      unloaded: speech.downloaded ? t("home_speech_unloaded") : t("home_speech_missing"),
    };
    // The name alone: the dropdown's size and note ("(~870 MB) …") belong to the choice, not to this line.
    speechLine.textContent = `${speechModelName(speech.model).replace(/\s*\(.*$/, "")} · ${state[speech.load]}`;
    // A value is plain text. Only what is missing or failed is tinted, in all three lines.
    speechLine.dataset.tone = speech.load === "failed" || !speech.downloaded ? "warn" : "";
  }
  const ai = host.ai();
  const aiLine = $("home-loaded-ai");
  // A model that is not downloaded says so, as the speech model's line does.
  aiLine.textContent = ai.name ? `${ai.name} · ${ai.kind === "missing" ? t("home_speech_missing") : ai.state}` : "";
  aiLine.dataset.tone = ai.kind === "missing" ? "warn" : ai.tone === "ok" ? "" : ai.tone;
  const mic = document.querySelector<HTMLSelectElement>("#mic-select")?.selectedOptions[0];
  const micLine = $("home-loaded-mic");
  const noMic = currentStatus().missing.includes("microphone");
  micLine.textContent = noMic ? t("home_mic_missing") : (mic?.textContent ?? "");
  micLine.dataset.tone = noMic || mic?.dataset.missing ? "warn" : "";
  // The AI's state under the quick switch, only when there is something to
  // say: it loads, or it is not available. "Ready" and "Off" are the switch
  // itself and the line above. Empty when hidden: it describes the switch.
  const line = $("home-ai-status");
  const said = ai.kind === "ready" || ai.kind === "off" ? "" : ai.state;
  line.textContent = said;
  line.dataset.tone = ai.tone;
  line.classList.toggle("hidden", said === "");
  $("home-ai-retry").classList.toggle("hidden", ai.retry === null);
}

// ── First run ─────────────────────────────────────────

/** The speech model's download ran when the steps were last drawn. */
let wasFetching = false;
/** The speech model's download ended without the model. */
let modelFailed = false;
/** The AI model's download ran when the card was last drawn. */
let aiWasBusy = false;
/** The AI model's download, started from the card, ended without the model. */
let aiFailed = false;
/** What the downloads last reported; null before their first report. */
let modelProgress: DownloadProgress | null = null;
let aiProgress: DownloadProgress | null = null;
/** "Change" was pressed: the list of microphones shows in its place. */
let micPicking = false;

function currentSetup(): Setup {
  return setup({ speech: currentSpeech(), microphones: host.microphones(), aiDownloaded: host.ai().downloaded, aiDismissed: prefs.aiCardDismissed });
}

/** A speech model as a step names it: "Large v3 Turbo q8 (~870 MB)" with its
 *  size, "Large v3 Turbo q8" without. The dropdown's note after it is left out. */
function speechModel(id: string, size: boolean): string {
  const label = speechModelName(id);
  return whole((size ? (/^[^(]*(\([^)]*\))?/.exec(label)?.[0] ?? label) : label.replace(/\s*\(.*$/, "")).trim());
}

/** A name that stays on one line: a line breaks before it, not inside it. */
const whole = (name: string) => name.replace(/ /g, "\u00a0");

/** A step's line. Written only when it changes: a line that is read out
 *  (role="status") is not said again with every percent of a download. */
function say(el: HTMLElement, text: string, tone = "") {
  if (el.textContent !== text) el.textContent = text;
  el.dataset.tone = tone;
}

/** A step's mark: done, to do, or something is in its way. A screen reader
 *  hears "Done" or "To do" where the eye sees the tick or the number. */
function step(id: string, n: string, state: "done" | "todo" | "problem") {
  const el = $(id);
  el.dataset.state = state;
  el.querySelector(".setup-num")!.textContent = state === "done" ? "✓" : n;
  say(el.querySelector<HTMLElement>(".setup-state")!, t(state === "done" ? "setup_done" : "setup_todo"));
}

/** A step's button: its words ("" hides it), whether it is the page's one
 *  primary button, and whether it rests because its work runs. A resting
 *  button stays where it is and keeps the keyboard focus. */
function act(button: HTMLElement, label: string, primary: boolean, resting = false) {
  button.classList.toggle("hidden", label === "");
  if (label !== "" && button.textContent !== label) button.textContent = label;
  button.classList.toggle("btn-primary", primary);
  button.classList.toggle("btn-secondary", !primary);
  if (resting) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
}

const resting = (button: HTMLElement) => button.getAttribute("aria-disabled") === "true";

/** A download's bar with its numbers, always percent and size; null hides it. */
function progress(prefix: string, p: DownloadProgress | null) {
  $(`${prefix}-progress`).classList.toggle("hidden", p === null);
  if (!p) return;
  const percent = Math.max(0, Math.min(100, Math.round(p.percent)));
  // Before the first report, and from a server that does not say how much is to come, there is no size to show.
  const numbers =
    p.total > 0
      ? t("progress_numbers").replace("{percent}", String(percent)).replace("{done}", sizeText(p.downloaded)).replace("{total}", sizeText(p.total))
      : p.downloaded > 0
        ? sizeText(p.downloaded)
        : `${percent} %`;
  $(`${prefix}-fill`).style.width = `${percent}%`;
  $(`${prefix}-numbers`).textContent = numbers;
  const bar = $(`${prefix}-bar`);
  bar.setAttribute("aria-valuenow", String(percent));
  bar.setAttribute("aria-valuetext", numbers);
}

function renderSetup() {
  const s = currentSetup();
  const speech = currentSpeech();
  const select = $<HTMLSelectElement>("mic-select");
  // The box the keyboard focus is in; it may be about to go.
  const focused = [setupBox, aiCard].find((box) => box.contains(document.activeElement));

  // The speech model's download. It ends in the status only once the model
  // is known to be there (src/main.ts): an end without the model has failed.
  const fetching = activity().speech !== null;
  if (fetching && !wasFetching) modelProgress = null;
  if (fetching || s.model) modelFailed = false;
  else if (wasFetching) modelFailed = true;
  wasFetching = fetching;

  // The microphones changed (one was plugged in): a new try for the meter.
  const mics = host.microphones();
  if (mics !== micCount) {
    micCount = mics;
    meterFailed = false;
  }

  setupBox.classList.toggle("hidden", !s.needed);
  daily.classList.toggle("hidden", s.needed);
  syncMeter(s);

  // Step 2's button is the page's one primary button while there is something to press; then step 1's.
  const modelButton = $("setup-model-download");
  const micRetry = $("setup-mic-retry");
  if (s.needed) {
    // 1. The microphone: the device with its level, or what is in the way.
    const noMic = !s.microphone;
    const unheard = !noMic && meterFailed;
    step("setup-mic", "1", noMic || unheard ? "problem" : "done");
    const option = select.selectedOptions[0];
    // The saved microphone is unplugged: the level is the one of the device that opened in its place.
    const device = option?.dataset.missing && meterDevice ? meterDevice : (option?.textContent ?? "");
    say($("setup-mic-text"), noMic ? t("setup_mic_missing") : unheard ? t("setup_mic_failed") : device, noMic || unheard ? "warn" : "");
    $("setup-meter").classList.toggle("hidden", noMic || unheard);
    const picking = micPicking && !noMic;
    // The list says which microphone it is: the line above it would say it twice.
    $("setup-mic-text").classList.toggle("hidden", picking && !unheard);
    $("setup-mic-select").classList.toggle("hidden", !picking);
    $("setup-mic-change").classList.toggle("hidden", noMic || picking);

    // 2. The speech model: the one for this PC's graphics card, its download, or the cloud engine's key.
    let line: string;
    let tone = "";
    let label = "";
    let pending = false;
    let failed = false;
    if (speech?.engine === "cloud") {
      line = t(s.model ? "setup_model_cloud" : "setup_model_cloud_key");
      if (!s.model) label = t("home_open_models");
    } else if (s.model) {
      line = t("setup_model_done").replace("{model}", () => speechModel(speech?.model ?? "", false));
    } else if (modelFailed) {
      line = t("setup_download_failed");
      tone = "warn";
      label = t("retry");
      failed = true;
    } else if (!suggestion) {
      line = t("setup_model_checking");
    } else {
      // A download started in Settings may be another model's: the step names the one that comes.
      const coming = fetching ? $<HTMLSelectElement>("model-select").value : suggestion.model;
      const name = speechModel(coming, true);
      if (coming !== suggestion.model) line = name;
      else if (suggestion.gpu) line = t("setup_model_for").replace("{gpu}", () => suggestion!.gpu).replace("{model}", () => name);
      else line = t("setup_model_cpu").replace("{model}", () => name);
      label = fetching ? t("setup_downloading") : t("download");
      pending = fetching;
    }
    step("setup-model", "2", s.model ? "done" : failed ? "problem" : "todo");
    say($("setup-model-text"), line, tone);
    const pressModel = label !== "" && !pending;
    act(modelButton, label, pressModel, pending);
    act(micRetry, noMic ? t("setup_mic_check") : unheard ? t("retry") : "", !pressModel);
    progress("setup-model", fetching ? (modelProgress ?? { downloaded: 0, total: 0, percent: 0 }) : null);

    // 3. The dictation key: it has one from the start.
    step("setup-key", "3", "done");
    say($("setup-key-text"), t(host.recordingMode() === "toggle" ? "setup_key_toggle" : "setup_key_hold"));
  }

  // The optional card: once the model to suggest and its size are known.
  const ai = suggestion ? host.aiModel(suggestion.ai) : null;
  aiCard.classList.toggle("hidden", !s.aiCard || !ai);
  if (s.aiCard && ai) {
    const busy = host.ai().kind === "downloading";
    if (busy && !aiWasBusy) aiProgress = null;
    if (busy) aiFailed = false;
    aiWasBusy = busy;
    const text = t("setup_ai_text").replace("{model}", () => whole(ai.name)).replace("{size}", whole(sizeText(ai.bytes)));
    say($("setup-ai-text"), aiFailed ? t("setup_download_failed") : text, aiFailed ? "warn" : "");
    act($("setup-ai-download"), busy ? t("setup_downloading") : aiFailed ? t("retry") : t("download"), false, busy);
    progress("setup-ai", busy ? (aiProgress ?? { downloaded: 0, total: 0, percent: 0 }) : null);
  }

  // A box that goes takes the focus with it (its button was the last thing
  // pressed): the heading has it then, not nothing.
  if (focused?.classList.contains("hidden")) title.focus();
}

// ── The microphone's level (step 1) ───────────────────
//
// The backend holds the microphone open while its meter runs. It runs only
// while the steps are on screen in a window that shows: not on another page,
// not in a window that is hidden, minimized or closed to the tray, and not
// once the setup is done.

/** The backend sends about 30 levels a second. Without one for this long its
 *  meter is over: it stops by itself after two minutes, when the window is
 *  closed to the tray and when the microphone is unplugged, and says nothing. */
const SILENT_MS = 1500;
/** A meter that fell silent is started again at most this often. */
const REVIVE_MS = 5000;

/** The page asked for the meter and has not asked to stop it. */
let metering = false;
/** Numbers the calls to the backend: only the latest one's answer says how things are. */
let meterCall = 0;
/** The latest start has not answered yet (a device can take seconds to open). */
let opening = false;
/** The device the meter opened; "" until it answered. */
let meterDevice = "";
/** The microphone did not open. No new try until the user asks for one or the microphones change. */
let meterFailed = false;
/** The microphones Windows listed when the steps were last drawn. */
let micCount: number | null = null;
/** When the last level arrived, and when the meter was last started. */
let heardAt = 0;
let startedAt = 0;
/** The window is on screen, as far as the page knows (`windowShows`). */
let windowUp = true;
let watchTimer: number | undefined;
let watchBusy = false;
let ticks = 0;

function showLevel(level: number) {
  const percent = Math.round(Math.max(0, Math.min(1, level)) * 100);
  $("setup-level-fill").style.width = `${percent}%`;
  $("setup-level").setAttribute("aria-valuenow", String(percent));
}

/** Start or stop the backend's meter. `again`: start it although the page
 *  believes it runs (another microphone was chosen, or it fell silent). */
async function meter(on: boolean, again = false) {
  if (on === metering && !again) return;
  metering = on;
  const call = ++meterCall;
  opening = on;
  if (on) {
    startedAt = heardAt = performance.now();
  } else {
    meterDevice = "";
    showLevel(0);
  }
  try {
    if (!on) {
      await invoke("mic_meter_stop");
      return;
    }
    const device = await invoke<string>("mic_meter_start");
    // An older start's answer says nothing about now: a stop or a newer start came after it.
    if (call !== meterCall) return;
    opening = false;
    meterDevice = device;
    heardAt = performance.now();
  } catch (e) {
    // The same for an older call's error. A start that was overtaken answers
    // "stopped" late: taken as the state of things, it would mark a meter as
    // off that a newer start has running, and the page would never stop it.
    if (call !== meterCall) return;
    opening = false;
    if (!on) {
      console.error("mic_meter_stop failed:", e);
      return;
    }
    metering = false;
    if (e === "stopped") {
      // The backend stopped it while the device opened: the window was
      // closed to the tray. No error; look whether the window still shows
      // before the steps ask for the meter again.
      windowUp = await windowShows();
    } else {
      meterFailed = true;
      console.error("the microphone meter did not start:", e);
    }
  }
  renderSetup();
}

/** The window is on screen: not hidden to the tray, not minimized. The
 *  window is asked itself: the webview goes on reporting "visible" in a
 *  window that was hidden or minimized. */
async function windowShows(): Promise<boolean> {
  if (document.hidden) return false;
  try {
    const win = getCurrentWindow();
    return (await win.isVisible()) && !(await win.isMinimized());
  } catch (e) {
    console.error("the window's state:", e);
    return true;
  }
}

/** Ask whether the window still shows; true when that changed (the steps were drawn again). */
async function lookAtWindow(): Promise<boolean> {
  const up = await windowShows();
  if (up === windowUp) return false;
  windowUp = up;
  renderSetup();
  return true;
}

/** The window is in front again (it has the focus, the pointer is on it). */
function windowIsBack() {
  if (windowUp) return;
  windowUp = true;
  renderSetup();
}

/** The meter and its watch follow what is on screen. */
function syncMeter(s: Setup) {
  const onScreen = s.needed && $("section-home").classList.contains("active") && !document.hidden && windowUp;
  if (onScreen !== (watchTimer !== undefined)) {
    if (onScreen) {
      watchTimer = window.setInterval(() => void watch(), 1000);
    } else {
      window.clearInterval(watchTimer);
      watchTimer = undefined;
    }
  }
  void meter(onScreen && s.microphone && !meterFailed);
}

/** Once a second while the steps are on screen. */
async function watch() {
  if (watchBusy) return;
  watchBusy = true;
  try {
    ticks++;
    if (!currentSetup().microphone) {
      // "Plug one in; it shows up here": looked for while someone is at the window.
      if (ticks % 3 === 0 && document.hasFocus()) await host.findMicrophones();
      return;
    }
    if (!metering || opening) return;
    const silent = performance.now() - heardAt > SILENT_MS;
    // A window that is hidden or minimized does not tell the page. Asked when
    // the level stops (the backend closes the microphone with the window) and
    // now and then while the window is not the one in front.
    if (silent || (ticks % 2 === 0 && !document.hasFocus())) {
      if ((await lookAtWindow()) || !windowUp) return;
    }
    // Still wanted and silent: the two minutes are over, or the microphone
    // was unplugged (the next start opens Windows' default one, or says why not).
    if (silent && metering && !opening && performance.now() - startedAt > REVIVE_MS) void meter(true, true);
  } catch (e) {
    console.error("the setup's watch:", e);
  } finally {
    watchBusy = false;
  }
}

// ── Layout ────────────────────────────────────────────

/** Two columns from 900 px of content; in one column the recent dictations
 *  come right after the quick switches. The card is moved, so the Tab order
 *  is the order on the page in both. From 1600 px the controls are two
 *  columns themselves (styles/home.css), so a large window is filled.
 *
 *  The width is the one with the scrollbar's room in it. `clientWidth`
 *  loses that room when the page gets a scrollbar: a layout that decides on
 *  it and is higher in the wider form brings its own scrollbar, loses the
 *  width, steps back, loses the scrollbar, and so on in every frame. */
function layout() {
  const width = $("content").offsetWidth;
  const wide = width >= 900;
  daily.classList.toggle("wider", width >= 1600);
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
  renderHeader(now, currentSetup());
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
    // Why "Write in" translates nothing at the moment, as Settings says it under the same control.
    mirrorHint([$("ai-output-skip"), $("ai-output-warn")], $("home-output-hint")),
  ];
  $("home-ai-retry").addEventListener("click", () => host.ai().retry?.());

  for (const row of document.querySelectorAll<HTMLElement>("#home-loaded [data-reveal]")) {
    row.addEventListener("click", () => {
      const id = row.dataset.reveal ?? "";
      // With the cloud engine there is no speech model to choose (its row is hidden): the key is the setting.
      reveal(id === "model-select" && currentSpeech()?.engine === "cloud" ? "groq-key" : id);
    });
  }
  $("home-notice-open").addEventListener("click", () => reveal("model-select"));

  const wordForm = $<HTMLFormElement>("home-word-form");
  const wordInput = $<HTMLInputElement>("home-word-input");
  wordForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const word = wordInput.value.trim();
    if (!word) return;
    const added = await host.addWords(word);
    $("home-word-status").textContent = added > 0 ? t("home_word_added").replace("{word}", () => word) : t("home_word_known");
    wordInput.value = "";
    wordInput.focus();
  });

  // The setup.
  $("setup-mic-change").addEventListener("click", () => {
    micPicking = true;
    renderSetup();
    // The list stays once it is open: taking it away when it is left would
    // move the page under the pointer that is about to press the next button.
    $("setup-mic-select").focus();
  });
  // Another microphone: the meter opens it. This runs after the Settings
  // select's own listener (src/main.ts), which has sent the choice to be
  // saved by now; the backend opens the microphone that is saved.
  select("mic-select").addEventListener("change", () => {
    meterFailed = false;
    if (metering) void meter(true, true);
    else renderSetup();
  });
  $("setup-mic-retry").addEventListener("click", async () => {
    meterFailed = false;
    // No microphone was found: look again. One that did not open: the steps start the meter again.
    if (!currentSetup().microphone) await host.findMicrophones().catch((e) => console.error("listing the microphones failed:", e));
    renderSetup();
  });
  $("setup-model-download").addEventListener("click", () => {
    if (resting($("setup-model-download"))) return;
    if (currentSpeech()?.engine === "cloud") return reveal("groq-key");
    if (!suggestion) return;
    // The Settings dropdown downloads a model that is missing and saves the choice.
    const model = select("model-select");
    model.value = suggestion.model;
    model.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // "Change" beside the key starts the key's own capture.
  $("setup-key-change").addEventListener("click", () => $("setup-hotkey-btn").click());
  $("setup-ai-download").addEventListener("click", async () => {
    if (resting($("setup-ai-download")) || !suggestion) return;
    aiFailed = false;
    const on = await host.setUpAi(suggestion.ai);
    // Without the model the download did not finish (with it, AI cleanup is on, or cannot run on this PC).
    aiFailed = !on && !host.ai().downloaded;
    renderHome();
  });
  $("setup-ai-dismiss").addEventListener("click", () => {
    updatePrefs((p) => (p.aiCardDismissed = true));
    renderSetup();
  });

  listen<DownloadProgress>("download-progress", (e) => {
    // Only of a download this window started and that still runs.
    if (activity().speech === null) return;
    modelProgress = e.payload;
    if (!setupBox.classList.contains("hidden")) progress("setup-model", modelProgress);
  });
  listen<DownloadProgress>("ai-download-progress", (e) => {
    if (host.ai().kind !== "downloading") return;
    aiProgress = e.payload;
    if (!aiCard.classList.contains("hidden")) progress("setup-ai", aiProgress);
  });
  listen<number>("mic-level", (e) => {
    // A level that arrives after the stop is not shown.
    if (!metering) return;
    heardAt = performance.now();
    showLevel(e.payload);
  });
  // The microphone is open only while the steps are on screen in a window that shows.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) windowUp = true;
    renderSetup();
  });
  // A window that is closed to the tray or minimized loses the focus, and
  // that is all the page hears of it: ask the window.
  window.addEventListener("blur", () => {
    if (watchTimer !== undefined) void lookAtWindow();
  });
  window.addEventListener("focus", windowIsBack);
  window.addEventListener("pointerover", windowIsBack);
  // The page goes (the app quits, the window is loaded again): the microphone closes.
  window.addEventListener("pagehide", () => void meter(false));

  // The models to suggest for this PC.
  invoke<Gpu[]>("detect_gpus")
    .then((found) => (suggestion = recommend(found)))
    .catch((e) => {
      console.error("detect_gpus failed:", e);
      // Without the list: what fits every PC.
      suggestion = recommend([]);
    })
    .then(renderSetup);

  new ResizeObserver(layout).observe($("content"));
  layout();
  onStatus(renderHome);
  renderHome();
}
