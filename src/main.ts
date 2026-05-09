import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { setLang, detectDefaultLang, t } from "./i18n";
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
const customPromptTextarea = document.getElementById("custom-prompt") as HTMLTextAreaElement;
const customPromptRow = document.getElementById("custom-prompt-row")!;

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

async function loadSettings() {
  currentSettings = await invoke<Settings>("get_settings");

  // UI language: auto-detect on first launch (empty string), otherwise use saved
  if (!currentSettings.uiLanguage) {
    currentSettings.uiLanguage = detectDefaultLang();
    await invoke("save_settings", { settings: currentSettings });
  }
  uiLanguageSelect.value = currentSettings.uiLanguage;
  setLang(currentSettings.uiLanguage);

  // Volume
  volumeSlider.value = String(currentSettings.volume);
  setVolume(currentSettings.volume);

  // Autostart
  autostartToggle.checked = currentSettings.autostart;

  // Populate mic dropdown
  const mics = await invoke<MicDevice[]>("list_microphones");
  micSelect.innerHTML = "";
  mics.forEach((mic) => {
    const option = document.createElement("option");
    option.value = mic.name;
    option.textContent = mic.name + (mic.is_default ? " (default)" : "");
    micSelect.appendChild(option);
  });
  micSelect.value = currentSettings.microphone;

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

  // Groq key
  groqKey.value = currentSettings.groqApiKey;
  customPromptTextarea.value = currentSettings.customPrompt || "";

  // Recording mode
  setRecordingMode(currentSettings.recordingMode);

  // Hotkey
  hotkeyText.textContent = currentSettings.hotkey.replace("CmdOrCtrl", "Cmd");
}

function setEngine(engine: string) {
  currentSettings.engine = engine;
  engineLocal.classList.toggle("active", engine === "local");
  engineCloud.classList.toggle("active", engine === "cloud");
  localSettings.classList.toggle("hidden", engine !== "local");
  cloudSettings.classList.toggle("hidden", engine !== "cloud");
  // Custom vocab applies to both engines (whisper-cli's --prompt and Groq's prompt)
  customPromptRow.classList.remove("hidden");
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
  currentSettings.customPrompt = customPromptTextarea.value;
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

languageSelect.addEventListener("change", () => saveSettings());

gpuBackendSelect.addEventListener("change", () => saveSettings());

uiLanguageSelect.addEventListener("change", () => {
  setLang(uiLanguageSelect.value);
  saveSettings();
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
customPromptTextarea.addEventListener("change", () => saveSettings());

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

// Hotkey capture
let capturing = false;

function renderHotkey(combo: string) {
  hotkeyText.textContent = combo.replace("CmdOrCtrl", "Cmd");
}

function keyEventToCombo(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("CmdOrCtrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  // Ignore lone modifier keys
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(k)) return null;
  if (mods.length === 0) return null;
  // Normalize key name to Tauri shortcut format
  let key = k;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  // Function keys, arrows, etc. already match (F1, ArrowLeft, ...)
  return [...mods, key].join("+");
}

function startCapture() {
  if (capturing) return;
  capturing = true;
  hotkeyBtn.classList.add("capturing");
  hotkeyText.textContent = t("hotkey_press_keys");
  window.addEventListener("keydown", onCaptureKey, true);
  // Click outside cancels
  setTimeout(() => window.addEventListener("mousedown", onOutsideClick, true), 0);
}

function stopCapture() {
  capturing = false;
  hotkeyBtn.classList.remove("capturing");
  window.removeEventListener("keydown", onCaptureKey, true);
  window.removeEventListener("mousedown", onOutsideClick, true);
  renderHotkey(currentSettings.hotkey);
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
  try {
    await invoke("change_hotkey", { newHotkey: combo });
    currentSettings.hotkey = combo;
    stopCapture();
  } catch (err) {
    hotkeyText.textContent = t("hotkey_invalid");
    console.error("change_hotkey failed:", err);
    setTimeout(stopCapture, 1500);
  }
}

function onOutsideClick(e: MouseEvent) {
  if (!hotkeyBtn.contains(e.target as Node)) stopCapture();
}

hotkeyBtn.addEventListener("click", startCapture);

// Credit link -> opens 0ggi.ch in default browser
document.getElementById("credit-link")?.addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    await openExternal("https://0ggi.ch");
  } catch (err) {
    console.error("Failed to open URL:", err);
  }
});

// Initialize
loadSettings();
