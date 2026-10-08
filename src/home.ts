// Home, the dictation page. The daily view: the hotkeys (set in place), the
// quick switches (the same settings as in Settings, mirrored), what is
// loaded, "add a word", and the recent dictations (src/history.ts). While
// something a dictation needs is missing: the setup steps in the controls'
// place, and under them the recent dictations of someone who has dictated
// before (the list is nowhere else in the window).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "./i18n";
import { activity } from "./activity";
import { mirrorHint, mirrorSelect, mirrorSwitch } from "./mirror";
import { prefs, reveal, roomBeside, updatePrefs, WIDE, WIDER } from "./shell";
import { downloadFailure, showProgress, type DownloadProgress } from "./progress";
import { currentSpeech, currentStatus, onStatus } from "./status-view";
import { type Status } from "./status.ts";
import { header, idleFor, meterMay, meterStep, modelStep, recommend, setup, METER_SILENT_MS, type Gpu, type MeterNow, type Recommendation, type Setup } from "./setup.ts";
import { modelLabel, speechModel } from "./models.ts";
import { sizeText } from "./size.ts";
import { askOnce } from "./start";

export interface HomeHost {
  /** The settings were read from the backend. Until then Home shows its
   *  heading alone: every key, switch and choice on it is one of them. */
  loaded(): boolean;
  /** Dictations in the history; null until it was read. */
  history(): number | null;
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
  /** The speech model whose download did not finish, with the backend's
   *  reason ("" for none), as its row in Settings says it; null: none. */
  speechFailure(): { model: string; reason: string } | null;
  /** The AI model in use and its state line, as Settings shows them: the
   *  text, its tone, what kind of state it is ("ready", "off", "missing",
   *  "loading", "failed" …), whether the model's download did not finish,
   *  and, after a failed start or a failed download, the way to try again. */
  ai(): { name: string; state: string; tone: string; kind: string; downloaded: boolean; failed: boolean; retry: (() => void) | null };
  /** An AI model's name and size (the setup suggests one for this PC). */
  aiModel(id: string): { name: string; bytes: number } | null;
  /** Add words to the dictionary; how many were new. -1: they could not be saved (the page has said so). */
  addWords(text: string): Promise<number>;
  /** Choose this speech model, download it if it is missing, and save the choice. True when it is there and saved. */
  setUpSpeech(id: string): Promise<boolean>;
  /** Choose this AI model, download it and turn AI cleanup on. */
  setUpAi(id: string): Promise<boolean>;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const title = $("home-title");
const pill = $("home-status");
const pillText = $("home-status-text");
const how = $("home-how");
const notice = $("home-notice");
/** Read out, not shown: the notice's sentence, written when the notice shows. */
const live = $("home-live");
const daily = $("home-daily");
const recent = $("home-recent");
const setupBox = $("home-setup");
const aiCard = $("home-ai-card");

let host: HomeHost;
let syncs: (() => void)[] = [];
/** The models to suggest for this PC; null until its graphics cards are known. */
let suggestion: Recommendation | null = null;
/** The layout the cards are in: "wide" (two columns), "narrow" (one), or
 *  "list" (the steps show: of the daily view only the recent dictations);
 *  null before the first look. */
let laidOut: "wide" | "narrow" | "list" | null = null;

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
  const said = header(now, s);
  title.removeAttribute("data-i18n");
  const heading = t(said.title);
  if (title.textContent !== heading) title.textContent = heading;
  // "Loading models…" has its own colour, whatever the status behind it is.
  pill.dataset.tone = said.pill === "status_loading" ? "busy" : now.tone;
  const words = t(said.pill).replace("{n}", () => said.n);
  if (pillText.textContent !== words) pillText.textContent = words;
  // The steps say how to dictate (step 3); before Home knows what it shows, nothing does.
  how.classList.toggle("hidden", s.needed || !s.known);
  // The speech model is there and did not load: say what helps. The
  // sentence is also written into a line that is read out: a notice that
  // is only un-hidden changes no text, and a screen reader may say nothing.
  const failed = now.missing.includes("load");
  notice.classList.toggle("hidden", !failed);
  const sentence = failed ? t("home_load_failed") : "";
  if (live.textContent !== sentence) live.textContent = sentence;
}

// ── What is loaded ────────────────────────────────────

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
    speechLine.textContent = `${speechModel(speech.model).name} · ${state[speech.load]}`;
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
  // "Retry" after the line that names it: the AI did not start, or its
  // model's download did not finish. Pressed for a download, the button
  // rests where it is while that download runs (it has the keyboard focus,
  // which a button that goes would drop); when it goes at the end, the
  // focus moves to the switch the download was for.
  const retry = $("home-ai-retry");
  const held = document.activeElement === retry;
  const waits = held && ai.retry === null && ai.kind === "downloading";
  retry.classList.toggle("hidden", ai.retry === null && !waits);
  if (waits) retry.setAttribute("aria-disabled", "true");
  else retry.removeAttribute("aria-disabled");
  // "Retry" alone does not say what: the server's is the line before it, the download's is named.
  if (ai.failed || waits) retry.setAttribute("aria-label", t("setup_ai_retry"));
  else retry.removeAttribute("aria-label");
  if (held && retry.classList.contains("hidden")) $("home-ai-toggle").focus();
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

/** Which of its views Home shows. Not known before the settings are: the
 *  steps and the daily view are both made of them. */
function currentSetup(): Setup {
  return setup({
    speech: host.loaded() ? currentSpeech() : null,
    microphones: host.microphones(),
    history: host.history(),
    aiDownloaded: host.ai().downloaded,
    aiDismissed: prefs.aiCardDismissed,
  });
}

/** A speech model as a step names it: "Large v3 Turbo q8 · 870 MB" with its
 *  size, "Large v3 Turbo q8" without (src/models.ts). */
function modelNamed(id: string, size: boolean): string {
  return whole(size ? modelLabel(id) : speechModel(id).name);
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

/** A button whose words change keeps the width of its widest ones, so what
 *  stands beside it does not move: the words it does not show (up to two)
 *  lie in it unseen (styles/home.css). */
function widest(button: HTMLElement, labels: string[]) {
  const [first = "", second = ""] = labels.filter((label) => label !== button.textContent);
  button.dataset.alt = first;
  button.dataset.alt2 = second;
}

/** A download's bar with its numbers, always percent and size (src/progress.ts); null hides it. */
function progress(prefix: string, p: DownloadProgress | null) {
  $(`${prefix}-progress`).classList.toggle("hidden", p === null);
  if (p) showProgress({ bar: $(`${prefix}-bar`), fill: $(`${prefix}-fill`), numbers: $(`${prefix}-numbers`) }, p);
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
  // Under the steps the daily view is its list alone, and only where there
  // is one: the recent dictations with their search and actions are nowhere
  // else in the window. A PC that has never dictated sees the steps alone.
  const listOnly = s.needed && (host.history() ?? 0) > 0;
  daily.classList.toggle("hidden", !s.known || (s.needed && !listOnly));
  layout(listOnly);
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
      case "failed": {
        // Which model, and how much there is to fetch, stays said beside Retry,
        // with the backend's reason where Settings has one for this model.
        // The colour is the one the model's row in Settings has: an error.
        const tried = modelTried ?? suggestion?.model ?? "";
        const why = host.speechFailure();
        line = downloadFailure(modelNamed(tried, true), why?.model === tried ? why.reason : "");
        tone = "error";
        label = t("retry");
        name = t("setup_model_retry");
        break;
      }
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
    // A download of this model that was started in Settings and did not
    // finish is the same failure here, for as long as Settings says so.
    const failed = aiFailed || (!busy && host.ai().failed && host.ai().name === ai.name);
    const fill = (text: string) => text.replace("{model}", () => whole(ai.name)).replace("{size}", () => whole(sizeText(ai.bytes)));
    // The card has one height in every state (styles/home.css): its line
    // keeps the room of the text it rests on, and whatever it says meanwhile
    // is shorter than that text.
    const rest = fill(t("setup_ai_text"));
    $("setup-ai-line").dataset.rest = rest;
    // What the card started ends with AI cleanup on (setUpAi), also behind a
    // card that was hidden meanwhile: the card says so. A download started
    // in Settings turns nothing on.
    const text = failed ? fill(t("setup_ai_failed")) : aiSetting ? t("setup_ai_coming") : busy ? t("setup_ai_fetching") : rest;
    say($("setup-ai-text"), text, failed ? "error" : "");
    const name = busy ? t("setup_ai_fetching") : failed ? t("setup_ai_retry") : t("setup_ai_get");
    const download = $("setup-ai-download");
    act(download, busy ? t("setup_downloading") : failed ? t("retry") : t("download"), false, busy, name);
    widest(download, [t("download"), t("setup_downloading"), t("retry")]);
    // "Hide", in every state: the card does not come back ("Not now" promised
    // a later). Where the model can be had later is said in the card's text.
    const dismiss = t("setup_ai_hide");
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
/** When the user last touched this window (pointer, key, click, focus), on
 *  both clocks; null: never. The time since then is the longer of the two
 *  answers (src/setup.ts, idleFor): `performance.now()` can stand still
 *  while the PC sleeps, and the wall clock can be set back. */
let usedAt: { perf: number; wall: number } | null = null;
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
    if (call !== meterCall) {
      // Unless it opened although the page's last word is "stop": the two
      // arrived swapped (each call is a request of its own). Said again, or
      // the microphone stays open to the backend's limit. With a newer start
      // as the last word nothing is sent: that start replaces this one, or
      // answers "stopped" below.
      if (!metering) void invoke("mic_meter_stop").catch(() => {});
      return;
    }
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
      // The latest start was stopped, and not by the page (a stop or a newer
      // start of the page's would be the latest call). An older start may
      // have arrived after it and hold the microphone open, with the page
      // believing it closed: close it. Only the latest call gets here, so
      // this never stops a newer start that is wanted.
      void invoke("mic_meter_stop").catch(() => {});
      // Or the backend stopped it while the device opened: the window was
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
    idle: usedAt === null ? null : idleFor(now - usedAt.perf, Date.now() - usedAt.wall),
    on: metering,
    opening,
    silent,
    sinceStart: now - startedAt,
  };
}

/** The user touched the window: the pointer moved or pressed on it, a key
 *  was pressed in it, something in it was clicked (all a screen reader in
 *  browse mode or voice control sends), it got the focus. The level may run
 *  for the next minute, and one that rests comes back now, without a click. */
function used(e: Event) {
  // A pointer that crosses a window left open beside other work is no use of
  // it: the microphone would open each time.
  if (e.type === "pointermove" && !document.hasFocus()) return;
  usedAt = { perf: performance.now(), wall: Date.now() };
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
  // save was answered): from now on the level is that one's, for a user who
  // is there. With nobody there it rests, and the next touch opens the new one.
  else if (metering && meterFor !== host.microphone()) void meter(meterMay(now), true);
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
 *  is the order on the page in both (with CSS `order` the page would show
 *  one order and Tab would go another: the list after the quick switches to
 *  the eye, after "add a word" to the keyboard). From 1600 px the controls
 *  are two columns themselves (styles/home.css), so a large window is filled.
 *
 *  While the setup steps show (`listOnly`), the list is the daily view's
 *  only card: it stands under the steps at the page's width (beside them in
 *  a large window, where the page is Home's grid: styles/home.css), and the
 *  controls, which the steps replace, are not shown.
 *
 *  The width is the one with the scrollbar's room in it. `clientWidth`
 *  loses that room when the page gets a scrollbar: a layout that decides on
 *  it and is higher in the wider form brings its own scrollbar, loses the
 *  width, steps back, loses the scrollbar, and so on in every frame. */
function layout(listOnly = laidOut === "list") {
  const width = roomBeside();
  const next = listOnly ? "list" : width >= WIDE ? "wide" : "narrow";
  daily.classList.toggle("wider", !listOnly && width >= WIDER);
  if (next === laidOut) return;
  laidOut = next;
  daily.classList.toggle("wide", next === "wide");
  daily.classList.toggle("list-only", listOnly);
  const into = next === "narrow" ? $("home-switches") : $("home-controls");
  if (recent.previousElementSibling === into) return;
  // A node that is moved loses the keyboard focus: whoever was in the list
  // (its search field, a dictation's Copy) when the window crossed the step
  // stood on nothing afterwards, and the next Tab started at the top of the
  // page. The focus goes back where it was, with the field's selection.
  const at = document.activeElement;
  const held = at instanceof HTMLElement && recent.contains(at) ? at : null;
  const field = held instanceof HTMLInputElement ? held : null;
  const selection = field ? ([field.selectionStart, field.selectionEnd, field.selectionDirection] as const) : null;
  into.after(recent);
  if (!held) return;
  held.focus({ preventScroll: true });
  if (field && selection && selection[0] !== null && selection[1] !== null) field.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
}

// ── Wiring ────────────────────────────────────────────

/** Draw Home again from the settings and the status (after a load, a save, a language change). */
export function renderHome() {
  if (!host) return;
  const now = currentStatus();
  renderHeader(now, currentSetup());
  // The settings are not read yet: the heading alone. Every key, switch and
  // choice on this page is one of them, and neither view shows before they
  // are known (index.html has both hidden).
  if (!host.loaded()) return;
  for (const sync of syncs) sync();
  renderHow();
  renderLoaded();
  renderSetup();
}

/** The Display Language changed: what this page wrote once, in the old one,
 *  and does not draw from data ("Added …" under the word field) is over. */
export function forgetHomeSaid() {
  $("home-word-status").textContent = "";
}

export function initHome(h: HomeHost) {
  host = h;
  const select = (id: string) => $<HTMLSelectElement>(id);
  syncs = [
    mirrorSwitch($<HTMLInputElement>("ai-toggle"), $<HTMLInputElement>("home-ai-toggle")),
    mirrorSelect(select("language-select"), select("home-language-select")),
    mirrorSelect(select("ai-output-select"), select("home-output-select")),
    mirrorSelect(select("mic-select"), select("setup-mic-select")),
    // Why "Write in" translates nothing at the moment, as Settings says it
    // under the same control. One of the two notes names a place: in
    // Settings the Language is on another tab, here it is the row above.
    mirrorHint([$("ai-output-skip"), $("ai-output-warn")], $("home-output-hint"), (source) => (source.id === "ai-output-warn" ? t("home_output_warn") : null)),
  ];
  $("home-ai-retry").addEventListener("click", () => {
    if (!resting($("home-ai-retry"))) host.ai().retry?.();
  });

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
    if (!word || !host.loaded()) return;
    const added = await host.addWords(word);
    // Not saved: the page has said why, and the word stays in the field.
    if (added < 0) return void ($("home-word-status").textContent = "");
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
  for (const touch of ["pointermove", "pointerdown", "keydown", "click", "focus"]) window.addEventListener(touch, used, { passive: true });
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
  // Settings > Models & GPU lists the cards too: they are looked at once (src/start.ts).
  askOnce<Gpu[]>("detect_gpus")
    .then(suggest)
    .catch((e) => {
      console.error("detect_gpus failed:", e);
      // Without the list: what fits every PC.
      if (!suggestion) suggest(null);
    })
    .finally(() => window.clearTimeout(waited));

  new ResizeObserver(() => layout()).observe($("content"));
  layout();
  onStatus(renderHome);
  renderHome();
  // Whether the window shows is asked, not assumed: until it answered, no microphone opens.
  void lookAtWindow();
}
