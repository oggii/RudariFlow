import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { setLang, getLang, detectDefaultLang, t } from "./i18n";
import { populateLanguageSelect } from "./languages";
import { aiActivity, initAiSettings, renderAiSettings, type AppRule } from "./ai-settings";
import { initDictionary, renderDictionary } from "./dictionary";
import { initFiles, renderFiles } from "./files";
import { initMeetingQuit, initMeetings, renderMeetings } from "./meetings";
import { playStart, playStop, playDiscard, setVolume } from "./sounds";
import { hotkeyLabel, startCapture } from "./hotkey-capture";
import { mountBoard } from "./soundboard/board";
import { announceRoute, currentRoute, go, initShell, onRoute, startOn } from "./shell";
import { setDownload } from "./activity";
import { currentSpeech, initStatus, onStatus, renderStatus } from "./status-view";
import { setup } from "./setup.ts";

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

interface Replacement {
  from: string;
  to: string;
}

interface HistoryEntry {
  id: number;
  text: string;
  durationMs: number;
  model: string;
  hasAudio: boolean;
  /** Text before AI cleanup, when the AI changed it. */
  raw?: string | null;
  /** Program the dictation went into, e.g. "whatsapp.root". */
  app?: string;
  /** What was said in Edit mode; `raw` then holds the selected text. */
  edit?: string | null;
}

interface MicDevice {
  name: string;
  is_default: boolean;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
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
const groqKey = document.getElementById("groq-key") as HTMLInputElement;
const modeToggle = document.getElementById("mode-toggle")!;
const modePtt = document.getElementById("mode-ptt")!;
const hotkeyText = document.getElementById("hotkey-text")!;
const hotkeyBtn = document.getElementById("hotkey-btn") as HTMLButtonElement;
const pasteLastBtn = document.getElementById("paste-last-btn") as HTMLButtonElement;
const pasteLastText = document.getElementById("paste-last-text")!;
const pasteLastClear = document.getElementById("paste-last-clear") as HTMLButtonElement;
const pcCheckBtn = document.getElementById("pc-check-btn") as HTMLButtonElement;
const pcCheckResult = document.getElementById("pc-check-result")!;
const pcCheckReport = document.getElementById("pc-check-report")!;
const pcCheckCopy = document.getElementById("pc-check-copy") as HTMLButtonElement;
const rewriteLastBtn = document.getElementById("rewrite-last-btn") as HTMLButtonElement;
const rewriteLastText = document.getElementById("rewrite-last-text")!;
const rewriteLastClear = document.getElementById("rewrite-last-clear") as HTMLButtonElement;
const freeGpuBtn = document.getElementById("free-gpu-btn") as HTMLButtonElement;
const freeGpuText = document.getElementById("free-gpu-text")!;
const freeGpuClear = document.getElementById("free-gpu-clear") as HTMLButtonElement;
const meetingHotkeyBtn = document.getElementById("meeting-hotkey-btn") as HTMLButtonElement;
const meetingHotkeyText = document.getElementById("meeting-hotkey-text")!;
const meetingHotkeyClear = document.getElementById("meeting-hotkey-clear") as HTMLButtonElement;
const sendCommandSelect = document.getElementById("send-command-select") as HTMLSelectElement;
const muteAudioToggle = document.getElementById("mute-audio-toggle") as HTMLInputElement;
const gameFreeToggle = document.getElementById("game-free-toggle") as HTMLInputElement;
const gameFreeStatus = document.getElementById("game-free-status")!;
const idleUnloadSelect = document.getElementById("idle-unload-select") as HTMLSelectElement;
const unusedModelList = document.getElementById("unused-model-list")!;
const unusedModelEmpty = document.getElementById("unused-model-empty")!;
const replacementList = document.getElementById("replacement-list")!;
const replacementEmpty = document.getElementById("replacement-empty")!;
const replacementAdd = document.getElementById("replacement-add") as HTMLButtonElement;
const historyModeSelect = document.getElementById("history-mode-select") as HTMLSelectElement;
const historyList = document.getElementById("history-list")!;
const historyEmpty = document.getElementById("history-empty")!;
const historyCount = document.getElementById("history-count")!;
const historyClear = document.getElementById("history-clear") as HTMLButtonElement;
// The Soundboard tab; the same component runs in the pop-out window.
const soundboard = mountBoard(document.getElementById("sb-root")!, { popOut: false });

// Sections and Settings tabs (src/shell.ts); what a page needs when it is shown.
initShell();
onRoute((now) => {
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
  }
  micSelect.value = saved;
}

async function loadSettings() {
  currentSettings = await invoke<Settings>("get_settings");

  // UI language: auto-detect on first launch (empty string), otherwise use saved
  if (!currentSettings.uiLanguage) {
    currentSettings.uiLanguage = detectDefaultLang();
    await invoke("save_settings", { settings: currentSettings });
  }
  uiLanguageSelect.value = currentSettings.uiLanguage;
  setLang(currentSettings.uiLanguage);
  populateLanguageSelect(languageSelect, getLang(), t("language_auto"));

  // Volume
  volumeSlider.value = String(currentSettings.volume);
  setVolume(currentSettings.volume);

  // Autostart
  autostartToggle.checked = currentSettings.autostart;

  // Populate mic dropdown
  mics = await invoke<MicDevice[]>("list_microphones");
  micsListed = true;
  renderMicOptions();

  // Engine
  setEngine(currentSettings.engine);

  // Model
  modelSelect.value = currentSettings.whisperModel;
  lastSavedModel = currentSettings.whisperModel;
  await refreshModelStatusUI();

  // Language
  languageSelect.value = currentSettings.language;

  // GPU backend
  gpuBackendSelect.value = currentSettings.gpuBackend || "auto";
  refreshDetectedGpus();

  // Groq key
  groqKey.value = currentSettings.groqApiKey;

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

async function refreshDetectedGpus() {
  const el = document.getElementById("gpu-detected")!;
  try {
    const gpus = await invoke<GpuDevice[]>("detect_gpus");
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
  } catch (e) {
    console.error("detect_gpus failed:", e);
  }
}

function setEngine(engine: string) {
  currentSettings.engine = engine;
  engineLocal.classList.toggle("active", engine === "local");
  engineCloud.classList.toggle("active", engine === "cloud");
  localSettings.classList.toggle("hidden", engine !== "local");
  cloudSettings.classList.toggle("hidden", engine !== "cloud");
}

function setRecordingMode(mode: string) {
  currentSettings.recordingMode = mode;
  modeToggle.classList.toggle("active", mode === "toggle");
  modePtt.classList.toggle("active", mode === "push-to-talk");
}

async function isCurrentModelDownloaded(): Promise<boolean> {
  return await invoke<boolean>("check_model_downloaded", {
    modelSize: modelSelect.value,
  });
}

async function refreshModelStatusUI() {
  const downloaded = await isCurrentModelDownloaded();
  if (downloaded) {
    downloadBtn.textContent = "\u2713";
    downloadBtn.removeAttribute("data-i18n");
  } else {
    downloadBtn.setAttribute("data-i18n", "download");
    downloadBtn.textContent = t("download");
  }
  (downloadBtn as HTMLButtonElement).disabled = downloaded;
  await refreshModelDropdownLabels();
}

async function refreshModelDropdownLabels() {
  const opts = Array.from(modelSelect.options) as HTMLOptionElement[];
  await Promise.all(opts.map(async (o) => {
    const ok = await invoke<boolean>("check_model_downloaded", { modelSize: o.value });
    const key = o.getAttribute("data-i18n");
    const base = key ? t(key) : (o.dataset.baseText ?? o.textContent ?? "");
    if (!o.dataset.baseText) o.dataset.baseText = base;
    o.textContent = ok ? `${base} \u2713` : base;
  }));
}

let downloadInFlight = false;
async function downloadCurrentModel(): Promise<boolean> {
  if (downloadInFlight) return false;
  downloadInFlight = true;
  (downloadBtn as HTMLButtonElement).disabled = true;
  modelSelect.disabled = true;
  downloadProgress.classList.remove("hidden");
  progressFill.style.width = "0%";
  setDownload("speech", 0);
  try {
    await invoke("download_model", { modelSize: modelSelect.value });
    downloadBtn.textContent = "\u2713";
    downloadBtn.removeAttribute("data-i18n");
    return true;
  } catch (e) {
    downloadBtn.setAttribute("data-i18n", "retry");
    downloadBtn.textContent = t("retry");
    (downloadBtn as HTMLButtonElement).disabled = false;
    console.error("Download failed:", e);
    return false;
  } finally {
    setDownload("speech", null);
    downloadProgress.classList.add("hidden");
    modelSelect.disabled = false;
    downloadInFlight = false;
    await refreshModelDropdownLabels();
  }
}

async function saveSettings() {
  currentSettings.microphone = micSelect.value;
  currentSettings.whisperModel = modelSelect.value;
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
  await invoke("save_settings", { settings: currentSettings });
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

micSelect.addEventListener("change", () => saveSettings());

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

/// One unused model with a Delete button that asks once more (click again
/// within 3 s, like Clear history).
function unusedModelRow(m: ModelFile): HTMLElement {
  const row = document.createElement("div");
  row.className = "unused-model-row";
  const info = document.createElement("div");
  info.className = "unused-model-info";
  const name = document.createElement("span");
  name.className = "unused-model-name";
  name.textContent = m.file;
  const meta = document.createElement("span");
  meta.className = "label-hint";
  const parts = [t(m.kind === "ai" ? "unused_model_ai" : "unused_model_whisper")];
  if (m.partial) parts.push(t("unused_model_partial"));
  parts.push(m.otherLinks ? `${formatSize(m.bytes)} (${t("unused_model_links")})` : formatSize(m.bytes));
  meta.textContent = parts.join(" \u00b7 ");
  const error = document.createElement("span");
  error.className = "label-hint unused-model-error hidden";
  info.append(name, meta, error);

  const del = document.createElement("button");
  del.className = "btn-secondary";
  del.textContent = t("unused_model_delete");
  let armed: number | undefined;
  const disarm = () => {
    window.clearTimeout(armed);
    armed = undefined;
    del.classList.remove("armed");
    del.textContent = t("unused_model_delete");
  };
  del.addEventListener("click", async () => {
    if (armed === undefined) {
      del.classList.add("armed");
      // With other links nothing is freed: no size is promised.
      del.textContent = m.otherLinks
        ? t("unused_model_confirm_plain")
        : t("unused_model_confirm").replace("{size}", formatSize(m.bytes));
      armed = window.setTimeout(disarm, 3000);
      return;
    }
    disarm();
    del.disabled = true;
    try {
      await invoke<number>("delete_unused_model", { kind: m.kind, file: m.file });
      await renderUnusedModels();
      if (m.kind === "ai") await renderAiSettings();
      else await refreshModelDropdownLabels();
    } catch (err) {
      const code = String(err);
      const key = DELETE_ERRORS[code];
      error.textContent = key ? t(key) : t("unused_model_failed").replace("{error}", code);
      error.classList.remove("hidden");
      del.disabled = false;
    }
  });
  row.append(info, del);
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
  renderMicOptions();
  renderHotkeys();
  await saveSettings();
  await refreshHistory();
  await renderAiSettings();
  await renderUnusedModels();
  renderDictionary();
  renderFiles();
  void soundboard.refresh();
  void renderMeetings();
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
modelSelect.addEventListener("change", async () => {
  const chosen = modelSelect.value;
  const previousSaved = lastSavedModel || currentSettings.whisperModel;
  if (await isCurrentModelDownloaded()) {
    await refreshModelStatusUI();
    await saveSettings();
    lastSavedModel = chosen;
    await renderUnusedModels();
    return;
  }
  // Missing -> auto-download. Don't persist until success.
  const ok = await downloadCurrentModel();
  if (ok) {
    await saveSettings();
    lastSavedModel = chosen;
    await refreshModelStatusUI();
    await renderUnusedModels();
  } else {
    // Revert dropdown to last working choice
    modelSelect.value = previousSaved;
    await refreshModelStatusUI();
  }
});

downloadBtn.addEventListener("click", async () => {
  await downloadCurrentModel();
});

groqKey.addEventListener("change", () => saveSettings());

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
  const { percent } = event.payload;
  progressFill.style.width = `${percent}%`;
  if (downloadInFlight) setDownload("speech", percent);
});

// Hotkeys. "dictation" starts/stops recording, "pasteLast" pastes the last
// transcript again, "rewriteLast" selects it and records an edit, "freeGpu"
// unloads the models or loads them again, "meeting" starts or stops a
// meeting. Each takes a key combination or a mouse side button (with or
// without modifiers); the capture itself is in hotkey-capture.ts, shared with
// the Soundboard.
type HotkeyTarget = "dictation" | "pasteLast" | "rewriteLast" | "freeGpu" | "meeting";

function renderHotkeys() {
  hotkeyText.textContent = hotkeyLabel(currentSettings.hotkey);
  pasteLastText.textContent = hotkeyLabel(currentSettings.pasteLastHotkey);
  pasteLastClear.classList.toggle("hidden", !currentSettings.pasteLastHotkey);
  rewriteLastText.textContent = hotkeyLabel(currentSettings.rewriteLastHotkey);
  rewriteLastClear.classList.toggle("hidden", !currentSettings.rewriteLastHotkey);
  freeGpuText.textContent = hotkeyLabel(currentSettings.freeGpuHotkey);
  freeGpuClear.classList.toggle("hidden", !currentSettings.freeGpuHotkey);
  meetingHotkeyText.textContent = hotkeyLabel(currentSettings.meetingHotkey);
  meetingHotkeyClear.classList.toggle("hidden", !currentSettings.meetingHotkey);
}

function captureElements(target: HotkeyTarget) {
  if (target === "dictation") return { btn: hotkeyBtn, text: hotkeyText };
  if (target === "pasteLast") return { btn: pasteLastBtn, text: pasteLastText };
  if (target === "rewriteLast") return { btn: rewriteLastBtn, text: rewriteLastText };
  if (target === "meeting") return { btn: meetingHotkeyBtn, text: meetingHotkeyText };
  return { btn: freeGpuBtn, text: freeGpuText };
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

function capture(target: HotkeyTarget) {
  const { btn, text } = captureElements(target);
  startCapture({ button: btn, text, apply: (combo) => setHotkey(target, combo), render: renderHotkeys });
}

hotkeyBtn.addEventListener("click", () => capture("dictation"));
pasteLastBtn.addEventListener("click", () => capture("pasteLast"));
rewriteLastBtn.addEventListener("click", () => capture("rewriteLast"));
rewriteLastClear.addEventListener("click", async () => {
  try {
    await setHotkey("rewriteLast", "");
  } catch (err) {
    console.error("clearing rewrite hotkey failed:", err);
  }
  renderHotkeys();
});
pasteLastClear.addEventListener("click", async () => {
  try {
    await setHotkey("pasteLast", "");
  } catch (err) {
    console.error("clearing paste-last hotkey failed:", err);
  }
  renderHotkeys();
});
freeGpuBtn.addEventListener("click", () => capture("freeGpu"));
freeGpuClear.addEventListener("click", async () => {
  try {
    await setHotkey("freeGpu", "");
  } catch (err) {
    console.error("clearing free-GPU hotkey failed:", err);
  }
  renderHotkeys();
});
meetingHotkeyBtn.addEventListener("click", () => capture("meeting"));
meetingHotkeyClear.addEventListener("click", async () => {
  try {
    await setHotkey("meeting", "");
  } catch (err) {
    console.error("clearing the meeting hotkey failed:", err);
  }
  renderHotkeys();
});

// ── Replacements ──────────────────────────────────────

function renderReplacements() {
  replacementList.innerHTML = "";
  for (const r of currentSettings.replacements ?? []) addReplacementRow(r);
  replacementEmpty.classList.toggle("hidden", replacementList.children.length > 0);
}

function addReplacementRow(r: Replacement): HTMLElement {
  const row = document.createElement("div");
  row.className = "replacement-row";

  const from = document.createElement("input");
  from.type = "text";
  from.className = "replacement-from";
  from.value = r.from;
  from.placeholder = t("replacement_from_placeholder");
  from.spellcheck = false;

  const arrow = document.createElement("span");
  arrow.className = "replacement-arrow";
  arrow.textContent = "\u2192";

  const to = document.createElement("textarea");
  to.className = "replacement-to";
  to.rows = 1;
  to.value = r.to;
  to.placeholder = t("replacement_to_placeholder");
  to.spellcheck = false;

  const remove = document.createElement("button");
  remove.className = "icon-btn";
  remove.title = t("replacement_remove");
  remove.setAttribute("aria-label", t("replacement_remove"));
  remove.innerHTML =
    '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  remove.addEventListener("click", () => {
    row.remove();
    replacementEmpty.classList.toggle("hidden", replacementList.children.length > 0);
    saveSettings();
  });

  from.addEventListener("change", () => saveSettings());
  to.addEventListener("change", () => saveSettings());

  row.append(from, arrow, to, remove);
  replacementList.appendChild(row);
  return row;
}

function readReplacements(): Replacement[] {
  return Array.from(replacementList.querySelectorAll<HTMLElement>(".replacement-row")).map((row) => ({
    from: (row.querySelector(".replacement-from") as HTMLInputElement).value,
    to: (row.querySelector(".replacement-to") as HTMLTextAreaElement).value,
  }));
}

replacementAdd.addEventListener("click", () => {
  const row = addReplacementRow({ from: "", to: "" });
  replacementEmpty.classList.add("hidden");
  (row.querySelector(".replacement-from") as HTMLInputElement).focus();
});

// ── History ───────────────────────────────────────────

let playing: { audio: HTMLAudioElement; url: string; btn: HTMLButtonElement } | null = null;

function stopPlayback() {
  if (!playing) return;
  playing.audio.pause();
  URL.revokeObjectURL(playing.url);
  playing.btn.textContent = t("history_play");
  playing = null;
}

// Dates follow the system locale (24 h in Switzerland even with an English UI).
function formatWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

function formatDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function smallButton(label: string, onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "btn-ghost";
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
}

function renderHistoryEntry(e: HistoryEntry): HTMLElement {
  const item = document.createElement("article");
  item.className = "history-item";

  const text = document.createElement("p");
  text.className = "history-text";
  text.textContent = e.text;

  const footer = document.createElement("div");
  footer.className = "history-footer";
  const meta = document.createElement("span");
  meta.className = "history-meta";
  const renderMeta = (entry: HistoryEntry) => {
    const parts = [formatWhen(entry.id), formatDuration(entry.durationMs), entry.model];
    if (entry.app) parts.push(entry.app);
    if (entry.edit) parts.push(t("history_edit").replace("{instruction}", entry.edit));
    meta.textContent = parts.join(" \u00b7 ");
  };
  renderMeta(e);

  const actions = document.createElement("div");
  actions.className = "history-actions";
  actions.appendChild(
    smallButton(t("history_copy"), async (b) => {
      await invoke("copy_text", { text: text.textContent ?? "" });
      b.textContent = t("history_copied");
      setTimeout(() => (b.textContent = t("history_copy")), 1200);
    }),
  );
  if (e.raw) {
    let showingRaw = false;
    actions.appendChild(
      smallButton(t("history_original"), (b) => {
        showingRaw = !showingRaw;
        text.textContent = showingRaw ? e.raw! : e.text;
        b.textContent = showingRaw ? t("history_ai_version") : t("history_original");
      }),
    );
  }
  if (e.hasAudio) {
    actions.appendChild(
      smallButton(t("history_play"), async (b) => {
        const wasThis = playing?.btn === b;
        stopPlayback();
        if (wasThis) return;
        try {
          const bytes = await invoke<ArrayBuffer>("history_audio", { id: e.id });
          const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
          const audio = new Audio(url);
          playing = { audio, url, btn: b };
          b.textContent = t("history_stop");
          audio.addEventListener("ended", stopPlayback);
          await audio.play();
        } catch (err) {
          console.error("playback failed:", err);
          stopPlayback();
        }
      }),
    );
    const rerun = smallButton(t("history_rerun"), async (b) => {
      b.disabled = true;
      b.textContent = t("history_rerunning");
      try {
        const updated = await invoke<HistoryEntry>("history_rerun", { id: e.id });
        if (playing && item.contains(playing.btn)) stopPlayback();
        item.replaceWith(renderHistoryEntry(updated));
        return;
      } catch (err) {
        console.error("history_rerun failed:", err);
        b.textContent = t("history_rerun_failed");
        setTimeout(() => (b.textContent = t("history_rerun")), 2500);
      } finally {
        b.disabled = false;
      }
    });
    rerun.title = t("history_rerun_title");
    // An edit's recording is the instruction; re-running it as a dictation
    // would replace the edited text with it.
    if (!e.edit) actions.appendChild(rerun);
  }
  actions.appendChild(
    smallButton(t("history_delete"), async () => {
      if (playing && item.contains(playing.btn)) stopPlayback();
      await invoke("history_delete", { id: e.id });
      item.remove();
      await refreshHistory();
    }),
  );

  footer.append(meta, actions);
  item.append(text, footer);
  return item;
}

async function refreshHistory() {
  const entries = await invoke<HistoryEntry[]>("history_list");
  stopPlayback();
  historyList.innerHTML = "";
  for (const e of entries) historyList.appendChild(renderHistoryEntry(e));

  const off = historyModeSelect.value === "off";
  historyEmpty.textContent = off ? t("history_off") : t("history_empty");
  historyEmpty.classList.toggle("hidden", entries.length > 0 && !off);
  historyCount.textContent =
    entries.length === 1 ? t("history_count_one") : t("history_count").replace("{n}", String(entries.length));
  historyClear.classList.toggle("hidden", entries.length === 0);
  resetClearButton();
}

let clearArmed: number | undefined;
function resetClearButton() {
  window.clearTimeout(clearArmed);
  clearArmed = undefined;
  historyClear.classList.remove("armed");
  historyClear.textContent = t("history_clear");
}

historyClear.addEventListener("click", async () => {
  if (clearArmed === undefined) {
    historyClear.classList.add("armed");
    historyClear.textContent = t("history_clear_confirm");
    clearArmed = window.setTimeout(resetClearButton, 3000);
    return;
  }
  await invoke("history_clear");
  await refreshHistory();
});

listen("history-updated", () => refreshHistory());

// Credit link -> opens 0ggi.ch in default browser
document.getElementById("credit-link")?.addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    await openExternal("https://0ggi.ch");
  } catch (err) {
    console.error("Failed to open URL:", err);
  }
});

initAiSettings({ settings: () => currentSettings, save: saveSettings, changed: renderStatus });
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
  .catch((err) => console.error("the status did not start:", err))
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
