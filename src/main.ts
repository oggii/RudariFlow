import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { setLang, getLang, detectDefaultLang, t } from "./i18n";
import { populateLanguageSelect } from "./languages";
import { aiActivity, aiModelInfo, aiSummary, initAiSettings, renderAiSettings, setUpAi, type AppRule } from "./ai-settings";
import { addWords, initDictionary, renderDictionary } from "./dictionary";
import { initHistory, refreshHistory } from "./history";
import { initHome, renderHome } from "./home";
import { initFiles, renderFiles } from "./files";
import { initMeetingQuit, initMeetings, renderMeetings } from "./meetings";
import { playStart, playStop, playDiscard, setVolume } from "./sounds";
import { hotkeyLabel, startCapture } from "./hotkey-capture";
import { mountBoard } from "./soundboard/board";
import { announceRoute, currentRoute, go, initShell, onRoute, reveal, startOn } from "./shell";
import { downloadFailure, NOT_STARTED, showProgress, type DownloadProgress } from "./progress";
import { modelToSave } from "./models.ts";
import { setDownload } from "./activity";
import { currentSpeech, initStatus, onStatus, refreshSpeech, renderStatus } from "./status-view";
import { setup } from "./setup.ts";
import { initHints, nameRows } from "./rows";
import { deleteButton, repaintDeletes } from "./confirm-delete";
import { initReplacements, readReplacements, renderReplacements, type Replacement } from "./replacements";
import { modelLabel, speechModel } from "./models.ts";

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
// The Soundboard tab; the same component runs in the pop-out window.
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
  add("default", systemDefault ? `${t("mic_system_default")} (${systemDefault.name})` : t("mic_system_default"));
  for (const mic of mics) add(mic.name, mic.name);
  if (saved !== "default" && !mics.some((m) => m.name === saved)) {
    add(saved, `${saved} (${t("mic_not_connected")})`);
    // Home tints its microphone line for it.
    (micSelect.lastElementChild as HTMLOptionElement).dataset.missing = "true";
  }
  micSelect.value = saved;
}

/** The microphones Windows has now; the dropdown and the status follow. */
async function listMicrophones() {
  mics = await invoke<MicDevice[]>("list_microphones");
  micsListed = true;
  renderMicOptions();
  renderStatus();
}
// A microphone plugged in while the window was away (the first run waits for
// one). Only while none is listed: asking holds the backend up for a moment
// and draws the dropdown again, also under an open one. And not before the
// settings are loaded, which list the microphones themselves.
window.addEventListener("focus", () => {
  if (!currentSettings || !micsListed || mics.length > 0) return;
  void listMicrophones().catch(console.error);
});

async function loadSettings() {
  currentSettings = await invoke<Settings>("get_settings");
  savedMicrophone = currentSettings.microphone || "default";

  // UI language: auto-detect on first launch (empty string), otherwise use saved
  if (!currentSettings.uiLanguage) {
    currentSettings.uiLanguage = detectDefaultLang();
    await invoke("save_settings", { settings: currentSettings });
  }
  uiLanguageSelect.value = currentSettings.uiLanguage;
  setLang(currentSettings.uiLanguage);
  nameRows();
  populateLanguageSelect(languageSelect, getLang(), t("language_auto"));

  // Volume
  volumeSlider.value = String(currentSettings.volume);
  setVolume(currentSettings.volume);

  // Autostart
  autostartToggle.checked = currentSettings.autostart;

  // Populate mic dropdown
  await listMicrophones();

  // Groq key, before the engine: the cloud engine's notice reads the field
  // (set after it, the notice warned of a missing key for a moment at every start).
  groqKey.value = currentSettings.groqApiKey;

  // Engine
  setEngine(currentSettings.engine);

  // Model
  modelSelect.value = currentSettings.whisperModel;
  lastSavedModel = currentSettings.whisperModel;
  verifiedModel = currentSettings.whisperModel;
  await refreshModelStatusUI();

  // Language
  languageSelect.value = currentSettings.language;

  // GPU backend
  gpuBackendSelect.value = currentSettings.gpuBackend || "auto";
  refreshDetectedGpus();

  // GPU management
  gameFreeToggle.checked = currentSettings.freeGpuForGames ?? false;
  idleUnloadSelect.value = String(currentSettings.idleUnloadMinutes ?? 0);
  invoke<boolean>("game_free_state").then(showGameFree).catch(console.error);
  void renderUnusedModels();
  renderDictionary();
  renderFiles();
  void soundboard.refresh();

  // Recording mode
  setRecordingMode(currentSettings.recordingMode);

  // Hotkeys
  renderHotkeys();

  // Send command, mute, replacements, history
  sendCommandSelect.value = currentSettings.sendCommand || "off";
  muteAudioToggle.checked = currentSettings.muteAudio;
  renderReplacements();
  historyModeSelect.value = currentSettings.history || "audio";
  await refreshHistory();
  await renderAiSettings();
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

async function refreshDetectedGpus() {
  try {
    detectedGpus = await invoke<GpuDevice[]>("detect_gpus");
    renderDetectedGpus();
  } catch (e) {
    console.error("detect_gpus failed:", e);
  }
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
    hint = t("gpu_hint_small").replace("{gb}", String(Math.round(vramGb)));
  }
  el.textContent = `${t("gpu_detected")}: ${list.join("; ")}. ${hint}`.trim();
}

/** A segmented choice: the chosen button is `active` and pressed. */
function choose(button: HTMLElement, on: boolean) {
  button.classList.toggle("active", on);
  button.setAttribute("aria-pressed", String(on));
}

function setEngine(engine: string) {
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
    modelNote.textContent = note ? t(note) : "";
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

/** "Large v3 Turbo q8 · 870 MB ✓": name, size, and a tick when it is downloaded. */
async function refreshModelDropdownLabels() {
  const opts = Array.from(modelSelect.options) as HTMLOptionElement[];
  await Promise.all(opts.map(async (o) => {
    const ok = await invoke<boolean>("check_model_downloaded", { modelSize: o.value });
    o.textContent = ok ? `${modelLabel(o.value)} \u2713` : modelLabel(o.value);
  }));
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

async function saveSettings() {
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
  const microphone = currentSettings.microphone;
  await invoke("save_settings", { settings: currentSettings });
  savedMicrophone = microphone;
}

// Event listeners
engineLocal.addEventListener("click", () => {
  setEngine("local");
  saveSettings();
});

engineCloud.addEventListener("click", () => {
  setEngine("cloud");
  saveSettings();
});

micSelect.addEventListener("change", async () => {
  await saveSettings();
  renderHome();
});

languageSelect.addEventListener("change", async () => {
  await saveSettings();
  await renderAiSettings();
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

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

const DELETE_ERRORS: Record<string, string> = {
  in_use: "unused_model_in_use",
  meeting_busy: "unused_model_meeting_busy",
  busy: "unused_model_busy",
};

/// One unused model as a list row: its file, what it is and its size, and Delete.
function unusedModelRow(m: ModelFile): HTMLElement {
  const row = document.createElement("div");
  row.className = "list-row unused-model-row";
  row.setAttribute("role", "listitem");
  const info = document.createElement("div");
  info.className = "list-main";
  const name = document.createElement("span");
  name.className = "list-primary unused-model-name";
  name.textContent = m.file;
  const meta = document.createElement("span");
  meta.className = "list-secondary";
  const parts = [t(m.kind === "ai" ? "unused_model_ai" : "unused_model_whisper")];
  if (m.partial) parts.push(t("unused_model_partial"));
  parts.push(m.otherLinks ? `${formatSize(m.bytes)} (${t("unused_model_links")})` : formatSize(m.bytes));
  meta.textContent = parts.join(" \u00b7 ");
  const error = document.createElement("span");
  error.className = "list-secondary unused-model-error hidden";
  error.setAttribute("role", "alert");
  info.append(name, meta, error);

  // While the file is deleted the button rests (src/confirm-delete.ts). A
  // delete that fails says why in the row, and the file stays in the list.
  const del = deleteButton(
    `model-${m.kind}-${m.file}`,
    async () => {
      error.classList.add("hidden");
      try {
        await invoke<number>("delete_unused_model", { kind: m.kind, file: m.file });
      } catch (err) {
        const code = String(err);
        const key = DELETE_ERRORS[code];
        error.textContent = key ? t(key) : t("unused_model_failed").replace("{error}", code);
        error.classList.remove("hidden");
        return;
      }
      await renderUnusedModels();
      if (m.kind === "ai") await renderAiSettings();
      else await refreshModelDropdownLabels();
    },
    // After the last file the sentence that says so takes the focus.
    { name: m.file, after: () => unusedModelEmpty },
  );
  const actions = document.createElement("div");
  actions.className = "list-actions";
  actions.append(del);
  row.append(info, actions);
  return row;
}

async function renderUnusedModels() {
  let files: ModelFile[] = [];
  try {
    files = await invoke<ModelFile[]>("unused_models");
  } catch (err) {
    console.error("unused_models failed:", err);
  }
  unusedModelList.innerHTML = "";
  for (const m of files) unusedModelList.appendChild(unusedModelRow(m));
  unusedModelEmpty.classList.toggle("hidden", files.length > 0);
}

// PC check: measures, applies the fastest Whisper setup, shows a report.
interface PcCheckResult {
  report: string;
  gpuBackend: string;
  whisperFlashAttn: string;
  changed: boolean;
}
listen<[number, number, string]>("pc-check-progress", (event) => {
  const [done, total] = event.payload;
  if (pcCheckBtn.disabled) {
    pcCheckBtn.textContent = t("pc_check_running").replace("{done}", String(Math.min(done + 1, total))).replace("{total}", String(total));
  }
});
pcCheckBtn.addEventListener("click", async () => {
  pcCheckBtn.disabled = true;
  pcCheckBtn.textContent = t("pc_check_running").replace("{done}", "1").replace("{total}", "…");
  try {
    const result = await invoke<PcCheckResult>("pc_check");
    // The check saved new settings; keep the page's copy in step.
    currentSettings.gpuBackend = result.gpuBackend;
    currentSettings.whisperFlashAttn = result.whisperFlashAttn;
    gpuBackendSelect.value = result.gpuBackend;
    pcCheckReport.textContent = result.report;
    pcCheckResult.classList.remove("hidden");
  } catch (err) {
    // "meeting_busy": a meeting records or runs its end steps.
    pcCheckReport.textContent = String(err) === "meeting_busy" ? t("pc_check_meeting_busy") : `${t("pc_check_failed")}: ${err}`;
    pcCheckResult.classList.remove("hidden");
  } finally {
    pcCheckBtn.disabled = false;
    pcCheckBtn.textContent = t("pc_check_run");
  }
});
pcCheckCopy.addEventListener("click", async () => {
  await invoke("copy_text", { text: pcCheckReport.textContent ?? "" });
  pcCheckCopy.textContent = t("pc_check_copied");
  setTimeout(() => (pcCheckCopy.textContent = t("pc_check_copy")), 1500);
});

uiLanguageSelect.addEventListener("change", async () => {
  setLang(uiLanguageSelect.value);
  populateLanguageSelect(languageSelect, getLang(), t("language_auto"));
  nameRows();
  renderMicOptions();
  renderHotkeys();
  renderDetectedGpus();
  renderCloudNote();
  // What a screen reader was told of the last download is in the old language; the row's note is drawn again below.
  downloadLive.textContent = "";
  await refreshModelStatusUI();
  await saveSettings();
  await refreshHistory();
  await renderAiSettings();
  await renderUnusedModels();
  renderDictionary();
  renderFiles();
  void soundboard.refresh();
  void renderMeetings();
  renderReplacements();
  repaintDeletes();
  renderStatus();
});

sendCommandSelect.addEventListener("change", () => saveSettings());
muteAudioToggle.addEventListener("change", () => saveSettings());
historyModeSelect.addEventListener("change", async () => {
  await saveSettings();
  await refreshHistory();
});

volumeSlider.addEventListener("input", () => {
  setVolume(parseFloat(volumeSlider.value));
});
volumeSlider.addEventListener("change", () => saveSettings());

autostartToggle.addEventListener("change", async () => {
  try {
    await invoke("set_autostart", { enabled: autostartToggle.checked });
    await saveSettings();
  } catch (e) {
    console.error("Failed to toggle autostart:", e);
    // Revert on failure
    autostartToggle.checked = !autostartToggle.checked;
  }
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
  /** On Home a key that is not set reads "Not set · Set". */
  home: boolean;
}

/** The view made of `<prefix>-btn`, `<prefix>-text` and, if there is one, `<prefix>-clear`. */
function hotkeyView(target: HotkeyTarget, prefix: string, home = false): HotkeyView {
  return {
    target,
    btn: document.getElementById(`${prefix}-btn`) as HTMLButtonElement,
    text: document.getElementById(`${prefix}-text`)!,
    clear: document.getElementById(`${prefix}-clear`) as HTMLButtonElement | null,
    home,
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
  hotkeyView("dictation", "home-hotkey", true),
  hotkeyView("pasteLast", "home-paste-last", true),
  hotkeyView("rewriteLast", "home-rewrite-last", true),
  hotkeyView("freeGpu", "home-free-gpu", true),
  // The first run's step 3
  hotkeyView("dictation", "setup-hotkey"),
];

function hotkeyOf(target: HotkeyTarget): string {
  if (target === "dictation") return currentSettings.hotkey;
  if (target === "pasteLast") return currentSettings.pasteLastHotkey;
  if (target === "rewriteLast") return currentSettings.rewriteLastHotkey;
  if (target === "meeting") return currentSettings.meetingHotkey;
  return currentSettings.freeGpuHotkey;
}

/** Every place that shows a hotkey, from the settings. */
function renderHotkeys() {
  for (const view of hotkeyViews) {
    const combo = hotkeyOf(view.target);
    const unset = view.home && !combo;
    if (unset) {
      // "Not set · Set": the second part is what a click does, and only it is underlined.
      const [state, act = ""] = t("home_key_unset").split(" · ");
      const set = document.createElement("span");
      set.className = "key-set";
      set.textContent = act;
      view.text.replaceChildren(`${state} · `, set);
    } else {
      view.text.textContent = hotkeyLabel(combo);
    }
    view.btn.classList.toggle("key-unset", unset);
    // The × keeps its room while there is nothing to turn off, so every key box ends on one edge (styles/settings.css).
    view.clear?.classList.toggle("unset", !combo);
  }
  renderHome();
}

async function setHotkey(target: HotkeyTarget, combo: string) {
  await invoke("change_hotkey", { target, newHotkey: combo });
  if (target === "dictation") currentSettings.hotkey = combo;
  else if (target === "pasteLast") currentSettings.pasteLastHotkey = combo;
  else if (target === "rewriteLast") currentSettings.rewriteLastHotkey = combo;
  // Kept in step with the backend's copy: the next save_settings sends
  // these settings back whole.
  else if (target === "meeting") currentSettings.meetingHotkey = combo;
  else currentSettings.freeGpuHotkey = combo;
}

for (const view of hotkeyViews) {
  // A click on the key listens for the new one, in place.
  view.btn.addEventListener("click", () => {
    startCapture({ button: view.btn, text: view.text, apply: (combo) => setHotkey(view.target, combo), render: renderHotkeys });
  });
  view.clear?.addEventListener("click", async () => {
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

// The AI's state is part of the status, and Home shows both.
initAiSettings({ settings: () => currentSettings, save: saveSettings, changed: renderStatus });
initHistory({ mode: () => historyModeSelect.value });
initReplacements({ replacements: () => currentSettings.replacements, save: saveSettings });
initDictionary({ settings: () => currentSettings, save: saveSettings });
initFiles({
  settings: () => currentSettings,
  saveSettings: async (patch) => {
    Object.assign(currentSettings, patch);
    await invoke("save_settings", { settings: currentSettings });
  },
  showSection: () => go("files"),
  acceptsDrops: () => currentRoute().section !== "soundboard",
});

// Home is where the window opens while the setup is not done: decided once,
// when the first status is known.
let startDecided = false;
onStatus(() => {
  const speech = currentSpeech();
  if (startDecided || !speech || !micsListed) return;
  startDecided = true;
  startOn(setup({ speech, microphones: mics.length, aiDownloaded: true, aiDismissed: true }).needed);
});

function startHome() {
  initHome({
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
// is listened for from the start, on every tab.
initMeetingQuit();
// The Meetings tab reads the settings, so it starts once they are loaded.
// It starts without them too (a meeting can record from the tray or the
// hotkey, and the tab must show it): then with the reminders' defaults, and
// nothing is saved over the settings that did not load.
loadSettings()
  .catch((err) => console.error("loading the settings failed:", err))
  .then(() => initStatus({ microphones: () => (micsListed ? mics.length : null), ai: aiActivity }))
  .then(startHome)
  .catch((err) => console.error("the status or Home did not start:", err))
  .then(() =>
    initMeetings({
      settings: () => currentSettings ?? { meetingReminderOff: false, meetingHeadphonesSeen: false },
      saveSettings: async (patch) => {
        if (!currentSettings) return;
        Object.assign(currentSettings, patch);
        await invoke("save_settings", { settings: currentSettings });
      },
      showSection: () => go("meetings"),
    }),
  )
  .catch((err) => console.error("the Meetings tab did not start:", err))
  // Every page is wired: tell them the place the window starts on (a remembered one makes no change).
  .then(announceRoute);
