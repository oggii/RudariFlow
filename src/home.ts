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
import { type Status } from "./status.ts";
import { header, meterStep, modelStep, recommend, setup, sizeText, METER_SILENT_MS, type Gpu, type MeterNow, type Recommendation, type Setup } from "./setup.ts";

export interface HomeHost {
  /** "push-to-talk" or "toggle". */
  recordingMode(): string;
  /** The dictation hotkey as it is shown ("Ctrl+Shift+Space"). */
  dictationKey(): string;
  /** Microphones Windows lists; null until they were listed. */
  microphones(): number | null;
  /** List the microphones again: one may have been plugged in. */
  findMicrophones(): Promise<void>;
  /** The microphone the backend has saved ("default": Windows' own input). It
   *  changes only once a save was answered: the level opens what is saved. */
  microphone(): string;
  /** The AI model in use and its state line, as Settings shows them: the
   *  text, its tone, what kind of state it is ("ready", "off", "missing",
   *  "loading", "failed" …) and, after a failed start, the way to try again. */
  ai(): { name: string; state: string; tone: string; kind: string; downloaded: boolean; retry: (() => void) | null };
  /** An AI model's name and size (the setup suggests one for this PC). */
  aiModel(id: string): { name: string; bytes: number } | null;
  /** Add words to the dictionary; how many were new. */
  addWords(text: string): Promise<number>;
  /** Choose this speech model, download it if it is missing, and save the choice. True when it is there and saved. */
  setUpSpeech(id: string): Promise<boolean>;
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
  // What the heading and the pill say: src/setup.ts (the two never say the same thing).
  const said = header(now, s, currentSpeech()?.engine === "cloud");
  title.removeAttribute("data-i18n");
  const heading = t(said.title);
  if (title.textContent !== heading) title.textContent = heading;
  pill.dataset.tone = now.tone;
  const words = t(said.pill).replace("{n}", said.n);
  if (pillText.textContent !== words) pillText.textContent = words;
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
/** Download in step 2 was pressed and what it started has not ended. The
 *  button rests from the click itself, not only once the download shows in
 *  the status: a second press in between would start a second download. */
let modelStarting = false;
/** The speech model a download was last seen for: the step names it when
 *  the download fails, and Retry fetches it. */
let modelTried: string | null = null;
/** The card's Download was pressed and its work (the choice, the download,
 *  AI cleanup on) has not ended. */
let aiSetting = false;
/** The AI model's download ran when the card was last drawn. */
let aiWasBusy = false;
/** The AI model's download, started from the card, ended without the model. */
let aiFailed = false;
/** What the downloads last reported; null before their first report. */
let modelProgress: DownloadProgress | null = null;
let aiProgress: DownloadProgress | null = null;
/** "Change" was pressed: the list of microphones shows in its place. */
let micPicking = false;
/** A model of the suggestion was asked for: what is learned about the
 *  graphics cards after that changes nothing. */
let suggestionUsed = false;
/** The suggestion was made without knowing the graphics cards (no answer in time, or none at all). */
let suggestionBlind = false;
/** How long the steps wait for the graphics cards before they suggest what fits every PC. */
const GPU_WAIT_MS = 5000;

function currentSetup(): Setup {
  return setup({ speech: currentSpeech(), microphones: host.microphones(), aiDownloaded: host.ai().downloaded, aiDismissed: prefs.aiCardDismissed });
}

/** A speech model as a step names it: "Large v3 Turbo q8 (~870 MB)" with its
 *  size, "Large v3 Turbo q8" without. The dropdown's note after it is left out. */
function modelNamed(id: string, size: boolean): string {
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
 *  hears "Done", "To do" or "Needs attention" where the eye sees the tick,
 *  the number or its colour. */
function step(id: string, n: string, state: "done" | "todo" | "problem") {
  const el = $(id);
  el.dataset.state = state;
  el.querySelector(".setup-num")!.textContent = state === "done" ? "✓" : n;
  say(el.querySelector<HTMLElement>(".setup-state")!, state === "done" ? t("setup_done") : state === "problem" ? t("setup_problem") : t("setup_todo"));
}

/** A step's button: its words ("" hides it), whether it is the page's one
 *  primary button, whether it rests because its work runs, and its name
 *  where the words alone do not say what it acts on (two buttons read
 *  "Download"). A resting button stays where it is and keeps the keyboard
 *  focus. */
function act(button: HTMLElement, label: string, primary: boolean, resting = false, name = "") {
  button.classList.toggle("hidden", label === "");
  if (label !== "" && button.textContent !== label) button.textContent = label;
  button.classList.toggle("btn-primary", primary);
  button.classList.toggle("btn-secondary", !primary);
  if (resting) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
  if (name && label !== "") button.setAttribute("aria-label", name);
  else button.removeAttribute("aria-label");
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
  // The control the keyboard focus is on; it may be about to go.
  const at = document.activeElement;
  const focused = at instanceof HTMLElement && (setupBox.contains(at) || aiCard.contains(at)) ? at : null;

  // Step 2's state, with the failure of its download worked out (src/setup.ts).
  const fetching = activity().speech !== null;
  if (fetching && !wasFetching) modelProgress = null;
  const model = modelStep({ speech, fetching, wasFetching, wasFailed: modelFailed, starting: modelStarting, suggested: suggestion !== null });
  modelFailed = model.failed;
  wasFetching = fetching;
  // A download started in Settings may be another model's: the step names the one that comes.
  if (fetching) modelTried = $<HTMLSelectElement>("model-select").value;

  // The microphones changed (one was plugged in), or another one is saved: a new try for the meter.
  const mics = host.microphones();
  const saved = host.microphone();
  if (mics !== micCount || saved !== micSaved) {
    micCount = mics;
    micSaved = saved;
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
    // The level is off while nobody uses the window (syncMeter): said in
    // words, in the bar's place, not shown as a bar that does not move.
    const atRest = !noMic && !unheard && !metering;
    step("setup-mic", "1", noMic || unheard ? "problem" : "done");
    const option = select.selectedOptions[0];
    // The saved microphone is unplugged: the level is the one of the device that opened in its place.
    const device = option?.dataset.missing && meterDevice ? meterDevice : (option?.textContent ?? "");
    say($("setup-mic-text"), noMic ? t("setup_mic_missing") : unheard ? t("setup_mic_failed") : device, noMic || unheard ? "warn" : "");
    $("setup-meter").classList.toggle("hidden", noMic || unheard);
    $("setup-level").classList.toggle("hidden", atRest);
    say($("setup-mic-hint"), atRest ? t("setup_mic_rest") : t("setup_mic_hint"));
    const picking = micPicking && !noMic;
    // The list says which microphone it is: the line above it would say it twice.
    $("setup-mic-text").classList.toggle("hidden", picking && !unheard);
    $("setup-mic-select").classList.toggle("hidden", !picking);
    $("setup-mic-change").classList.toggle("hidden", noMic || picking);

    // 2. The speech model: the one for this PC's graphics card, its download, or the cloud engine's key.
    let line = "";
    let tone = "";
    let label = "";
    let name = "";
    const pending = model.state === "starting" || model.state === "downloading";
    switch (model.state) {
      case "key":
        line = t("setup_model_cloud_key");
        label = t("home_open_models");
        break;
      case "cloud":
        line = t("setup_model_cloud");
        break;
      case "done":
        line = t("setup_model_done").replace("{model}", () => modelNamed(speech?.model ?? "", false));
        break;
      case "loading":
        line = `${modelNamed(speech?.model ?? "", false)} · ${t("home_speech_loading")}`;
        break;
      case "failed":
        // Which model, and how much there is to fetch, stays said beside Retry.
        line = t("setup_download_failed").replace("{model}", () => modelNamed(modelTried ?? suggestion?.model ?? "", true));
        tone = "warn";
        label = t("retry");
        name = t("setup_model_retry");
        break;
      case "checking":
        line = t("setup_model_checking");
        break;
      default: {
        // To do, or on its way: the model for this PC, or the one a download started in Settings brings.
        const coming = (pending ? modelTried : null) ?? suggestion?.model ?? "";
        const named = modelNamed(coming, true);
        if (!suggestion || coming !== suggestion.model) line = named;
        else if (suggestion.gpu) line = t("setup_model_for").replace("{gpu}", () => suggestion!.gpu).replace("{model}", () => named);
        else line = (suggestionBlind ? t("setup_model_any") : t("setup_model_cpu")).replace("{model}", () => named);
        label = pending ? t("setup_downloading") : t("download");
        name = pending ? t("setup_model_fetching") : t("setup_model_get");
      }
    }
    step("setup-model", "2", s.model ? "done" : model.state === "failed" ? "problem" : "todo");
    say($("setup-model-text"), line, tone);
    const pressModel = label !== "" && !pending;
    act(modelButton, label, pressModel, pending, name);
    act(micRetry, noMic ? t("setup_mic_check") : unheard ? t("retry") : "", !pressModel, false, unheard ? t("setup_mic_retry") : "");
    // The bar is there from the click on, so the step has one height from Download to the end.
    progress("setup-model", pending ? (modelProgress ?? { downloaded: 0, total: 0, percent: 0 }) : null);

    // 3. The dictation key: it has one from the start.
    step("setup-key", "3", "done");
    say($("setup-key-text"), t(host.recordingMode() === "toggle" ? "setup_key_toggle" : "setup_key_hold"));
  }

  // The optional card: once the model to suggest and its size are known.
  const ai = suggestion ? host.aiModel(suggestion.ai) : null;
  aiCard.classList.toggle("hidden", !s.aiCard || !ai);
  if (s.aiCard && ai) {
    // The card's own work, or a download of the model that was started in Settings.
    const busy = aiSetting || host.ai().kind === "downloading";
    if (busy && !aiWasBusy) aiProgress = null;
    if (busy) aiFailed = false;
    aiWasBusy = busy;
    const fill = (text: string) => text.replace("{model}", () => whole(ai.name)).replace("{size}", whole(sizeText(ai.bytes)));
    // What the card started ends with AI cleanup on (setUpAi), also behind a
    // card that was hidden meanwhile: the card says so. A download started
    // in Settings turns nothing on.
    const text = aiFailed ? t("setup_download_failed").replace("{model}", () => whole(`${ai.name} (${sizeText(ai.bytes)})`)) : fill(aiSetting ? t("setup_ai_coming") : t("setup_ai_text"));
    say($("setup-ai-text"), text, aiFailed ? "warn" : "");
    const name = busy ? t("setup_ai_fetching") : aiFailed ? t("setup_ai_retry") : t("setup_ai_get");
    act($("setup-ai-download"), busy ? t("setup_downloading") : aiFailed ? t("retry") : t("download"), false, busy, name);
    // "Not now" would not be true of a download that goes on: then the card can be hidden.
    const dismiss = aiSetting ? t("setup_ai_hide") : t("setup_ai_dismiss");
    if ($("setup-ai-dismiss").textContent !== dismiss) $("setup-ai-dismiss").textContent = dismiss;
    progress("setup-ai", busy ? (aiProgress ?? { downloaded: 0, total: 0, percent: 0 }) : null);
  }

  // A control that goes takes the keyboard focus with it (it was the last
  // thing pressed). The focus moves to what stands in its place: the next
  // control of its step ("Check again" found a microphone: "Change"), then
  // the first one of its box; with the whole box gone, to the heading.
  const gone = (el: Element) => el.closest(".hidden") !== null;
  if (focused && gone(focused) && $("section-home").classList.contains("active")) {
    const box = focused.closest<HTMLElement>(".home-setup");
    const controls = (root: Element | null) => [...(root?.querySelectorAll<HTMLElement>("button, select") ?? [])].filter((el) => !gone(el));
    const next = box && !gone(box) ? (controls(focused.closest(".setup-step"))[0] ?? controls(box)[0]) : undefined;
    (next ?? title).focus();
  }
}

// ── The microphone's level (step 1) ───────────────────
//
// The backend holds the microphone open while its meter runs. The page
// starts it, and starts it again when it fell silent, only while the steps
// are on screen in a window that shows AND the user touched that window
// within the last minute (src/setup.ts, meterMay): a window that another
// app covers, a locked PC and a PC that slept all still "show". Without a
// touch the level rests, the step says so, and the next touch brings it
// back. Not on another page, not in a window that is hidden, minimized or
// closed to the tray, and not once the setup is done.
//
// The longest the microphone stays open with nobody at the window: a start
// is still allowed at the end of the minute after the last touch, and that
// start runs to the backend's own limit of two minutes: 60 s + 120 s.

/** The page asked for the meter and has not asked to stop it. */
let metering = false;
/** Numbers the calls to the backend: only the latest one's answer says how things are. */
let meterCall = 0;
/** The latest start has not answered yet (a device can take seconds to open). */
let opening = false;
/** The device the meter opened; "" until it answered. */
let meterDevice = "";
/** The saved microphone the meter was last started for. */
let meterFor = "";
/** The microphone did not open. No new try until the user asks for one, another one is saved or the microphones change. */
let meterFailed = false;
/** The microphones Windows listed, and the one that was saved, when the steps were last drawn. */
let micCount: number | null = null;
let micSaved = "";
/** When the last level arrived, and when the meter was last started. */
let heardAt = 0;
let startedAt = 0;
/** When the user last touched this window (pointer, key, focus); null: never. */
let usedAt: number | null = null;
/** The window is on screen: only ever what the window itself last answered
 *  (`windowShows`), and false until it was asked. A window that starts
 *  hidden (autostart, "--start-minimized") opens no microphone. */
let windowUp = false;
/** Numbers the questions to the window: only the latest one's answer counts. */
let looks = 0;
/** A touch waits for the window's answer. */
let looking = false;
let watchTimer: number | undefined;
let watchBusy = false;
let ticks = 0;

function showLevel(level: number) {
  const percent = Math.round(Math.max(0, Math.min(1, level)) * 100);
  $("setup-level-fill").style.width = `${percent}%`;
  $("setup-level").setAttribute("aria-valuenow", String(percent));
}

/** Start or stop the backend's meter. `again`: start it although the page
 *  believes it runs (another microphone was saved, or it fell silent). */
async function meter(on: boolean, again = false) {
  if (on === metering && !again) return;
  metering = on;
  const call = ++meterCall;
  opening = on;
  if (on) {
    startedAt = heardAt = performance.now();
    // The backend opens the microphone that is saved.
    meterFor = host.microphone();
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
      // closed to the tray. No error; ask whether the window still shows
      // before the steps start the meter again.
      await lookAtWindow();
    } else {
      meterFailed = true;
      console.error("the microphone meter did not start:", e);
      // It may be gone (the only one, unplugged): the step then says that.
      void host.findMicrophones().catch((err) => console.error("listing the microphones failed:", err));
    }
  }
  renderSetup();
}

/** The window is on screen: not hidden to the tray, not minimized. The
 *  window is asked itself: the webview goes on reporting "visible" in a
 *  window that was hidden or minimized. Without an answer it does not show:
 *  the microphone stays closed when in doubt. */
async function windowShows(): Promise<boolean> {
  if (document.hidden) return false;
  try {
    const win = getCurrentWindow();
    return (await win.isVisible()) && !(await win.isMinimized());
  } catch (e) {
    console.error("the window's state:", e);
    return false;
  }
}

/** Ask whether the window shows; true when that changed (the steps were drawn again). */
async function lookAtWindow(): Promise<boolean> {
  const look = ++looks;
  const up = await windowShows();
  // A newer question is out: its answer is the one that counts.
  if (look !== looks || up === windowUp) return false;
  windowUp = up;
  renderSetup();
  return true;
}

/** The meter as src/setup.ts judges it. `silent`: how long no level arrived
 *  (0 where that is not the question). */
function meterNow(s: Setup, silent = 0): MeterNow {
  const now = performance.now();
  return {
    steps: s.needed && $("section-home").classList.contains("active") && !document.hidden,
    shown: windowUp,
    microphone: s.microphone,
    failed: meterFailed,
    idle: usedAt === null ? null : now - usedAt,
    on: metering,
    opening,
    silent,
    sinceStart: now - startedAt,
  };
}

/** The user touched the window: the pointer moved or pressed on it, a key
 *  was pressed in it, it got the focus. The level may run for the next
 *  minute, and one that rests comes back now, without a click. */
function used(e: Event) {
  usedAt = performance.now();
  // Only the steps have a level.
  if (!host || setupBox.classList.contains("hidden")) return;
  if (!windowUp) {
    // Whether the window shows is the window's to say: one that starts hidden
    // can still get the focus. A pointer that moves asks one question at a
    // time: every new one would make the one before it count for nothing.
    if (looking && e.type === "pointermove") return;
    looking = true;
    void lookAtWindow().finally(() => (looking = false));
  } else if (!metering) {
    if (meterStep(meterNow(currentSetup())) === "start") renderSetup();
  } else if (!opening && performance.now() - heardAt > METER_SILENT_MS) {
    // It fell silent while nobody was here: the watch starts it again.
    void watch();
  }
}

/** The meter and its watch follow what is on screen and whether someone is there. */
function syncMeter(s: Setup) {
  const now = meterNow(s);
  const onScreen = now.steps && now.shown;
  if (onScreen !== (watchTimer !== undefined)) {
    if (onScreen) {
      watchTimer = window.setInterval(() => void watch(), 1000);
    } else {
      window.clearInterval(watchTimer);
      watchTimer = undefined;
    }
  }
  // Start and stop. A meter that fell silent is the watch's to judge: it asks the window first.
  const next = meterStep(now);
  if (next === "start") void meter(true);
  else if (next === "stop") void meter(false);
  // Another microphone was saved (src/main.ts draws Home again once the
  // save was answered): from now on the level is that one's.
  else if (metering && meterFor !== host.microphone()) void meter(true, true);
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
    // A window that is hidden or minimized does not tell the page. Asked when
    // the level stops (the backend closes the microphone with the window) and
    // now and then while the window is not the one in front.
    if (performance.now() - heardAt > METER_SILENT_MS || (ticks % 2 === 0 && !document.hasFocus())) {
      if ((await lookAtWindow()) || !windowUp) return;
    }
    if (!metering || opening) return;
    // Silent in a window that shows: the backend's two minutes are over, or
    // the microphone was unplugged (the next start opens Windows' default
    // one, or says why not). For someone who is still here it starts again;
    // with nobody here it rests until the next touch.
    const next = meterStep(meterNow(currentSetup(), performance.now() - heardAt));
    if (next === "restart") void meter(true, true);
    else if (next === "stop") {
      void meter(false);
      renderSetup();
    }
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
  // Another microphone, chosen in that list: the Settings select's own
  // listener (src/main.ts) saves it and draws Home again once the save was
  // answered; only then do the steps start the level again (syncMeter). Sent
  // with the save, the start could be the first to arrive, and the bar would
  // show the old microphone under the new name.
  $("setup-mic-retry").addEventListener("click", async () => {
    // Whatever the step said, look again first: one may have been plugged in, or the only one unplugged.
    await host.findMicrophones().catch((e) => console.error("listing the microphones failed:", e));
    // Then a new try with what is there (none before the list is known: the pointer moves while it is asked for).
    meterFailed = false;
    renderSetup();
  });
  $("setup-model-download").addEventListener("click", async () => {
    if (resting($("setup-model-download"))) return;
    if (currentSpeech()?.engine === "cloud") return reveal("groq-key");
    // After a failure the model that was tried, else the one for this PC.
    const id = (modelFailed ? modelTried : null) ?? suggestion?.model;
    if (!id) return;
    suggestionUsed = true;
    modelTried = id;
    modelProgress = null;
    // The button rests from this click on: the download shows in the status only some moments later.
    modelStarting = true;
    renderSetup();
    let there = false;
    try {
      there = await host.setUpSpeech(id);
    } catch (e) {
      console.error("the speech model's download did not start:", e);
    }
    modelStarting = false;
    // Without the model the try has failed, also one that never got as far as downloading.
    modelFailed = !there && !currentSetup().model;
    renderHome();
  });
  // "Change" beside the key starts the key's own capture.
  $("setup-key-change").addEventListener("click", () => $("setup-hotkey-btn").click());
  $("setup-ai-download").addEventListener("click", async () => {
    if (resting($("setup-ai-download")) || !suggestion) return;
    suggestionUsed = true;
    aiFailed = false;
    // Rests from this click on, as step 2's button does.
    aiSetting = true;
    renderSetup();
    let on = false;
    try {
      on = await host.setUpAi(suggestion.ai);
    } catch (e) {
      console.error("setting up AI cleanup failed:", e);
    }
    aiSetting = false;
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
  // The microphone is open only while the steps are on screen in a window
  // that shows and that someone uses. A page that is hidden closes it at
  // once; whether the window shows (again) is the window's to say.
  document.addEventListener("visibilitychange", () => {
    renderSetup();
    void lookAtWindow();
  });
  // A window that is closed to the tray or minimized loses the focus, and
  // that is all the page hears of it: ask the window.
  window.addEventListener("blur", () => {
    if (watchTimer !== undefined) void lookAtWindow();
  });
  for (const touch of ["pointermove", "pointerdown", "keydown", "focus"]) window.addEventListener(touch, used, { passive: true });
  // The page goes (the app quits, the window is loaded again): the microphone closes.
  window.addEventListener("pagehide", () => void meter(false));

  // The models to suggest for this PC. Looking at its graphics cards can
  // take long, and a driver that hangs never answers: after five seconds
  // the steps offer what fits every PC. The answer still counts when it
  // comes later, unless a model of that offer was asked for by then.
  const suggest = (found: Gpu[] | null) => {
    if (suggestion && (suggestionUsed || activity().speech !== null || host.ai().kind === "downloading")) return;
    suggestion = recommend(found ?? []);
    suggestionBlind = found === null;
    renderSetup();
  };
  const waited = window.setTimeout(() => suggest(null), GPU_WAIT_MS);
  invoke<Gpu[]>("detect_gpus")
    .then(suggest)
    .catch((e) => {
      console.error("detect_gpus failed:", e);
      // Without the list: what fits every PC.
      if (!suggestion) suggest(null);
    })
    .finally(() => window.clearTimeout(waited));

  new ResizeObserver(layout).observe($("content"));
  layout();
  onStatus(renderHome);
  renderHome();
  // Whether the window shows is asked, not assumed: until it answered, no microphone opens.
  void lookAtWindow();
}
