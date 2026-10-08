import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { setLang, getLang, detectDefaultLang, t } from "./i18n";
import { populateLanguageSelect } from "./languages";
import { aiActivity, aiModelInfo, aiModelNamed, aiSummary, initAiSettings, refreshAiStatus, setUpAi, showAiSettings, type AppRule } from "./ai-settings";
import { addWords, clearDictionaryStatus, initDictionary, renderDictionary } from "./dictionary";
import { historyCount, initHistory, refreshHistory, renderHistory } from "./history";
import { forgetHomeSaid, initHome, renderHome } from "./home";
import { initFiles, renderFiles } from "./files";
import { initMeetingQuit, initMeetings, renderMeetings } from "./meetings";
import { playStart, playStop, playDiscard, setVolume } from "./sounds";
import { hotkeyLabel, startCapture } from "./hotkey-capture";
import { mountBoard } from "./soundboard/board";
import { announceRoute, currentRoute, go, initShell, onRoute, prefs, reveal, startOn, updatePrefs } from "./shell";
import { downloadFailure, NOT_STARTED, showProgress, type DownloadProgress } from "./progress";
import { modelLabel, modelToSave, speechModel, SPEECH_MODELS } from "./models.ts";
import { setDownload } from "./activity";
import { currentSpeech, initStatus, onStatus, refreshSpeech, renderStatus } from "./status-view";
import { recommend, setup, type Recommendation } from "./setup.ts";
import { sizeText } from "./size.ts";
import { askOnce, stateOnce } from "./start";
import { initHints, nameRows } from "./rows";
import { deleteButton, FailureSaid, repaintDeletes } from "./confirm-delete";
import { initReplacements, readReplacements, renderReplacements, type Replacement } from "./replacements";

// The language first, from what is known without the backend: the one this
// window was last shown in, else Windows' own. The page's static text is in
// it from the first moment; the settings follow when they are read.
setLang(prefs.lang || detectDefaultLang());

interface Settings {
  microphone: string;
  engine: string;
  whisperModel: string;
  groqApiKey: string;
  recordingMode: string;
  hotkey: string;
  gpuBackend: string;
  language: string;
  uiLanguage: string;
  volume: number;
  autostart: boolean;
  customPrompt: string;
  replacements: Replacement[];
  sendCommand: string;
  history: string;
  pasteLastHotkey: string;
  whisperFlashAttn?: string;
  rewriteLastHotkey: string;
  freeGpuHotkey: string;
  muteAudio: boolean;
  aiCleanup: boolean;
  aiModel: string;
  aiStyle: string;
  aiInstructions: string;
  aiRules: AppRule[];
  swissSpelling: boolean;
  aiOutputLanguage: string;
  editMode: boolean;
  screenContext: boolean;
  learnDictionary: boolean;
  fileSpeakers: string;
  meetingHotkey: string;
  meetingReminderOff: boolean;
  meetingHeadphonesSeen: boolean;
  freeGpuForGames: boolean;
  /** Mains power: unload the models after this many idle minutes; 0 = never. */
  idleUnloadMinutes: number;
}

interface MicDevice {
  name: string;
  is_default: boolean;
}

// DOM elements
const micSelect = document.getElementById("mic-select") as HTMLSelectElement;
const engineLocal = document.getElementById("engine-local")!;
const engineCloud = document.getElementById("engine-cloud")!;
const localSettings = document.getElementById("local-settings")!;
const cloudSettings = document.getElementById("cloud-settings")!;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const languageSelect = document.getElementById("language-select") as HTMLSelectElement;
const gpuBackendSelect = document.getElementById("gpu-backend-select") as HTMLSelectElement;
const uiLanguageSelect = document.getElementById("ui-language-select") as HTMLSelectElement;
const volumeSlider = document.getElementById("volume-slider") as HTMLInputElement;
const autostartToggle = document.getElementById("autostart-toggle") as HTMLInputElement;
const downloadBtn = document.getElementById("download-btn")!;
const downloadProgress = document.getElementById("download-progress")!;
const progressFill = document.getElementById("progress-fill")!;
/** The speech model's bar with its numbers (src/progress.ts). */
const speechProgress = { bar: document.getElementById("progress-bar")!, fill: progressFill, numbers: document.getElementById("download-numbers")! };
const modelNote = document.getElementById("model-note")!;
/** What a screen reader hears of the speech model's download: its start and its end. */
const downloadLive = document.getElementById("download-live")!;
const cloudNote = document.getElementById("engine-cloud-note")!;
const groqKey = document.getElementById("groq-key") as HTMLInputElement;
const modeToggle = document.getElementById("mode-toggle")!;
const modePtt = document.getElementById("mode-ptt")!;
const pcCheckBtn = document.getElementById("pc-check-btn") as HTMLButtonElement;
const pcCheckResult = document.getElementById("pc-check-result")!;
const pcCheckReport = document.getElementById("pc-check-report")!;
const pcCheckCopy = document.getElementById("pc-check-copy") as HTMLButtonElement;
const sendCommandSelect = document.getElementById("send-command-select") as HTMLSelectElement;
const muteAudioToggle = document.getElementById("mute-audio-toggle") as HTMLInputElement;
const gameFreeToggle = document.getElementById("game-free-toggle") as HTMLInputElement;
const gameFreeStatus = document.getElementById("game-free-status")!;
const idleUnloadSelect = document.getElementById("idle-unload-select") as HTMLSelectElement;
const unusedModelList = document.getElementById("unused-model-list")!;
const unusedModelEmpty = document.getElementById("unused-model-empty")!;
const historyModeSelect = document.getElementById("history-mode-select") as HTMLSelectElement;
/** Every speech model with its one line, behind the row's "More". */
const modelMore = document.getElementById("model-more")!;
/** A save the backend refused (or settings that did not load): the notice at the top of every page, and the line that reads it out. */
const saveNotice = document.getElementById("save-notice")!;
const saveNoticeText = document.getElementById("save-notice-text")!;
const saveLive = document.getElementById("save-live")!;
/** The pages whose controls are made of the settings: they rest until those are read. */
const settingsPages = ["section-home", "section-files", "section-settings"].map((id) => document.getElementById(id)!);
// The Soundboard page; the same component runs in the pop-out window.
const soundboard = mountBoard(document.getElementById("sb-root")!, { popOut: false });

// Sections and Settings tabs (src/shell.ts); what a page needs when it is shown.
initShell();
initHints();
onRoute((now) => {
  // Home's setup listens to the microphone only while it is on screen.
  renderHome();
  soundboard.setActive(now.section === "soundboard");
  if (now.section === "meetings") void renderMeetings();
  if (now.section === "settings" && now.tab === "models") void renderUnusedModels();
});

// Window drag — titlebar and sidebar empty space
const titlebar = document.getElementById("titlebar")!;
const sidebar = document.getElementById("sidebar")!;
const appWindow = getCurrentWindow();

titlebar.addEventListener("mousedown", (e) => {
  if ((e.target as HTMLElement).closest("button, select, input, a, .nav-item")) return;
  appWindow.startDragging();
});

sidebar.addEventListener("mousedown", (e) => {
  if ((e.target as HTMLElement).closest("button, select, input, a, .nav-item")) return;
  // The sidebar's own scrollbar (a very low window) scrolls, it does not move the window.
  if (e.target === sidebar && e.offsetX >= sidebar.clientWidth) return;
  appWindow.startDragging();
});

let currentSettings: Settings;
/** The settings were read and every control shows them. Until then nothing
 *  is saved (a save reads the controls, and controls that are not filled
 *  yet would be saved as empty: the microphone, the model, every
 *  replacement and rule), and the pages made of settings rest (`inert`). */
let settingsLoaded = false;
/** The settings as the backend has them: as read, then as the last save
 *  that was answered sent them. A save that is refused puts the controls
 *  back on these. */
let savedSettings: Settings | null = null;
let mics: MicDevice[] = [];
/** The microphones were listed (an empty list is then no microphone). */
let micsListed = false;
/** The microphone the backend has: as loaded, then as the last save that was
 *  answered sent it. Home's level opens what is saved, so it follows this
 *  and not the dropdown. */
let savedMicrophone = "default";

/// "default" follows whatever Windows uses as input. A saved device that is
/// unplugged stays listed, so the dropdown never goes blank and a later save
/// cannot wipe the choice.
function renderMicOptions() {
  const saved = currentSettings.microphone || "default";
  const add = (value: string, label: string) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    micSelect.appendChild(option);
  };
  micSelect.innerHTML = "";
  const systemDefault = mics.find((m) => m.is_default);
  // "System default: Microphone (Fast Track)": a name in brackets after it would end in two closing brackets.
  add("default", systemDefault ? `${t("mic_system_default")}: ${systemDefault.name}` : t("mic_system_default"));
  for (const mic of mics) add(mic.name, mic.name);
  if (saved !== "default" && !mics.some((m) => m.name === saved)) {
    // Before the microphones were listed nobody knows whether it is connected: its name alone.
    add(saved, micsListed ? `${saved} (${t("mic_not_connected")})` : saved);
    // Home tints its microphone line for it.
    if (micsListed) (micSelect.lastElementChild as HTMLOptionElement).dataset.missing = "true";
  }
  micSelect.value = saved;
}

/** The microphones Windows has now; the dropdown and the status follow. */
async function listMicrophones() {
  mics = await invoke<MicDevice[]>("list_microphones");
  micsListed = true;
  // The dropdown shows the saved microphone: drawn once the settings are there (showSettings draws it then).
  if (settingsLoaded) renderMicOptions();
  renderStatus();
}
// A microphone plugged in while the window was away (the first run waits for
// one). Only while none is listed: asking holds the backend up for a moment
// and draws the dropdown again, also under an open one. And not before the
// settings are loaded, which list the microphones themselves.
window.addEventListener("focus", () => {
  if (!settingsLoaded || !micsListed || mics.length > 0) return;
  void listMicrophones().catch(console.error);
});

/** Read the settings and show them. Everything from the answer to the last
 *  control that is filled happens in one go, with nothing waited for in
 *  between: while it waited for the microphones and the models here, a click
 *  on any setting saved the controls that were still empty (the microphone
 *  as "", the model as "small", no replacement, no rule). What else the
 *  start asks the backend is asked beside this, not inside it. */
async function loadSettings() {
  const loaded = await invoke<Settings>("get_settings");
  savedSettings = structuredClone(loaded);
  currentSettings = loaded;
  // The Display Language: Windows' own on the first launch (an empty string), saved below.
  const firstLanguage = !currentSettings.uiLanguage;
  if (firstLanguage) currentSettings.uiLanguage = getLang();
  // Known from here on: the parts that draw from the settings do. Nothing
  // can come between this and the last control: no step below waits.
  settingsLoaded = true;
  try {
    showSettings();
  } catch (err) {
    settingsLoaded = false;
    throw err;
  }
  // Every control shows its setting: the pages may be used, and a save reads what is true.
  for (const page of settingsPages) page.inert = false;
  document.body.dataset.loaded = "true";
  // Nothing the user chose: a failure is the log's, and the next save carries the language.
  if (firstLanguage) store().catch((err) => console.error("saving the display language failed:", err));
}

/** Every control on what the settings say, and every text in their language:
 *  after they were read, and after a save the backend refused (then they are
 *  the saved ones again). Nothing is asked and nothing is waited for. */
function showSettings() {
  const s = currentSettings;
  savedMicrophone = (savedSettings ?? s).microphone || "default";
  uiLanguageSelect.value = s.uiLanguage;
  setLang(s.uiLanguage);
  volumeSlider.value = String(s.volume);
  setVolume(s.volume);
  autostartToggle.checked = s.autostart;
  // The key before the engine: the cloud engine's notice reads the field
  // (set after it, the notice warned of a missing key for a moment at every start).
  groqKey.value = s.groqApiKey;
  setEngine(s.engine);
  // A model that downloads keeps the dropdown: its end saves or reverts the choice itself.
  if (!downloadInFlight) {
    modelSelect.value = s.whisperModel;
    verifiedModel = s.whisperModel;
  }
  lastSavedModel = s.whisperModel;
  gpuBackendSelect.value = s.gpuBackend || "auto";
  gameFreeToggle.checked = s.freeGpuForGames ?? false;
  idleUnloadSelect.value = String(s.idleUnloadMinutes ?? 0);
  choose(modeToggle, s.recordingMode === "toggle");
  choose(modePtt, s.recordingMode === "push-to-talk");
  sendCommandSelect.value = s.sendCommand || "off";
  muteAudioToggle.checked = s.muteAudio;
  historyModeSelect.value = s.history || "audio";
  // The spoken language's choices are written in the Display Language: filled, then set.
  populateLanguageSelect(languageSelect, getLang(), t("language_auto"));
  languageSelect.value = s.language;
  showTexts();
}

/** Everything the page writes in the Display Language, again: the choices of
 *  the selects, the rows built from the settings, and what is drawn from
 *  what the backend last answered. Nothing is asked: each part draws what it
 *  knows, so a language change waits for nothing and no failing question
 *  can leave half the window in the old language. */
function showTexts() {
  if (prefs.lang !== getLang()) updatePrefs((p) => (p.lang = getLang()));
  nameRows();
  // "Delete history" and "Clear" were given their words when their pages
  // were wired, before the language was known (src/confirm-delete.ts).
  repaintDeletes();
  // (It keeps the choice it had.)
  populateLanguageSelect(languageSelect, getLang(), t("language_auto"));
  renderMicOptions();
  renderCloudNote();
  renderDetectedGpus();
  renderDownloadButton();
  renderModels();
  renderPcCheck();
  drawUnusedModels();
  renderReplacements();
  showAiSettings();
  renderDictionary();
  renderFiles();
  renderHistory();
  soundboard.redraw();
  // The hotkeys, then the status, which draws Home.
  renderHotkeys();
  renderStatus();
}

// ── Saving ────────────────────────────────────────────

/** The saves that are out, and their numbers: of two answers, the later save's is what the backend has. */
let savesOut = 0;
let saveSent = 0;
let saveAnswered = 0;

/** Send the settings as they are now; throws what the backend answers. The
 *  one way to the backend's `save_settings`: every save of the window goes
 *  through here (the controls, the rules, the dictionary, Files' and
 *  Meetings' own values). Not before the settings were read. */
async function store(): Promise<void> {
  if (!settingsLoaded) throw new Error("the settings are not loaded yet");
  const sent = structuredClone(currentSettings);
  const n = ++saveSent;
  savesOut++;
  try {
    await invoke("save_settings", { settings: sent });
  } finally {
    savesOut--;
  }
  if (n < saveAnswered) return;
  saveAnswered = n;
  savedSettings = sent;
  savedMicrophone = sent.microphone || "default";
  // A save that works ends what was said of one that did not.
  hideNotice();
}

/** Show the notice at the top of the page, and have it read out. */
function sayNotice(text: string) {
  saveNoticeText.textContent = text;
  saveNotice.classList.remove("hidden");
  // Written anew also where the words are the same (a second save failed).
  saveLive.textContent = "";
  saveLive.textContent = text;
}

function hideNotice() {
  saveNotice.classList.add("hidden");
  saveNoticeText.textContent = "";
  saveLive.textContent = "";
}
document.getElementById("save-notice-close")!.addEventListener("click", () => {
  // The button goes with its notice: the focus moves to the page's heading.
  const held = saveNotice.contains(document.activeElement);
  hideNotice();
  if (held) document.querySelector<HTMLElement>(".content-section.active .section-title")?.focus();
});

/** A save was refused: say so in the page, and put every control back on
 *  what is saved. Before, the control went on showing the new value and
 *  only the console heard of it. Not while a later save is still out: that
 *  one carries this change too, and its answer decides. */
function saveFailed(err: unknown) {
  console.error("saving the settings failed:", err);
  if (savesOut > 0 || !savedSettings) return;
  currentSettings = structuredClone(savedSettings);
  showSettings();
  sayNotice(t("save_failed").replace("{reason}", () => String(err)));
}

/** Save, and report a refusal in the page (saveFailed). True when it is saved. */
async function storeOrSay(): Promise<boolean> {
  if (!settingsLoaded) return false;
  try {
    await store();
    return true;
  } catch (err) {
    saveFailed(err);
    return false;
  }
}

/** A value that is no control of the Settings pages (Files' speakers, a meeting's reminders), saved with the rest. */
function savePatch(patch: Partial<Settings>): Promise<boolean> {
  if (!settingsLoaded) return Promise.resolve(false);
  Object.assign(currentSettings, patch);
  return storeOrSay();
}

interface GpuDevice {
  gpu_index: number;
  api: "Cuda" | "Vulkan";
  name: string;
  integrated: boolean;
  memory_mib: number;
}

/** The graphics cards as the backend last listed them; null until it answered. */
let detectedGpus: GpuDevice[] | null = null;

/** The graphics cards, looked at once for the whole window (src/start.ts):
 *  Home's setup asks for them too, and each look probes CUDA and Vulkan. */
async function refreshDetectedGpus() {
  try {
    detectedGpus = await askOnce<GpuDevice[]>("detect_gpus");
    renderDetectedGpus();
    // Which speech model is recommended for this PC is known now.
    renderModels();
  } catch (e) {
    console.error("detect_gpus failed:", e);
  }
}

/** The models recommended for this PC's graphics card (the rule of the first
 *  run's step 2, src/setup.ts); null until the cards are known. */
function recommendation(): Recommendation | null {
  return detectedGpus ? recommend(detectedGpus) : null;
}

/** The "Detected: …" line under GPU backend, from the list that is known
 *  (looking at the cards again can take seconds): drawn again after a
 *  change of the Display Language. */
function renderDetectedGpus() {
  const el = document.getElementById("gpu-detected")!;
  const gpus = detectedGpus;
  if (!gpus) return;
  // An iGPU reports shared system memory, so only dedicated cards count.
  const dedicated = gpus.filter((g) => !g.integrated);
  const vramGb = Math.max(0, ...dedicated.map((g) => g.memory_mib / 1024));
  if (gpus.length === 0) {
    el.textContent = `${t("gpu_detected_none")}. ${t("gpu_hint_cpu")}`;
    return;
  }
  // An NVIDIA card is listed once per API; group the APIs by card name.
  const byName = new Map<string, string[]>();
  for (const g of gpus) {
    const apis = byName.get(g.name) ?? [];
    apis.push(g.api === "Cuda" ? "CUDA" : "Vulkan");
    byName.set(g.name, apis);
  }
  const list = [...byName].map(([name, apis]) => `${name} (${apis.join(", ")})`);
  let hint = "";
  if (dedicated.length === 0) {
    hint = t("gpu_hint_cpu");
  } else if (vramGb <= 8.5) {
    hint = t("gpu_hint_small").replace("{gb}", () => String(Math.round(vramGb)));
  }
  el.textContent = `${t("gpu_detected")}: ${list.join("; ")}. ${hint}`.trim();
}

/** A segmented choice: the chosen button is `active` and pressed. */
function choose(button: HTMLElement, on: boolean) {
  button.classList.toggle("active", on);
  button.setAttribute("aria-pressed", String(on));
}

function setEngine(engine: string) {
  if (!currentSettings) return;
  currentSettings.engine = engine;
  choose(engineLocal, engine === "local");
  choose(engineCloud, engine === "cloud");
  localSettings.classList.toggle("hidden", engine !== "local");
  cloudSettings.classList.toggle("hidden", engine !== "cloud");
  renderCloudNote();
}

/** The speech model's row is gone with the cloud engine: the notice in its
 *  place says where the engine is. Without the key nothing is transcribed:
 *  then it says that, in the colour of a warning, with the way to the key
 *  field (it is in the Advanced fold, which may be closed). */
function renderCloudNote() {
  if (!currentSettings) return;
  const keyed = groqKey.value.trim() !== "";
  cloudNote.classList.toggle("hidden", currentSettings.engine !== "cloud");
  if (keyed) delete cloudNote.dataset.tone;
  else cloudNote.dataset.tone = "warn";
  const text = document.getElementById("engine-cloud-text")!;
  const key = keyed ? "cloud_note" : "cloud_note_no_key";
  text.setAttribute("data-i18n", key);
  text.textContent = t(key);
  document.getElementById("engine-cloud-key")!.classList.toggle("hidden", keyed);
}
document.getElementById("engine-cloud-key")!.addEventListener("click", () => reveal("groq-key"));

function setRecordingMode(mode: string) {
  if (!currentSettings) return;
  currentSettings.recordingMode = mode;
  choose(modeToggle, mode === "toggle");
  choose(modePtt, mode === "push-to-talk");
  // Home says how to dictate: "Hold …" or "Press …".
  renderHome();
}

/** Is this speech model on disk? Without an id: the one the dropdown is on. */
async function isModelDownloaded(model = modelSelect.value): Promise<boolean> {
  return await invoke<boolean>("check_model_downloaded", {
    modelSize: model,
  });
}

/** The Download button shows only while the chosen model is missing (a
 *  downloaded one has its tick in the list), with the model's note under the label. */
async function refreshModelStatusUI() {
  const downloaded = await isModelDownloaded();
  renderDownloadButton();
  // A download that runs keeps its button as it is (this is also called on a
  // language change): resting where Download was pressed, and not there at
  // all where the dropdown started it.
  if (!downloadInFlight) downloadBtn.classList.toggle("hidden", downloaded);
  (downloadBtn as HTMLButtonElement).disabled = downloadInFlight;
  renderModelNote();
  await refreshModelDropdownLabels();
}

/** The speech models that are on disk, as the backend last answered; null until it did. */
let onDisk: Set<string> | null = null;

/** The speech model whose download did not finish. The row says so until
 *  the next choice or a download that works; a new try starts clean. */
let downloadFailed: string | null = null;
/** Why it did not finish, as the backend said it: a full disk is not a bad connection. */
let downloadReason = "";

/** The failure's sentence with its reason (src/progress.ts); `name`: the model with its size. */
const failureSaid = (name: string) => downloadFailure(name, downloadReason);

/** What was said of the last download is over: the row's failure, and the
 *  line a screen reader was given. That line is not on screen, but someone
 *  who reads the page with a screen reader still finds it: left alone, it
 *  went on saying an old failure under a row that no longer shows one. */
function forgetDownload() {
  downloadFailed = null;
  downloadReason = "";
  downloadLive.textContent = "";
}

/** The one line about the model the dropdown is on. After a download that
 *  did not finish it says that instead, in the colour of an error: which
 *  model, and how to try again. The dropdown is back on the model that
 *  works by then (a model is saved only once it is there), so "Retry"
 *  stands in the line; where the dropdown is still on the model that
 *  failed, the Download button beside it reads "Retry". */
function renderModelNote() {
  if (downloadFailed === null) {
    const note = speechModel(modelSelect.value).note;
    let text = note ? t(note) : "";
    // The model the settings name is not on this PC (a first run, a file
    // that is gone): the row says which one is recommended here and why.
    // The dropdown itself stays on what the settings say: no setting
    // changes without the user's word.
    const best = recommendation();
    if (best && onDisk && !onDisk.has(modelSelect.value) && !downloadInFlight) {
      const named = modelLabel(best.model).replace(/ /g, "\u00a0");
      const why = best.gpu ? t("setup_model_for").replace("{gpu}", () => best.gpu).replace("{model}", () => named) : t("setup_model_cpu").replace("{model}", () => named);
      text = `${text} ${why}.`.trim();
    }
    modelNote.textContent = text;
    delete modelNote.dataset.tone;
    return;
  }
  // The name with its size stays on one line.
  const name = modelLabel(downloadFailed).replace(/ /g, "\u00a0");
  modelNote.textContent = failureSaid(name);
  modelNote.dataset.tone = "error";
  if (modelSelect.value === downloadFailed) return;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "link-btn";
  retry.textContent = t("retry");
  retry.setAttribute("aria-label", t("setup_model_retry"));
  retry.addEventListener("click", () => {
    if (downloadFailed === null || downloadInFlight) return;
    // The dropdown's own way: download it, and save the choice once it is there.
    // This button goes with the note: the keyboard focus moves to the dropdown.
    modelSelect.value = downloadFailed;
    modelSelect.focus();
    void chooseModel();
  });
  modelNote.append(" ", retry);
}

/** The Download button's words and its name ("Download" alone does not say
 *  what): "Retry" after the download of the model the dropdown is on did not finish. */
function renderDownloadButton() {
  const again = downloadFailed !== null && downloadFailed === modelSelect.value;
  downloadBtn.setAttribute("data-i18n", again ? "retry" : "download");
  downloadBtn.textContent = t(again ? "retry" : "download");
  downloadBtn.setAttribute("aria-label", t(again ? "setup_model_retry" : "setup_model_get"));
}

/** Ask which speech models are on disk, and draw what follows from it. */
async function refreshModelDropdownLabels() {
  const ids = SPEECH_MODELS.map((m) => m.id);
  const there = await Promise.all(ids.map((id) => invoke<boolean>("check_model_downloaded", { modelSize: id })));
  onDisk = new Set(ids.filter((_, i) => there[i]));
  renderModels();
}

/** What the row says of the models, from what is known: the dropdown's
 *  options, the note under the label and the list behind "More". */
function renderModels() {
  const best = recommendation()?.model;
  // "Large v3 Turbo q8 · 870 MB · recommended ✓": name, size, the one for
  // this PC's graphics card, and a tick when it is downloaded.
  for (const o of Array.from(modelSelect.options)) {
    const parts = [modelLabel(o.value)];
    if (o.value === best) parts.push(t("model_recommended_short"));
    o.textContent = parts.join(" \u00b7 ") + (onDisk?.has(o.value) ? " \u2713" : "");
  }
  renderModelNote();
  // Every model with its one line, so that what "q5" is beside "q8" can be
  // read without choosing it: choosing a model that is missing starts its
  // download, of up to 2.9 GB.
  modelMore.replaceChildren(
    ...SPEECH_MODELS.map((m) => {
      const item = document.createElement("span");
      item.className = "model-list-item";
      item.setAttribute("role", "listitem");
      const name = document.createElement("span");
      name.className = "model-list-name";
      name.textContent = modelLabel(m.id);
      item.append(name);
      if (m.id === best) {
        const mark = document.createElement("span");
        mark.className = "model-list-mark";
        mark.textContent = t("model_recommended_here");
        item.append(" ", mark);
      }
      if (m.note) item.append(" ", t(m.note));
      return item;
    }),
  );
}

let downloadInFlight = false;
async function downloadCurrentModel(): Promise<boolean> {
  if (downloadInFlight) return false;
  downloadInFlight = true;
  const model = modelSelect.value;
  const name = modelLabel(model);
  // The keyboard focus is on one of the row's controls: they rest while the
  // download runs (a resting control cannot hold the focus), and "Retry" in
  // the note goes with the failure it stood for.
  const at = document.activeElement;
  const focused = at === modelSelect || at === downloadBtn || modelNote.contains(at);
  // A new try starts clean: the last one's failure, its "Retry" and its numbers are gone.
  forgetDownload();
  renderModelNote();
  renderDownloadButton();
  (downloadBtn as HTMLButtonElement).disabled = true;
  modelSelect.disabled = true;
  showProgress(speechProgress, NOT_STARTED);
  downloadProgress.classList.remove("hidden");
  downloadLive.textContent = t("download_started").replace("{model}", () => name);
  setDownload("speech", 0);
  let ok = false;
  try {
    await invoke("download_model", { modelSize: model });
    // It is on disk: a save may store it from here on.
    verifiedModel = model;
    onDisk?.add(model);
    downloadBtn.classList.add("hidden");
    downloadLive.textContent = t("download_done").replace("{model}", () => name);
    ok = true;
    return true;
  } catch (e) {
    downloadFailed = model;
    downloadReason = String(e ?? "");
    downloadLive.textContent = failureSaid(name);
    (downloadBtn as HTMLButtonElement).disabled = false;
    console.error("Download failed:", e);
    return false;
  } finally {
    // A download that failed is over. One that worked stays in the status
    // until the backend has said that the model is there (downloadSettled).
    if (!ok) setDownload("speech", null);
    downloadProgress.classList.add("hidden");
    modelSelect.disabled = false;
    downloadInFlight = false;
    renderModelNote();
    renderDownloadButton();
    if (focused && (document.activeElement === document.body || document.activeElement === null)) modelSelect.focus();
    await refreshModelDropdownLabels();
  }
}

/** After a download that worked: ask the backend for the speech model's
 *  state, and only then take the download out of the status. Taken out
 *  sooner, the status steps back to "Setup needed: no speech model" for as
 *  long as the backend's last word still calls the model missing (a model
 *  chosen in the dropdown is saved only after its download). */
async function downloadSettled() {
  try {
    await refreshSpeech();
  } finally {
    // Not a download that started in the meantime: its own end clears it.
    if (!downloadInFlight) setDownload("speech", null);
  }
}

/** The controls' values, read into the settings. */
function readControls() {
  currentSettings.microphone = micSelect.value;
  // Only a model that is known to be on disk (src/models.ts).
  currentSettings.whisperModel = modelToSave(modelSelect.value, lastSavedModel, modelSelect.value !== verifiedModel);
  currentSettings.groqApiKey = groqKey.value;
  currentSettings.language = languageSelect.value;
  currentSettings.uiLanguage = uiLanguageSelect.value;
  currentSettings.gpuBackend = gpuBackendSelect.value;
  currentSettings.volume = parseFloat(volumeSlider.value);
  currentSettings.autostart = autostartToggle.checked;
  currentSettings.sendCommand = sendCommandSelect.value;
  currentSettings.muteAudio = muteAudioToggle.checked;
  currentSettings.freeGpuForGames = gameFreeToggle.checked;
  currentSettings.idleUnloadMinutes = parseInt(idleUnloadSelect.value, 10) || 0;
  currentSettings.history = historyModeSelect.value;
  currentSettings.replacements = readReplacements();
}

/** Save what the controls show. A save the backend refuses is said in the
 *  page, and the controls go back to what is saved; false then, and also
 *  before the settings were read (nothing is saved from controls that are
 *  not filled yet). */
function saveSettings(): Promise<boolean> {
  if (!settingsLoaded) return Promise.resolve(false);
  readControls();
  return storeOrSay();
}

/** The same save for a caller that says the failure itself, on its own
 *  button (a rule's, a word's, a replacement's Delete): it throws. */
async function saveStrict(): Promise<void> {
  if (!settingsLoaded) throw new Error("the settings are not loaded yet");
  readControls();
  await store();
}

// Event listeners
engineLocal.addEventListener("click", () => {
  setEngine("local");
  void saveSettings();
});

engineCloud.addEventListener("click", () => {
  setEngine("cloud");
  void saveSettings();
});

micSelect.addEventListener("change", async () => {
  await saveSettings();
  renderHome();
});

languageSelect.addEventListener("change", async () => {
  await saveSettings();
  // "Write in" warns when a spoken language is set.
  showAiSettings();
});

gpuBackendSelect.addEventListener("change", () => saveSettings());

// ── GPU management: free for games, unload when idle, unused models ──

function showGameFree(freed: boolean) {
  gameFreeStatus.classList.toggle("hidden", !freed);
}

gameFreeToggle.addEventListener("change", () => saveSettings());
idleUnloadSelect.addEventListener("change", () => saveSettings());
// The watcher freed the GPU for a game (true) or loaded the models again.
listen<boolean>("game-free", (event) => showGameFree(event.payload));

interface ModelFile {
  kind: "whisper" | "ai";
  file: string;
  bytes: number;
  /** An unfinished download (".part"). */
  partial: boolean;
  /** Other hard links to the file: deleting it frees no disk space. */
  otherLinks: boolean;
}

const DELETE_ERRORS: Record<string, string> = {
  in_use: "unused_model_in_use",
  meeting_busy: "unused_model_meeting_busy",
  busy: "unused_model_busy",
};

/** The name the rest of the window gives the model in this file ("Medium",
 *  "Gemma 4 E2B"); null for a file no model of the lists is kept in. */
function modelNameOf(m: ModelFile): string | null {
  if (m.kind === "ai") return aiModelNamed(m.file);
  const id = /^ggml-(.+?)\.bin(\.part)?$/.exec(m.file)?.[1] ?? "";
  const model = speechModel(id);
  return model.mb > 0 ? model.name : null;
}

/// One unused model as a list row: its name as everywhere else, then its
/// file, what it is and its size, and Delete.
function unusedModelRow(m: ModelFile): HTMLElement {
  const row = document.createElement("div");
  row.className = "list-row unused-model-row";
  row.setAttribute("role", "listitem");
  const info = document.createElement("div");
  info.className = "list-main";
  const named = modelNameOf(m);
  const name = document.createElement("span");
  name.className = "list-primary unused-model-name";
  name.textContent = named ?? m.file;
  const meta = document.createElement("span");
  meta.className = "list-secondary unused-model-name";
  // The file's own name is the second line: it is what the models folder shows.
  const parts = named ? [m.file] : [];
  parts.push(t(m.kind === "ai" ? "unused_model_ai" : "unused_model_whisper"));
  if (m.partial) parts.push(t("unused_model_partial"));
  parts.push(m.otherLinks ? `${sizeText(m.bytes)} (${t("unused_model_links")})` : sizeText(m.bytes));
  meta.textContent = parts.join(" \u00b7 ");
  const error = document.createElement("span");
  error.className = "list-secondary unused-model-error hidden";
  error.setAttribute("role", "alert");
  info.append(name, meta, error);

  // While the file is deleted the button rests (src/confirm-delete.ts). A
  // delete that fails says why in the row (read out from there), the button
  // says that it failed like every other delete, and the file stays in the list.
  const del = deleteButton(
    `model-${m.kind}-${m.file}`,
    async () => {
      error.classList.add("hidden");
      try {
        await invoke<number>("delete_unused_model", { kind: m.kind, file: m.file });
      } catch (err) {
        const code = String(err);
        const key = DELETE_ERRORS[code];
        error.textContent = key ? t(key) : t("unused_model_failed").replace("{error}", () => code);
        error.classList.remove("hidden");
        throw new FailureSaid(code);
      }
      await renderUnusedModels();
      if (m.kind === "ai") await refreshAiStatus();
      else await refreshModelDropdownLabels();
    },
    // After the last file the sentence that says so takes the focus.
    { name: named ?? m.file, after: () => unusedModelEmpty },
  );
  const actions = document.createElement("div");
  actions.className = "list-actions";
  actions.append(del);
  row.append(info, actions);
  return row;
}

/** The unused models as the backend last listed them; null until it did. */
let unusedModels: ModelFile[] | null = null;

/** The list, drawn from what is known (again after a change of the Display Language). */
function drawUnusedModels() {
  if (!unusedModels) return;
  unusedModelList.innerHTML = "";
  for (const m of unusedModels) unusedModelList.appendChild(unusedModelRow(m));
  unusedModelEmpty.classList.toggle("hidden", unusedModels.length > 0);
}

async function renderUnusedModels() {
  let files: ModelFile[] = [];
  try {
    files = await invoke<ModelFile[]>("unused_models");
  } catch (err) {
    console.error("unused_models failed:", err);
  }
  unusedModels = files;
  drawUnusedModels();
}

// PC check: measures, applies the fastest Whisper setup, shows a report.
interface PcCheckResult {
  report: string;
  gpuBackend: string;
  whisperFlashAttn: string;
  changed: boolean;
}
/** The PC check that runs: the step it is at and how many there are ("…"
 *  before its first report); null: none runs. */
let pcChecking: { done: string; total: string } | null = null;

/** The check's button: "Run check", or while it runs the step it is at.
 *  Drawn again after a change of the Display Language, which writes every
 *  button's resting words. */
function renderPcCheck() {
  pcCheckBtn.disabled = pcChecking !== null;
  const running = pcChecking;
  pcCheckBtn.textContent = running ? t("pc_check_running").replace("{done}", () => running.done).replace("{total}", () => running.total) : t("pc_check_run");
}

listen<[number, number, string]>("pc-check-progress", (event) => {
  const [done, total] = event.payload;
  if (!pcChecking) return;
  pcChecking = { done: String(Math.min(done + 1, total)), total: String(total) };
  renderPcCheck();
});
pcCheckBtn.addEventListener("click", async () => {
  if (pcChecking || !settingsLoaded) return;
  pcChecking = { done: "1", total: "…" };
  renderPcCheck();
  try {
    const result = await invoke<PcCheckResult>("pc_check");
    // The check saved new settings; keep the page's copies in step (what is saved, too).
    for (const copy of [currentSettings, savedSettings]) {
      if (!copy) continue;
      copy.gpuBackend = result.gpuBackend;
      copy.whisperFlashAttn = result.whisperFlashAttn;
    }
    gpuBackendSelect.value = result.gpuBackend;
    pcCheckReport.textContent = result.report;
    pcCheckResult.classList.remove("hidden");
  } catch (err) {
    // "meeting_busy": a meeting records or runs its end steps.
    pcCheckReport.textContent = String(err) === "meeting_busy" ? t("pc_check_meeting_busy") : `${t("pc_check_failed")}: ${err}`;
    pcCheckResult.classList.remove("hidden");
  } finally {
    pcChecking = null;
    renderPcCheck();
  }
});
pcCheckCopy.addEventListener("click", async () => {
  await invoke("copy_text", { text: pcCheckReport.textContent ?? "" });
  pcCheckCopy.textContent = t("pc_check_copied");
  setTimeout(() => (pcCheckCopy.textContent = t("pc_check_copy")), 1500);
});

uiLanguageSelect.addEventListener("change", async () => {
  if (!settingsLoaded) return;
  // The choice is saved first, before anything is drawn again: it was the
  // tenth thing the handler did, after four questions to the backend, and
  // one of them failing lost it. (The save reads every control, also the
  // rows that are drawn again below.)
  const saved = saveSettings();
  setLang(uiLanguageSelect.value);
  // What was written once, in the old language, and is not drawn from data:
  // the line a screen reader was given of the last download, what the last
  // import said, "Added …" on Home, the Soundboard's notice.
  downloadLive.textContent = "";
  clearDictionaryStatus();
  forgetHomeSaid();
  soundboard.redraw(true);
  // Everything else, from what is known: nothing is asked, nothing can fail half way.
  showTexts();
  // The Meetings page reads its list again; the save does not wait for it.
  void renderMeetings().catch((err) => console.error("drawing the Meetings page again failed:", err));
  // A save that is refused puts the old language back (saveFailed).
  await saved;
});

sendCommandSelect.addEventListener("change", () => saveSettings());
muteAudioToggle.addEventListener("change", () => saveSettings());
historyModeSelect.addEventListener("change", async () => {
  if (!settingsLoaded) return;
  await saveSettings();
  await refreshHistory();
});

volumeSlider.addEventListener("input", () => {
  setVolume(parseFloat(volumeSlider.value));
});
volumeSlider.addEventListener("change", () => saveSettings());

autostartToggle.addEventListener("change", async () => {
  if (!settingsLoaded) return;
  const enabled = autostartToggle.checked;
  try {
    await invoke("set_autostart", { enabled });
  } catch (e) {
    // Windows refused: the switch goes back, and the page says why.
    console.error("Failed to toggle autostart:", e);
    autostartToggle.checked = currentSettings.autostart;
    sayNotice(t("save_failed").replace("{reason}", () => String(e)));
    return;
  }
  // Not saved: the switch is back on what is saved, and Windows is told the same.
  if (!(await saveSettings())) invoke("set_autostart", { enabled: currentSettings.autostart }).catch((e) => console.error("Failed to toggle autostart:", e));
});

let lastSavedModel = "";
/** The speech model a save may store (saveSettings): the one last known to
 *  be on disk. At the start it is the saved one (saving that again changes
 *  nothing, also where it is missing: the first run); then the model a check
 *  found, the one a download brought, and after a download that failed the
 *  saved one the dropdown goes back to. The dropdown itself says too little:
 *  it is on a model before that model is known to be there, and whether a
 *  download runs covers only a part of that time. Two saves fell in the
 *  rest: one in the moment after a failed download, before the dropdown was
 *  back (the rows' ticks are asked for first), and the save of an earlier
 *  choice that found the dropdown already on the next, missing one. */
let verifiedModel = "";
/** The model in the dropdown was chosen: one that is missing is downloaded
 *  first. True when it is there and saved. */
async function chooseModel(): Promise<boolean> {
  if (!settingsLoaded) return false;
  const model = modelSelect.value;
  const previousSaved = lastSavedModel || currentSettings.whisperModel;
  // A new choice: what the row said of a download that did not finish is over.
  if (!downloadInFlight) forgetDownload();
  // The note follows the dropdown at once, also through the download of a model that is missing.
  renderModelNote();
  if (await isModelDownloaded(model)) {
    // The answer is about `model`. Where the dropdown has moved on meanwhile
    // (arrow keys go through the list), that choice has a call of its own,
    // and this one must not vouch for it.
    if (modelSelect.value === model) verifiedModel = model;
    await refreshModelStatusUI();
    await saveSettings();
    // What the save stored: this model, or the saved one where the dropdown moved on to a model that is not known yet.
    lastSavedModel = currentSettings.whisperModel;
    await renderUnusedModels();
    return lastSavedModel === model;
  }
  // A download runs already, and the dropdown rests on its model: this is a
  // second word for the same choice (the list is disabled meanwhile, so it
  // came from code). The download's own end saves it; going on here would
  // find the download refused, and put the dropdown back on the old model
  // under a download that then counts as failed.
  if (downloadInFlight) return false;
  // The dropdown moved on while this model was looked for: the newer choice has its own call.
  if (modelSelect.value !== model) return false;
  // Missing -> auto-download. Don't persist until success.
  const ok = await downloadCurrentModel();
  if (ok) {
    try {
      await saveSettings();
    } finally {
      await downloadSettled();
    }
    lastSavedModel = currentSettings.whisperModel;
    await refreshModelStatusUI();
    await renderUnusedModels();
  } else if (modelSelect.value === model) {
    // Revert dropdown to last working choice (unless the user has chosen
    // another model since: the list is free again once the download ended).
    modelSelect.value = previousSaved;
    verifiedModel = previousSaved;
    await refreshModelStatusUI();
  }
  return ok;
}
modelSelect.addEventListener("change", () => void chooseModel());

downloadBtn.addEventListener("click", async () => {
  if (!settingsLoaded) return;
  if (await downloadCurrentModel()) await downloadSettled();
});

groqKey.addEventListener("change", () => saveSettings());
// The notice above the fold follows the field as it is typed in.
groqKey.addEventListener("input", renderCloudNote);

modeToggle.addEventListener("click", () => {
  setRecordingMode("toggle");
  saveSettings();
});

modePtt.addEventListener("click", () => {
  setRecordingMode("push-to-talk");
  saveSettings();
});

// The start, stop and discard sounds of a dictation (the status itself is
// src/status-view.ts).
let prevRecordingState = "Ready";
listen<string>("recording-state", (event) => {
  const state = event.payload;
  if (state === "Recording") {
    if (prevRecordingState !== "Recording") playStart();
  } else if (state === "Transcribing") {
    if (prevRecordingState === "Recording") playStop();
  } else {
    // Recording -> Ready (no Transcribing in between) means cancel/discard
    if (prevRecordingState === "Recording") playDiscard();
  }
  prevRecordingState = state;
});

// Listen for download progress
listen<DownloadProgress>("download-progress", (event) => {
  // The bar, and always the numbers too: percent and size. The bar is what a
  // screen reader asks for them; nothing here is read out by itself.
  showProgress(speechProgress, event.payload);
  if (downloadInFlight) setDownload("speech", event.payload.percent);
});

// Hotkeys. "dictation" starts/stops recording, "pasteLast" pastes the last
// transcript again, "rewriteLast" selects it and records an edit, "freeGpu"
// unloads the models or loads them again, "meeting" starts or stops a
// meeting. Each takes a key combination or a mouse side button (with or
// without modifiers); the capture itself is in hotkey-capture.ts, shared with
// the Soundboard.
type HotkeyTarget = "dictation" | "pasteLast" | "rewriteLast" | "freeGpu" | "meeting";

/** A place that shows a hotkey and sets it when it is clicked. */
interface HotkeyView {
  target: HotkeyTarget;
  btn: HTMLButtonElement;
  text: HTMLElement;
  /** "Turn off" (in Settings; the dictation hotkey has none). */
  clear: HTMLButtonElement | null;
}

/** The view made of `<prefix>-btn`, `<prefix>-text` and, if there is one, `<prefix>-clear`. */
function hotkeyView(target: HotkeyTarget, prefix: string): HotkeyView {
  return {
    target,
    btn: document.getElementById(`${prefix}-btn`) as HTMLButtonElement,
    text: document.getElementById(`${prefix}-text`)!,
    clear: document.getElementById(`${prefix}-clear`) as HTMLButtonElement | null,
  };
}

const hotkeyViews: HotkeyView[] = [
  // Settings > Dictation
  hotkeyView("dictation", "hotkey"),
  hotkeyView("pasteLast", "paste-last"),
  hotkeyView("rewriteLast", "rewrite-last"),
  hotkeyView("freeGpu", "free-gpu"),
  hotkeyView("meeting", "meeting-hotkey"),
  // Home
  hotkeyView("dictation", "home-hotkey"),
  hotkeyView("pasteLast", "home-paste-last"),
  hotkeyView("rewriteLast", "home-rewrite-last"),
  hotkeyView("freeGpu", "home-free-gpu"),
  // The first run's step 3
  hotkeyView("dictation", "setup-hotkey"),
];

function hotkeyOf(target: HotkeyTarget): string {
  if (!currentSettings) return "";
  if (target === "dictation") return currentSettings.hotkey;
  if (target === "pasteLast") return currentSettings.pasteLastHotkey;
  if (target === "rewriteLast") return currentSettings.rewriteLastHotkey;
  if (target === "meeting") return currentSettings.meetingHotkey;
  return currentSettings.freeGpuHotkey;
}

/** Every place that shows a hotkey, from the settings. */
function renderHotkeys() {
  if (!currentSettings) return;
  for (const view of hotkeyViews) {
    const combo = hotkeyOf(view.target);
    // A key that is not set is a key box that says "Not set", in every place
    // (Home, Settings, a sound's tile): one form, in quieter words (components.css).
    view.text.textContent = hotkeyLabel(combo);
    view.btn.classList.toggle("key-unset", !combo);
    // The × keeps its room while there is nothing to turn off, so every key box ends on one edge (styles/settings.css).
    view.clear?.classList.toggle("unset", !combo);
  }
  renderHome();
}

/** The setting a hotkey is kept in. */
const HOTKEY_SETTING = { dictation: "hotkey", pasteLast: "pasteLastHotkey", rewriteLast: "rewriteLastHotkey", meeting: "meetingHotkey", freeGpu: "freeGpuHotkey" } as const;

async function setHotkey(target: HotkeyTarget, combo: string) {
  if (!settingsLoaded) throw new Error("the settings are not loaded yet");
  await invoke("change_hotkey", { target, newHotkey: combo });
  // Kept in step with the backend's copy: the next save_settings sends these
  // settings back whole. Also the copy of what is saved: a save that is
  // refused puts the controls back on that one, and must not bring an old key with it.
  currentSettings[HOTKEY_SETTING[target]] = combo;
  if (savedSettings) savedSettings[HOTKEY_SETTING[target]] = combo;
}

for (const view of hotkeyViews) {
  // A click on the key listens for the new one, in place.
  view.btn.addEventListener("click", () => {
    if (!settingsLoaded) return;
    startCapture({ button: view.btn, text: view.text, apply: (combo) => setHotkey(view.target, combo), render: renderHotkeys });
  });
  view.clear?.addEventListener("click", async () => {
    if (!settingsLoaded) return;
    try {
      await setHotkey(view.target, "");
    } catch (err) {
      console.error(`turning the ${view.target} hotkey off failed:`, err);
    }
    renderHotkeys();
  });
}

// Credit link -> opens 0ggi.ch in default browser
document.getElementById("credit-link")?.addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    await openExternal("https://0ggi.ch");
  } catch (err) {
    console.error("Failed to open URL:", err);
  }
});

const loaded = () => settingsLoaded;
// The AI's state is part of the status, and Home shows both.
initAiSettings({ settings: () => currentSettings, loaded, save: saveSettings, saveStrict, changed: renderStatus });
// How many dictations there are decides what Home shows and where the window opens.
initHistory({ mode: () => historyModeSelect.value, openSetting: () => reveal("history-mode-select"), changed: historyChanged });
initReplacements({ replacements: () => currentSettings?.replacements ?? [], loaded, save: saveSettings, saveStrict });
initDictionary({ settings: () => currentSettings, loaded, save: saveSettings, saveStrict });
initFiles({
  settings: () => currentSettings,
  saveSettings: savePatch,
  showSection: () => go("files"),
  // A file dropped before the settings are read finds no language to transcribe in.
  acceptsDrops: () => settingsLoaded && currentRoute().section !== "soundboard",
});

/** Home's two views, as far as this module's own answers go (the AI's card is Home's own). */
const firstSetup = () => setup({ speech: currentSpeech(), microphones: micsListed ? mics.length : null, history: historyCount(), aiDownloaded: true, aiDismissed: true });

// Home is where the window opens for a first run (no speech model and an
// empty history: the steps are there). Everyone else finds the window where
// they left it, also with a microphone that is unplugged today. Decided
// once, when the speech model's state, the microphones and the history are known.
let startDecided = false;
function decideStart() {
  if (startDecided) return;
  const now = firstSetup();
  if (!now.known) return;
  startDecided = true;
  startOn(now.firstRun);
}
onStatus(decideStart);

function historyChanged() {
  decideStart();
  renderHome();
}

function startHome() {
  initHome({
    loaded,
    history: historyCount,
    recordingMode: () => currentSettings.recordingMode,
    dictationKey: () => hotkeyLabel(currentSettings.hotkey),
    microphones: () => (micsListed ? mics.length : null),
    findMicrophones: listMicrophones,
    microphone: () => savedMicrophone,
    speechFailure: () => (downloadFailed === null ? null : { model: downloadFailed, reason: downloadReason }),
    ai: aiSummary,
    aiModel: aiModelInfo,
    addWords,
    // The Settings dropdown's own way: it downloads a model that is missing and saves the choice.
    setUpSpeech: async (id) => {
      // A download runs: the dropdown stays on its model (chooseModel's own guard comes after the dropdown is set).
      if (downloadInFlight) return false;
      modelSelect.value = id;
      return chooseModel();
    },
    setUpAi,
  });
}

// Initialize
getVersion()
  .then((v) => (document.getElementById("version-text")!.textContent = `v${v}`))
  .catch(console.error);
// The tray's Quit while a meeting records asks in this window: the question
// is listened for from the start, on every page.
initMeetingQuit();

// The start. Home and the status are wired at once (a form has its handler
// before anyone can press Enter in it; Home shows its heading alone until
// it knows more), and everything the start asks the backend is asked
// together: the settings, the microphones, the history, the AI's state, the
// status's four questions, the graphics cards. Before, they were asked one
// after the other, and Home was wired after the eighth answer. What an
// answer draws that is made of the settings or their language is drawn when
// both are there (showSettings draws from what is known).
const quietly = (what: string, asked: Promise<unknown>) => asked.catch((err) => console.error(`${what} failed:`, err));
startHome();
const statusKnown = quietly("the status's first questions", initStatus({ microphones: () => (micsListed ? mics.length : null), ai: aiActivity }));
const settingsRead = loadSettings().then(
  () => true,
  (err) => {
    // The pages made of settings stay at rest: nothing can be changed, and so nothing wrong is saved. Said in the page.
    console.error("loading the settings failed:", err);
    sayNotice(t("settings_load_failed").replace("{reason}", () => String(err)));
    return false;
  },
);
void refreshDetectedGpus();
stateOnce<boolean, boolean>("game_free_state", "game-free")
  .then((state) => showGameFree(state.later()?.payload ?? state.answer))
  .catch(console.error);
// The Meetings page reads the settings, so it starts once they are loaded.
// It starts without them too (a meeting can record from the tray or the
// hotkey, and the page must show it): then with the reminders' defaults, and
// nothing is saved over the settings that did not load.
const meetingsWired = settingsRead.then(() =>
  quietly(
    "the Meetings page's start",
    initMeetings({
      settings: () => currentSettings ?? { meetingReminderOff: false, meetingHeadphonesSeen: false },
      saveSettings: savePatch,
      showSection: () => go("meetings"),
    }),
  ),
);
void Promise.all([
  statusKnown,
  quietly("listing the microphones", listMicrophones()),
  quietly("reading the history", refreshHistory()),
  quietly("asking for the AI's state", refreshAiStatus()),
  // Which models are on disk, and the unused ones: their rows name the chosen model.
  settingsRead.then((read) => (read ? quietly("looking for the speech models", refreshModelStatusUI()) : undefined)),
  settingsRead.then(() => renderUnusedModels()),
  meetingsWired,
]).then(() => {
  // Every page is wired: tell them the place the window starts on (a remembered one makes no change).
  announceRoute();
  // The start is over (tools/ui-check waits for this).
  document.body.dataset.started = "true";
});
