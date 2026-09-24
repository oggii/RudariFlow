import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { setLang, getLang, detectDefaultLang, t } from "./i18n";
import { populateLanguageSelect } from "./languages";
import { initAiSettings, renderAiSettings, type AppRule } from "./ai-settings";
import { initDictionary, renderDictionary } from "./dictionary";
import { playStart, playStop, playDiscard, setVolume } from "./sounds";

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
  rewriteLastHotkey: string;
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
const statusDot = document.getElementById("status-dot")!;
const statusText = document.getElementById("status-text")!;
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
const rewriteLastBtn = document.getElementById("rewrite-last-btn") as HTMLButtonElement;
const rewriteLastText = document.getElementById("rewrite-last-text")!;
const rewriteLastClear = document.getElementById("rewrite-last-clear") as HTMLButtonElement;
const sendCommandSelect = document.getElementById("send-command-select") as HTMLSelectElement;
const muteAudioToggle = document.getElementById("mute-audio-toggle") as HTMLInputElement;
const replacementList = document.getElementById("replacement-list")!;
const replacementEmpty = document.getElementById("replacement-empty")!;
const replacementAdd = document.getElementById("replacement-add") as HTMLButtonElement;
const historyModeSelect = document.getElementById("history-mode-select") as HTMLSelectElement;
const historyList = document.getElementById("history-list")!;
const historyEmpty = document.getElementById("history-empty")!;
const historyCount = document.getElementById("history-count")!;
const historyClear = document.getElementById("history-clear") as HTMLButtonElement;

// Section navigation
const navItems = document.querySelectorAll(".nav-item");
const sections = document.querySelectorAll(".content-section");

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.getAttribute("data-section");
    navItems.forEach((n) => n.classList.remove("active"));
    sections.forEach((s) => s.classList.remove("active"));
    item.classList.add("active");
    document.getElementById(`section-${target}`)?.classList.add("active");
  });
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
  appWindow.startDragging();
});

let currentSettings: Settings;
let mics: MicDevice[] = [];

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
  renderDictionary();

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

uiLanguageSelect.addEventListener("change", async () => {
  setLang(uiLanguageSelect.value);
  populateLanguageSelect(languageSelect, getLang(), t("language_auto"));
  renderMicOptions();
  renderHotkeys();
  await saveSettings();
  await refreshHistory();
  await renderAiSettings();
  renderDictionary();
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
    return;
  }
  // Missing -> auto-download. Don't persist until success.
  const ok = await downloadCurrentModel();
  if (ok) {
    await saveSettings();
    lastSavedModel = chosen;
    await refreshModelStatusUI();
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

// Listen for recording state changes
let prevRecordingState = "Ready";
listen<string>("recording-state", (event) => {
  const state = event.payload;
  statusDot.className = "";
  statusText.removeAttribute("data-i18n");
  if (state === "Recording") {
    statusDot.classList.add("recording");
    statusText.setAttribute("data-i18n", "status_recording");
    statusText.textContent = t("status_recording");
    if (prevRecordingState !== "Recording") playStart();
  } else if (state === "Transcribing") {
    statusDot.classList.add("transcribing");
    statusText.setAttribute("data-i18n", "status_transcribing");
    statusText.textContent = t("status_transcribing");
    if (prevRecordingState === "Recording") playStop();
  } else {
    statusDot.classList.add("ready");
    statusText.setAttribute("data-i18n", "status_ready");
    statusText.textContent = t("status_ready");
    // Recording -> Ready (no Transcribing in between) means cancel/discard
    if (prevRecordingState === "Recording") playDiscard();
  }
  prevRecordingState = state;
});

// Listen for download progress
listen<DownloadProgress>("download-progress", (event) => {
  const { percent } = event.payload;
  progressFill.style.width = `${percent}%`;
});

// Hotkey capture. "dictation" starts/stops recording (keyboard or mouse side
// button), "pasteLast" pastes the last transcript again, "rewriteLast"
// selects it and records an edit (both keyboard only).
type HotkeyTarget = "dictation" | "pasteLast" | "rewriteLast";
let capturing: HotkeyTarget | null = null;

function hotkeyLabel(combo: string): string {
  if (!combo) return t("hotkey_none");
  const isMac = navigator.userAgent.includes("Mac");
  return combo
    .replace("CmdOrCtrl", isMac ? "Cmd" : "Ctrl")
    .replace("Mouse4", t("hotkey_mouse4"))
    .replace("Mouse5", t("hotkey_mouse5"));
}

function renderHotkeys() {
  hotkeyText.textContent = hotkeyLabel(currentSettings.hotkey);
  pasteLastText.textContent = hotkeyLabel(currentSettings.pasteLastHotkey);
  pasteLastClear.classList.toggle("hidden", !currentSettings.pasteLastHotkey);
  rewriteLastText.textContent = hotkeyLabel(currentSettings.rewriteLastHotkey);
  rewriteLastClear.classList.toggle("hidden", !currentSettings.rewriteLastHotkey);
}

function captureElements(target: HotkeyTarget) {
  if (target === "dictation") return { btn: hotkeyBtn, text: hotkeyText };
  if (target === "pasteLast") return { btn: pasteLastBtn, text: pasteLastText };
  return { btn: rewriteLastBtn, text: rewriteLastText };
}

function modifierTokens(e: KeyboardEvent | MouseEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("CmdOrCtrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return mods;
}

/// Mouse side buttons: MouseEvent.button 3 = back (XBUTTON1), 4 = forward
/// (XBUTTON2). They work alone or with modifiers.
function mouseEventToCombo(e: MouseEvent): string | null {
  const button = e.button === 3 ? "Mouse4" : e.button === 4 ? "Mouse5" : null;
  return button ? [...modifierTokens(e), button].join("+") : null;
}

function keyEventToCombo(e: KeyboardEvent): string | null {
  const mods = modifierTokens(e);
  // Ignore lone modifier keys
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(k)) return null;
  if (mods.length === 0) return null;
  // Normalize key name to Tauri shortcut format
  let key = k;
  if (key === " ") key = "Space";
  else if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  // Digits and punctuation: e.key changes with Shift ("!" instead of "1")
  // and with the layout (umlauts), so use the physical code (Digit1, Minus).
  else if (key.length === 1) key = e.code;
  // Function keys, arrows, etc. already match (F1, ArrowLeft, ...)
  return [...mods, key].join("+");
}

function startCapture(target: HotkeyTarget) {
  if (capturing) return;
  capturing = target;
  // Release the global hotkeys so pressing a current chord reaches this window.
  invoke("set_hotkey_paused", { paused: true }).catch(console.error);
  const { btn, text } = captureElements(target);
  btn.classList.add("capturing");
  text.textContent = t(target === "dictation" ? "hotkey_press_keys" : "hotkey_press_keys_keyboard");
  window.addEventListener("keydown", onCaptureKey, true);
  // Click outside cancels
  setTimeout(() => window.addEventListener("mousedown", onOutsideClick, true), 0);
}

function stopCapture() {
  if (capturing) captureElements(capturing).btn.classList.remove("capturing");
  capturing = null;
  window.removeEventListener("keydown", onCaptureKey, true);
  window.removeEventListener("mousedown", onOutsideClick, true);
  invoke("set_hotkey_paused", { paused: false }).catch(console.error);
  renderHotkeys();
}

async function onCaptureKey(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    stopCapture();
    return;
  }
  const combo = keyEventToCombo(e);
  if (!combo) return; // wait for a non-modifier key
  await applyCapturedCombo(combo);
}

async function applyCapturedCombo(combo: string) {
  const target = capturing;
  if (!target) return;
  window.removeEventListener("keydown", onCaptureKey, true);
  window.removeEventListener("mousedown", onOutsideClick, true);
  try {
    await setHotkey(target, combo);
    stopCapture();
  } catch (err) {
    captureElements(target).text.textContent = t("hotkey_invalid");
    console.error("change_hotkey failed:", err);
    setTimeout(stopCapture, 1500);
  }
}

async function setHotkey(target: HotkeyTarget, combo: string) {
  await invoke("change_hotkey", { target, newHotkey: combo });
  if (target === "dictation") currentSettings.hotkey = combo;
  else if (target === "pasteLast") currentSettings.pasteLastHotkey = combo;
  else currentSettings.rewriteLastHotkey = combo;
}

function onOutsideClick(e: MouseEvent) {
  if (!capturing) return;
  const combo = mouseEventToCombo(e);
  if (combo) {
    e.preventDefault();
    e.stopPropagation();
    if (capturing === "dictation") applyCapturedCombo(combo);
    else captureElements(capturing).text.textContent = t("hotkey_keyboard_only");
    return;
  }
  if (!captureElements(capturing).btn.contains(e.target as Node)) stopCapture();
}

// Side buttons would otherwise trigger history navigation in the webview.
window.addEventListener("mouseup", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});

hotkeyBtn.addEventListener("click", () => startCapture("dictation"));
pasteLastBtn.addEventListener("click", () => startCapture("pasteLast"));
rewriteLastBtn.addEventListener("click", () => startCapture("rewriteLast"));
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

initAiSettings({ settings: () => currentSettings, save: saveSettings });
initDictionary({ settings: () => currentSettings, save: saveSettings });

// Initialize
getVersion()
  .then((v) => (document.getElementById("version-text")!.textContent = `v${v}`))
  .catch(console.error);
loadSettings();
