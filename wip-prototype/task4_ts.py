# -*- coding: utf-8 -*-
# Tasks 4 and 5 on the scratch app (after task3): Home with its hotkeys,
# quick switches, loaded card, add word and recent dictations; the first run.
import io, sys

APP = sys.argv[1]
HOME_HTML = sys.argv[2]


def read(path):
    return io.open(APP + "/" + path, encoding="utf-8").read()


def write(path, s):
    io.open(APP + "/" + path, "w", encoding="utf-8", newline="\n").write(s)


def edit(path, pairs):
    s = read(path)
    for old, new in pairs:
        assert s.count(old) == 1, (path, old[:70], s.count(old))
        s = s.replace(old, new)
    write(path, s)


def cut(path, start, end, new=""):
    """Replace everything from `start` up to and including `end`."""
    s = read(path)
    assert s.count(start) == 1 and s.count(end) >= 1, (path, start[:60], s.count(start), end[:60], s.count(end))
    a = s.index(start)
    b = s.index(end, a) + len(end)
    write(path, s[:a] + new + s[b:])


# ── index.html: the Home section ──────────────────────────────────────────
cut("index.html", '        <section id="section-home" class="content-section active">\n', "        </section>\n", io.open(HOME_HTML, encoding="utf-8").read())

# ── style.css: the page's styles ──────────────────────────────────────────
edit("src/style.css", [('@import "./styles/shell.css";\n', '@import "./styles/shell.css";\n@import "./styles/home.css";\n')])
# The older history rules: the list design replaces them.
cut("src/style.css", "/* \u2500\u2500 History \u2500", ".history-actions {\n  display: flex;\n  gap: 2px;\n  margin-right: -6px;\n}\n\n",
    "/* \u2500\u2500 History: the count and Clear history (Settings > General) \u2500\u2500 */\n\n.history-toolbar {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: var(--s4);\n  padding: var(--s3) 0;\n}\n\n")

# ── main.ts ───────────────────────────────────────────────────────────────
cut("src/main.ts", "interface HistoryEntry {\n", "  edit?: string | null;\n}\n\n")
cut("src/main.ts", 'const hotkeyText = document.getElementById("hotkey-text")!;\n', 'const pasteLastClear = document.getElementById("paste-last-clear") as HTMLButtonElement;\n')
cut("src/main.ts", 'const rewriteLastBtn = document.getElementById("rewrite-last-btn") as HTMLButtonElement;\n', 'const meetingHotkeyClear = document.getElementById("meeting-hotkey-clear") as HTMLButtonElement;\n')
cut("src/main.ts", 'const historyList = document.getElementById("history-list")!;\n', 'const historyClear = document.getElementById("history-clear") as HTMLButtonElement;\n')

HOTKEYS = '''type HotkeyTarget = "dictation" | "pasteLast" | "rewriteLast" | "freeGpu" | "meeting";

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
    view.text.textContent = unset ? t("home_key_unset") : hotkeyLabel(combo);
    view.btn.classList.toggle("key-unset", unset);
    view.clear?.classList.toggle("hidden", !combo);
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

'''
cut("src/main.ts", 'type HotkeyTarget = "dictation" | "pasteLast" | "rewriteLast" | "freeGpu" | "meeting";\n',
    '    console.error("clearing the meeting hotkey failed:", err);\n  }\n  renderHotkeys();\n});\n\n', HOTKEYS)
cut("src/main.ts", "// \u2500\u2500 History \u2500", 'listen("history-updated", () => refreshHistory());\n\n')

edit(
    "src/main.ts",
    [
        (
            'import { aiActivity, initAiSettings, renderAiSettings, type AppRule } from "./ai-settings";\nimport { initDictionary, renderDictionary } from "./dictionary";\n',
            'import { aiActivity, aiModelInfo, aiSummary, initAiSettings, renderAiSettings, setUpAi, type AppRule } from "./ai-settings";\n'
            'import { addWords, initDictionary, renderDictionary } from "./dictionary";\n'
            'import { initHistory, refreshHistory } from "./history";\n'
            'import { initHome, renderHome } from "./home";\n',
        ),
        (
            "onRoute((now) => {\n  soundboard.setActive(now.section === \"soundboard\");\n",
            "onRoute((now) => {\n  // Home's setup listens to the microphone only while it is on screen.\n  renderHome();\n  soundboard.setActive(now.section === \"soundboard\");\n",
        ),
        (
            "  mics = await invoke<MicDevice[]>(\"list_microphones\");\n  micsListed = true;\n  renderMicOptions();\n",
            "  await listMicrophones();\n",
        ),
        (
            "async function loadSettings() {\n",
            "/** The microphones Windows has now; the dropdown and the status follow. */\n"
            "async function listMicrophones() {\n"
            "  mics = await invoke<MicDevice[]>(\"list_microphones\");\n"
            "  micsListed = true;\n"
            "  renderMicOptions();\n"
            "  renderStatus();\n"
            "}\n"
            "// A microphone plugged in while the window was away (the first run waits for one).\n"
            "window.addEventListener(\"focus\", () => void listMicrophones().catch(console.error));\n"
            "\n"
            "async function loadSettings() {\n",
        ),
        (
            "function setRecordingMode(mode: string) {\n  currentSettings.recordingMode = mode;\n  modeToggle.classList.toggle(\"active\", mode === \"toggle\");\n  modePtt.classList.toggle(\"active\", mode === \"push-to-talk\");\n}\n",
            "function setRecordingMode(mode: string) {\n  currentSettings.recordingMode = mode;\n  modeToggle.classList.toggle(\"active\", mode === \"toggle\");\n  modePtt.classList.toggle(\"active\", mode === \"push-to-talk\");\n  // Home says how to dictate: \"Hold …\" or \"Press …\".\n  renderHome();\n}\n",
        ),
        ("micSelect.addEventListener(\"change\", () => saveSettings());\n", "micSelect.addEventListener(\"change\", async () => {\n  await saveSettings();\n  renderHome();\n});\n"),
        (
            "initAiSettings({ settings: () => currentSettings, save: saveSettings, changed: renderStatus });\n",
            "// The AI's state is part of the status, and Home shows both.\n"
            "initAiSettings({ settings: () => currentSettings, save: saveSettings, changed: renderStatus });\n"
            "initHistory({ mode: () => historyModeSelect.value });\n",
        ),
        (
            "  startOn(setup({ speech, microphones: mics.length, aiDownloaded: true, aiDismissed: true }).needed);\n});\n",
            "  startOn(setup({ speech, microphones: mics.length, aiDownloaded: true, aiDismissed: true }).needed);\n});\n"
            "\n"
            "function startHome() {\n"
            "  initHome({\n"
            "    recordingMode: () => currentSettings.recordingMode,\n"
            "    dictationKey: () => hotkeyLabel(currentSettings.hotkey),\n"
            "    microphones: () => (micsListed ? mics.length : null),\n"
            "    ai: aiSummary,\n"
            "    aiModel: aiModelInfo,\n"
            "    addWords,\n"
            "    setUpAi,\n"
            "  });\n"
            "}\n",
        ),
        (
            "  .then(() => initStatus({ microphones: () => (micsListed ? mics.length : null), ai: aiActivity }))\n  .catch((err) => console.error(\"the status did not start:\", err))\n",
            "  .then(() => initStatus({ microphones: () => (micsListed ? mics.length : null), ai: aiActivity }))\n  .then(startHome)\n  .catch((err) => console.error(\"the status or Home did not start:\", err))\n",
        ),
    ],
)

# ── dictionary.ts: "add a word" from Home ─────────────────────────────────
edit(
    "src/dictionary.ts",
    [
        (
            "/// Adds the new entries of `text`; returns how many were new.\nasync function add(text: string): Promise<number> {\n",
            "/// Adds the new entries of `text`; returns how many were new. Also Home's \"Add a word\".\nexport async function addWords(text: string): Promise<number> {\n",
        ),
        ("  if (!dismiss) await add(word);\n", "  if (!dismiss) await addWords(word);\n"),
        ("    const added = await add(entries.join(\"\\n\"));\n", "    const added = await addWords(entries.join(\"\\n\"));\n"),
        ("    await add(input.value);\n    input.value = \"\";\n    input.focus();\n", "    await addWords(input.value);\n    input.value = \"\";\n    input.focus();\n"),
        ("    e.preventDefault();\n    await add(text);\n    input.value = \"\";\n", "    e.preventDefault();\n    await addWords(text);\n    input.value = \"\";\n"),
    ],
)

# ── ai-settings.ts: what Home shows and sets up ───────────────────────────
edit(
    "src/ai-settings.ts",
    [
        (
            "function gb(bytes: number): string {\n",
            "/** For Home: the AI model in use, the state line as it reads in Settings, and whether the model is downloaded. */\n"
            "export function aiSummary(): { name: string; state: string; tone: string; downloaded: boolean } {\n"
            "  const model = selectedModel();\n"
            "  return { name: model?.label ?? \"\", state: statusLine.textContent ?? \"\", tone: statusLine.dataset.tone ?? \"\", downloaded: !!model?.downloaded };\n"
            "}\n"
            "\n"
            "/** An AI model's name and size, for the setup's suggestion. */\n"
            "export function aiModelInfo(id: string): { name: string; bytes: number } | null {\n"
            "  const model = status?.models.find((m) => m.id === id);\n"
            "  return model ? { name: model.label, bytes: model.bytes } : null;\n"
            "}\n"
            "\n"
            "/** Home's setup card: choose this model, download it and turn AI cleanup on. True when it is on. */\n"
            "export async function setUpAi(id: string): Promise<boolean> {\n"
            "  if (host.settings().aiModel !== id && status?.models.some((m) => m.id === id)) {\n"
            "    host.settings().aiModel = id;\n"
            "    await host.save();\n"
            "    await refreshStatus();\n"
            "  }\n"
            "  if (!selectedModel()?.downloaded) await download();\n"
            "  if (!selectedModel()?.downloaded || !status?.installed) return false;\n"
            "  host.settings().aiCleanup = true;\n"
            "  toggle.checked = true;\n"
            "  renderOutputSkip();\n"
            "  await host.save();\n"
            "  await refreshStatus();\n"
            "  return true;\n"
            "}\n"
            "\n"
            "function gb(bytes: number): string {\n",
        ),
    ],
)
print("ok")
