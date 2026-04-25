type Translations = Record<string, string>;

const en: Translations = {
  status_ready: "Ready",
  status_recording: "Recording...",
  status_transcribing: "Transcribing...",
  nav_general: "General",
  nav_engine: "Engine",
  nav_recording: "Recording",
  general_title: "General",
  general_desc: "Configure your audio input device and interface",
  microphone_label: "Microphone",
  microphone_hint: "Select your preferred input device",
  ui_language_label: "Display Language",
  ui_language_hint: "Language used for the app interface",
  volume_label: "Notification Volume",
  volume_hint: "Soft sound when starting/stopping recording",
  autostart_label: "Start with computer",
  autostart_hint: "Launch RudariFlow automatically when you log in",
  engine_title: "Engine",
  engine_desc: "Choose your transcription backend",
  engine_label: "Transcription Engine",
  engine_hint: "Local runs on-device, Cloud requires an API key",
  engine_local: "Local Whisper",
  engine_cloud: "Groq Cloud",
  gpu_backend_label: "GPU Backend",
  gpu_backend_hint: "Auto picks NVIDIA CUDA when available, otherwise CPU",
  gpu_backend_auto: "Auto",
  gpu_backend_cuda: "NVIDIA CUDA",
  gpu_backend_cpu: "CPU only",
  language_label: "Language",
  language_hint: "Auto-detect or pick a preferred language",
  language_auto: "Auto-detect",
  model_label: "Model Size",
  model_hint: "Larger models are more accurate but use more resources",
  model_tiny: "Tiny (~75 MB) — fastest, lowest accuracy",
  model_base: "Base (~142 MB)",
  model_small: "Small (~466 MB) — recommended default",
  model_medium: "Medium (~1.5 GB)",
  model_large_v3: "Large v3 (~2.9 GB) — highest accuracy",
  model_large_v3_turbo: "Large v3 Turbo (~1.5 GB) — large quality, ~8x faster",
  download: "Download",
  retry: "Retry",
  groq_label: "Groq API Key",
  groq_hint: "Get your key from console.groq.com",
  recording_title: "Recording",
  recording_desc: "Configure how you trigger transcription",
  recording_mode_label: "Recording Mode",
  recording_mode_hint: "Toggle starts/stops, Push to Talk records while held",
  mode_toggle: "Toggle",
  mode_ptt: "Push to Talk",
  hotkey_label: "Hotkey",
  hotkey_hint: "Global keyboard shortcut to trigger recording",
  hotkey_press_keys: "Press a key combination…",
  hotkey_invalid: "Invalid combination, try again",
};

const de: Translations = {
  status_ready: "Bereit",
  status_recording: "Aufnahme...",
  status_transcribing: "Transkription...",
  nav_general: "Allgemein",
  nav_engine: "Engine",
  nav_recording: "Aufnahme",
  general_title: "Allgemein",
  general_desc: "Audio-Eingabegerät und Oberfläche konfigurieren",
  microphone_label: "Mikrofon",
  microphone_hint: "Bevorzugtes Eingabegerät auswählen",
  ui_language_label: "Anzeigesprache",
  ui_language_hint: "Sprache der Benutzeroberfläche",
  volume_label: "Benachrichtigungslautstärke",
  volume_hint: "Sanfter Ton beim Starten/Stoppen der Aufnahme",
  autostart_label: "Mit Computer starten",
  autostart_hint: "RudariFlow automatisch beim Anmelden starten",
  engine_title: "Engine",
  engine_desc: "Transkriptions-Backend auswählen",
  engine_label: "Transkriptions-Engine",
  engine_hint: "Lokal läuft auf dem Gerät, Cloud benötigt einen API-Schlüssel",
  engine_local: "Lokales Whisper",
  engine_cloud: "Groq Cloud",
  gpu_backend_label: "GPU-Backend",
  gpu_backend_hint: "Auto wählt NVIDIA CUDA, falls verfügbar, sonst CPU",
  gpu_backend_auto: "Automatisch",
  gpu_backend_cuda: "NVIDIA CUDA",
  gpu_backend_cpu: "Nur CPU",
  language_label: "Sprache",
  language_hint: "Automatische Erkennung oder bevorzugte Sprache wählen",
  language_auto: "Automatisch erkennen",
  model_label: "Modellgröße",
  model_hint: "Größere Modelle sind genauer, brauchen aber mehr Ressourcen",
  model_tiny: "Tiny (~75 MB) — am schnellsten, geringste Genauigkeit",
  model_base: "Base (~142 MB)",
  model_small: "Small (~466 MB) — empfohlener Standard",
  model_medium: "Medium (~1.5 GB)",
  model_large_v3: "Large v3 (~2.9 GB) — höchste Genauigkeit",
  model_large_v3_turbo: "Large v3 Turbo (~1.5 GB) — Large-Qualität, ~8× schneller",
  download: "Herunterladen",
  retry: "Wiederholen",
  groq_label: "Groq-API-Schlüssel",
  groq_hint: "Schlüssel von console.groq.com",
  recording_title: "Aufnahme",
  recording_desc: "Auslösung der Transkription konfigurieren",
  recording_mode_label: "Aufnahmemodus",
  recording_mode_hint: "Toggle startet/stoppt, Push-to-Talk nimmt beim Halten auf",
  mode_toggle: "Umschalten",
  mode_ptt: "Push-to-Talk",
  hotkey_label: "Tastenkürzel",
  hotkey_hint: "Globales Tastenkürzel zum Auslösen der Aufnahme",
  hotkey_press_keys: "Tastenkombination drücken…",
  hotkey_invalid: "Ungültige Kombination, erneut versuchen",
};

const dictionaries: Record<string, Translations> = { en, de };

let currentLang = "en";

export function detectDefaultLang(): string {
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith("de")) return "de";
  return "en";
}

export function setLang(lang: string) {
  if (!dictionaries[lang]) lang = "en";
  currentLang = lang;
  document.documentElement.setAttribute("lang", lang);
  applyTranslations();
}

export function t(key: string): string {
  return dictionaries[currentLang]?.[key] ?? dictionaries.en[key] ?? key;
}

function applyTranslations() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n")!;
    el.textContent = t(key);
  });
}
