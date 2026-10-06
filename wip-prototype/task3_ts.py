# -*- coding: utf-8 -*-
# Task 3's edits to the existing TypeScript, as exact replacements.
import io, sys

APP = sys.argv[1]


def edit(path, pairs):
    p = APP + "/" + path
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old[:70], s.count(old))
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)


edit(
    "src/main.ts",
    [
        (
            'import { mountBoard } from "./soundboard/board";\n',
            'import { mountBoard } from "./soundboard/board";\n'
            'import { currentRoute, go, initShell, onRoute, startOn } from "./shell";\n'
            'import { setDownload } from "./activity";\n'
            'import { currentSpeech, initStatus, onStatus, renderStatus } from "./status-view";\n'
            'import { setup } from "./setup.ts";\n',
        ),
        (
            "// DOM elements\n"
            'const statusDot = document.getElementById("status-dot")!;\n'
            'const statusText = document.getElementById("status-text")!;\n',
            "// DOM elements\n",
        ),
        ('const soundboardSection = document.getElementById("section-soundboard")!;\n', ""),
        (
            "// Section navigation\n"
            'const navItems = document.querySelectorAll(".nav-item");\n'
            'const sections = document.querySelectorAll(".content-section");\n'
            "\n"
            "function showSection(target: string) {\n"
            '  navItems.forEach((n) => n.classList.toggle("active", n.getAttribute("data-section") === target));\n'
            '  sections.forEach((s) => s.classList.remove("active"));\n'
            "  document.getElementById(`section-${target}`)?.classList.add(\"active\");\n"
            '  soundboard.setActive(target === "soundboard");\n'
            '  if (target === "meetings") void renderMeetings();\n'
            '  if (target === "engine") void renderUnusedModels();\n'
            "}\n"
            "\n"
            "navItems.forEach((item) => {\n"
            '  item.addEventListener("click", () => showSection(item.getAttribute("data-section") ?? "general"));\n'
            "});\n",
            "// Sections and Settings tabs (src/shell.ts); what a page needs when it is shown.\n"
            "initShell();\n"
            "onRoute((now) => {\n"
            '  soundboard.setActive(now.section === "soundboard");\n'
            '  if (now.section === "meetings") void renderMeetings();\n'
            '  if (now.section === "settings" && now.tab === "models") void renderUnusedModels();\n'
            "});\n",
        ),
        (
            "let currentSettings: Settings;\nlet mics: MicDevice[] = [];\n",
            "let currentSettings: Settings;\nlet mics: MicDevice[] = [];\n"
            "/** The microphones were listed (an empty list is then no microphone). */\n"
            "let micsListed = false;\n",
        ),
        (
            '  mics = await invoke<MicDevice[]>("list_microphones");\n  renderMicOptions();\n',
            '  mics = await invoke<MicDevice[]>("list_microphones");\n  micsListed = true;\n  renderMicOptions();\n',
        ),
        (
            "  downloadProgress.classList.remove(\"hidden\");\n  progressFill.style.width = \"0%\";\n  try {\n",
            "  downloadProgress.classList.remove(\"hidden\");\n  progressFill.style.width = \"0%\";\n  setDownload(\"speech\", 0);\n  try {\n",
        ),
        (
            "  } finally {\n    downloadProgress.classList.add(\"hidden\");\n    modelSelect.disabled = false;\n    downloadInFlight = false;\n",
            "  } finally {\n    setDownload(\"speech\", null);\n    downloadProgress.classList.add(\"hidden\");\n    modelSelect.disabled = false;\n    downloadInFlight = false;\n",
        ),
        (
            "  renderDictionary();\n  renderFiles();\n  void soundboard.refresh();\n  void renderMeetings();\n});\n",
            "  renderDictionary();\n  renderFiles();\n  void soundboard.refresh();\n  void renderMeetings();\n  renderStatus();\n});\n",
        ),
        (
            "// Listen for recording state changes\n"
            'let prevRecordingState = "Ready";\n'
            'listen<string>("recording-state", (event) => {\n'
            "  const state = event.payload;\n"
            '  statusDot.className = "";\n'
            '  statusText.removeAttribute("data-i18n");\n'
            '  if (state === "Recording") {\n'
            '    statusDot.classList.add("recording");\n'
            '    statusText.setAttribute("data-i18n", "status_recording");\n'
            '    statusText.textContent = t("status_recording");\n'
            '    if (prevRecordingState !== "Recording") playStart();\n'
            '  } else if (state === "Transcribing") {\n'
            '    statusDot.classList.add("transcribing");\n'
            '    statusText.setAttribute("data-i18n", "status_transcribing");\n'
            '    statusText.textContent = t("status_transcribing");\n'
            '    if (prevRecordingState === "Recording") playStop();\n'
            "  } else {\n"
            '    statusDot.classList.add("ready");\n'
            '    statusText.setAttribute("data-i18n", "status_ready");\n'
            '    statusText.textContent = t("status_ready");\n'
            "    // Recording -> Ready (no Transcribing in between) means cancel/discard\n"
            '    if (prevRecordingState === "Recording") playDiscard();\n'
            "  }\n"
            "  prevRecordingState = state;\n"
            "});\n"
            "\n"
            "// Listen for download progress\n"
            'listen<DownloadProgress>("download-progress", (event) => {\n'
            "  const { percent } = event.payload;\n"
            "  progressFill.style.width = `${percent}%`;\n"
            "});\n",
            "// The start, stop and discard sounds of a dictation (the status itself is\n"
            "// src/status-view.ts).\n"
            'let prevRecordingState = "Ready";\n'
            'listen<string>("recording-state", (event) => {\n'
            "  const state = event.payload;\n"
            '  if (state === "Recording") {\n'
            '    if (prevRecordingState !== "Recording") playStart();\n'
            '  } else if (state === "Transcribing") {\n'
            '    if (prevRecordingState === "Recording") playStop();\n'
            "  } else {\n"
            "    // Recording -> Ready (no Transcribing in between) means cancel/discard\n"
            '    if (prevRecordingState === "Recording") playDiscard();\n'
            "  }\n"
            "  prevRecordingState = state;\n"
            "});\n"
            "\n"
            "// Listen for download progress\n"
            'listen<DownloadProgress>("download-progress", (event) => {\n'
            "  const { percent } = event.payload;\n"
            "  progressFill.style.width = `${percent}%`;\n"
            '  if (downloadInFlight) setDownload("speech", percent);\n'
            "});\n",
        ),
        (
            "initAiSettings({ settings: () => currentSettings, save: saveSettings });\n",
            "initAiSettings({ settings: () => currentSettings, save: saveSettings, changed: renderStatus });\n",
        ),
        (
            '  showSection: () => showSection("files"),\n  acceptsDrops: () => !soundboardSection.classList.contains("active"),\n',
            '  showSection: () => go("files"),\n  acceptsDrops: () => currentRoute().section !== "soundboard",\n',
        ),
        ('      showSection: () => showSection("meetings"),\n', '      showSection: () => go("meetings"),\n'),
        (
            "// Initialize\ngetVersion()\n",
            "// Home is where the window opens while the setup is not done: decided once,\n"
            "// when the first status is known.\n"
            "let startDecided = false;\n"
            "onStatus(() => {\n"
            "  const speech = currentSpeech();\n"
            "  if (startDecided || !speech || !micsListed) return;\n"
            "  startDecided = true;\n"
            "  startOn(setup({ speech, microphones: mics.length, aiDownloaded: true, aiDismissed: true }).needed);\n"
            "});\n"
            "\n"
            "// Initialize\ngetVersion()\n",
        ),
        (
            "loadSettings()\n  .catch((err) => console.error(\"loading the settings failed:\", err))\n  .then(() =>\n",
            "loadSettings()\n  .catch((err) => console.error(\"loading the settings failed:\", err))\n"
            "  .then(() => initStatus({ microphones: () => (micsListed ? mics.length : null), ai: aiActivity }))\n"
            "  .catch((err) => console.error(\"the status did not start:\", err))\n"
            "  .then(() =>\n",
        ),
        (
            'import { initAiSettings, renderAiSettings, type AppRule } from "./ai-settings";\n',
            'import { aiActivity, initAiSettings, renderAiSettings, type AppRule } from "./ai-settings";\n',
        ),
    ],
)

edit(
    "src/ai-settings.ts",
    [
        (
            'import { populateLanguageSelect } from "./languages";\n',
            'import { populateLanguageSelect } from "./languages";\nimport { onRoute } from "./shell";\nimport { setDownload } from "./activity";\n',
        ),
        (
            "export interface AiSettingsHost {\n  settings(): AiFields;\n  save(): Promise<void>;\n}\n",
            "export interface AiSettingsHost {\n  settings(): AiFields;\n  save(): Promise<void>;\n"
            "  /** The AI's state was read again (for the status and Home). */\n  changed?(): void;\n}\n",
        ),
        (
            "function gb(bytes: number): string {\n",
            "/** For the status: AI cleanup is on and its model is loading, or was unloaded to free the GPU. */\n"
            "export function aiActivity(): { loading: boolean; freed: boolean } {\n"
            "  if (!status || !host?.settings().aiCleanup || !selectedModel()?.downloaded) return { loading: false, freed: false };\n"
            '  return { loading: status.server.state === "loading", freed: status.gpuFreed && status.server.state === "stopped" };\n'
            "}\n"
            "\n"
            "function gb(bytes: number): string {\n",
        ),
        (
            "  renderModels();\n  renderStatus();\n}\n",
            "  renderModels();\n  renderStatus();\n  if (status.downloading === null) setDownload(\"ai\", null);\n  host.changed?.();\n}\n",
        ),
        (
            "  statusLine.textContent = t(\"ai_status_downloading\");\n  statusLine.dataset.tone = \"\";\n  try {\n",
            "  statusLine.textContent = t(\"ai_status_downloading\");\n  statusLine.dataset.tone = \"\";\n  setDownload(\"ai\", 0);\n  try {\n",
        ),
        (
            "    statusLine.dataset.tone = \"error\";\n  }\n  await refreshStatus();\n}\n",
            "    statusLine.dataset.tone = \"error\";\n  }\n  setDownload(\"ai\", null);\n  await refreshStatus();\n}\n",
        ),
        (
            "  document.querySelector('.nav-item[data-section=\"ai\"]')?.addEventListener(\"click\", () => {\n"
            "    refreshStatus();\n"
            "    refreshOpenApps();\n"
            "  });\n",
            "  // The AI tab is shown: its state and the open apps may have changed.\n"
            "  onRoute((now) => {\n"
            '    if (now.section !== "settings" || now.tab !== "ai") return;\n'
            "    refreshStatus();\n"
            "    refreshOpenApps();\n"
            "  });\n",
        ),
        (
            "    progressFill.style.width = `${percent}%`;\n    progressText.textContent = total ? `${gb(downloaded)} / ${gb(total)} GB` : \"\";\n",
            "    progressFill.style.width = `${percent}%`;\n    progressText.textContent = total ? `${gb(downloaded)} / ${gb(total)} GB` : \"\";\n    setDownload(\"ai\", percent);\n",
        ),
    ],
)

edit(
    "src/files.ts",
    [
        (
            'import { populateLanguageSelect } from "./languages";\n',
            'import { populateLanguageSelect } from "./languages";\nimport { setDownload, setFileRunning } from "./activity";\n',
        ),
        (
            "      speakersHint.textContent = t(\"files_speakers_download_failed\");\n      return false;\n    } finally {\n      modelDownload = null;\n",
            "      speakersHint.textContent = t(\"files_speakers_download_failed\");\n      return false;\n    } finally {\n      setDownload(\"speaker\", null);\n      modelDownload = null;\n",
        ),
        (
            "  running = true;\n  cancelRequested = false;\n",
            "  running = true;\n  setFileRunning(true);\n  cancelRequested = false;\n",
        ),
        (
            "  } finally {\n    running = false;\n    cancelBtn.classList.add(\"hidden\");\n",
            "  } finally {\n    running = false;\n    setFileRunning(false);\n    cancelBtn.classList.add(\"hidden\");\n",
        ),
        (
            "    speakersHint.textContent = t(\"files_speakers_downloading\").replace(\"{percent}\", String(Math.round(e.payload.percent)));\n",
            "    speakersHint.textContent = t(\"files_speakers_downloading\").replace(\"{percent}\", String(Math.round(e.payload.percent)));\n"
            "    if (modelDownload) setDownload(\"speaker\", e.payload.percent);\n",
        ),
    ],
)

EN_NEW = '''  status_ready: "Ready",
  status_recording: "Recording…",
  status_transcribing: "Transcribing…",
  status_setup_microphone: "No microphone found",
  status_setup_model: "No speech model yet",
  status_setup_key: "Groq key missing",
  status_setup_load: "Speech model did not load",
  status_downloading: "Downloading {n} %",
  status_meeting: "Meeting recording",
  status_file: "Transcribing a file",
  status_loading: "Loading models…",
  status_game: "Freed for a game",
  status_freed: "GPU freed",
  status_marker_meeting: "A meeting is recording",
  status_marker_file: "A file is being transcribed",
  nav_label: "Sections",
  nav_home: "Home",
  nav_settings: "Settings",
  settings_title: "Settings",
  tab_dictation: "Dictation",
  tab_ai: "AI cleanup",
  tab_dictionary: "Dictionary",
  tab_models: "Models & GPU",
  tab_general: "General",
  home_title_ready: "Ready to dictate",
  home_title_setup: "Setup needed",
  home_title_loading: "Getting ready…",
'''
DE_NEW = '''  status_ready: "Bereit",
  status_recording: "Aufnahme…",
  status_transcribing: "Transkription…",
  status_setup_microphone: "Kein Mikrofon gefunden",
  status_setup_model: "Noch kein Sprachmodell",
  status_setup_key: "Groq-Schlüssel fehlt",
  status_setup_load: "Sprachmodell lädt nicht",
  status_downloading: "Download {n} %",
  status_meeting: "Meeting läuft",
  status_file: "Datei wird transkribiert",
  status_loading: "Modelle werden geladen…",
  status_game: "Für ein Spiel freigegeben",
  status_freed: "GPU freigegeben",
  status_marker_meeting: "Ein Meeting wird aufgenommen",
  status_marker_file: "Eine Datei wird transkribiert",
  nav_label: "Bereiche",
  nav_home: "Start",
  nav_settings: "Einstellungen",
  settings_title: "Einstellungen",
  tab_dictation: "Diktieren",
  tab_ai: "KI-Korrektur",
  tab_dictionary: "Wörterbuch",
  tab_models: "Modelle & GPU",
  tab_general: "Allgemein",
  home_title_ready: "Bereit zum Diktieren",
  home_title_setup: "Einrichtung nötig",
  home_title_loading: "Wird vorbereitet…",
'''

edit(
    "src/i18n.ts",
    [
        (
            '  status_ready: "Ready",\n  status_recording: "Recording...",\n  status_transcribing: "Transcribing...",\n  nav_general: "General",\n  nav_engine: "Engine",\n  nav_recording: "Recording",\n  general_title: "General",\n  general_desc: "Configure your audio input device and interface",\n',
            EN_NEW,
        ),
        (
            '  status_ready: "Bereit",\n  status_recording: "Aufnahme...",\n  status_transcribing: "Transkription...",\n  nav_general: "Allgemein",\n  nav_engine: "Engine",\n  nav_recording: "Aufnahme",\n  general_title: "Allgemein",\n  general_desc: "Audio-Eingabegerät und Oberfläche konfigurieren",\n',
            DE_NEW,
        ),
        ('  engine_title: "Engine",\n  engine_desc: "Choose your transcription backend",\n', ""),
        ('  engine_title: "Engine",\n  engine_desc: "Transkriptions-Backend auswählen",\n', ""),
        ('  recording_title: "Recording",\n  recording_desc: "Configure how you trigger transcription",\n', ""),
        ('  recording_title: "Aufnahme",\n  recording_desc: "Auslösung der Transkription konfigurieren",\n', ""),
        ('  nav_ai: "AI cleanup",\n  ai_title: "AI cleanup",\n', ""),
        ('  nav_ai: "KI-Korrektur",\n  ai_title: "KI-Korrektur",\n', ""),
        ('  nav_dictionary: "Dictionary",\n  dictionary_title: "Dictionary",\n', ""),
        ('  nav_dictionary: "Wörterbuch",\n  dictionary_title: "Wörterbuch",\n', ""),
        ('  nav_replacements: "Replacements",\n  nav_history: "History",\n', ""),
        ('  nav_replacements: "Ersetzungen",\n  nav_history: "Verlauf",\n', ""),
        ('  history_title: "History",\n  history_desc: "Your recent dictations. Stored only on this computer.",\n', ""),
        ('  history_title: "Verlauf",\n  history_desc: "Deine letzten Diktate. Nur auf diesem Computer gespeichert.",\n', ""),
        (
            '  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {\n',
            '  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {\n'
            '    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label")!));\n'
            "  });\n"
            '  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {\n',
        ),
    ],
)
print("ok")
